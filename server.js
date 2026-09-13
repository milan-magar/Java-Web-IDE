'use strict';

const express    = require('express');
const cors       = require('cors');
const http       = require('http');
const path       = require('path');
const fs         = require('fs/promises');
const os         = require('os');
const crypto     = require('crypto');
const { execFile, spawn } = require('child_process');
const { WebSocketServer } = require('ws');

const PORT               = process.env.PORT || 3000;
const HOST               = process.env.HOST || '127.0.0.1';
const COMPILE_TIMEOUT_MS = 15_000;
const RUN_TIMEOUT_MS     = 30_000;
const ACK_TIMEOUT_MS     =  8_000;
const MAX_CODE_BYTES     = 512 * 1024;
const MAX_OUTPUT_BYTES   = 256 * 1024;
const MAX_ARGS           = 64;
const MAX_ARG_LEN        = 512;

const app = express();
app.use(cors());
app.use(express.json({ limit: '8mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const IDENT_RE   = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const FQN_RE     = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/;
const PACKAGE_RE = /\bpackage\s+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*;/;
const PUBLIC_RE  = /\bpublic\s+(?:final\s+|abstract\s+|sealed\s+|non-sealed\s+|strictfp\s+)*(?:class|interface|enum|record)\s+([A-Za-z_$][\w$]*)/;
const ANY_RE     = /\b(?:class|interface|enum|record)\s+([A-Za-z_$][\w$]*)/;

function stripNoise(code) {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""')
    .replace(/'(?:\\.|[^'\\\n])*'/g, "''");
}
function detectClassName(code) {
  const s = stripNoise(code);
  const pub = s.match(PUBLIC_RE);
  if (pub) return pub[1];
  const any = s.match(ANY_RE);
  return any ? any[1] : null;
}
function detectPackage(code) {
  const s = stripNoise(code);
  const m = s.match(PACKAGE_RE);
  return m ? m[1] : null;
}

function sanitizeArgs(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  for (const a of input) {
    if (typeof a !== 'string') continue;
    if (a.length === 0 || a.length > MAX_ARG_LEN) continue;
    out.push(a.replace(/\0/g, ''));
    if (out.length >= MAX_ARGS) break;
  }
  return out;
}

function runProcess(cmd, args, opts = {}) {
  return new Promise(resolve => {
    const child = execFile(cmd, args, {
      timeout:     opts.timeout || 15_000,
      maxBuffer:   MAX_OUTPUT_BYTES * 2,
      cwd:         opts.cwd,
      windowsHide: true,
      killSignal:  'SIGKILL',
      env:         { ...process.env }
    }, (err, stdout, stderr) => {
      const spawnError = !!(err && (err.code === 'ENOENT' || err.errno === -4058));
      resolve({
        code:       err && typeof err.code === 'number' ? err.code : (err ? 1 : 0),
        stdout:     stdout || '',
        stderr:     stderr || '',
        timedOut:   !!(err && err.killed),
        spawnError,
      });
    });
    if (child.stdin) child.stdin.end(opts.stdin != null ? opts.stdin : '');
  });
}

function truncate(str) {
  if (typeof str !== 'string') return '';
  if (Buffer.byteLength(str, 'utf8') <= MAX_OUTPUT_BYTES) return str;
  return str.slice(0, MAX_OUTPUT_BYTES) + '\n…[output truncated]';
}

async function collectClassFiles(dir, base) {
  const out = [];
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); }
  catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...await collectClassFiles(full, base));
    } else if (e.name.endsWith('.class')) {
      const buf = await fs.readFile(full);
      out.push({
        name: path.relative(base, full).split(path.sep).join('/'),
        data: buf.toString('base64')
      });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 *  Health
 * ------------------------------------------------------------------ */
app.get('/api/health', async (_req, res) => {
  const [j, v] = await Promise.all([
    runProcess('java',  ['-version'], { timeout: 5000 }),
    runProcess('javac', ['-version'], { timeout: 5000 })
  ]);
  res.json({
    ok:        !j.spawnError && !v.spawnError,
    java:      j.spawnError ? null : (j.stderr || j.stdout).trim().split('\n')[0],
    javac:     v.spawnError ? null : (v.stderr || v.stdout).trim().split('\n')[0],
    hints: {
      java:  j.spawnError ? '`java` was not found on PATH.'  : null,
      javac: v.spawnError ? '`javac` was not found on PATH.' : null
    }
  });
});

/* ------------------------------------------------------------------ *
 *  /api/compile  — used by CMD "javac"
 * ------------------------------------------------------------------ */
app.post('/api/compile', async (req, res) => {
  const started = Date.now();
  const code = (req.body || {}).code;
  if (typeof code !== 'string' || !code.trim()) {
    return res.status(400).json({ ok: false, error: 'No code provided.' });
  }
  if (Buffer.byteLength(code, 'utf8') > MAX_CODE_BYTES) {
    return res.status(413).json({ ok: false, error: 'Source too large (max 512 KB).' });
  }
  const className = detectClassName(code);
  if (!className || !IDENT_RE.test(className)) {
    return res.status(400).json({ ok: false, error: 'Could not detect a valid class name.' });
  }
  const pkg = detectPackage(code);

  const workDir = path.join(os.tmpdir(), 'java-web-ide', crypto.randomUUID());
  const srcRoot = path.join(workDir, 'src');
  const outDir  = path.join(workDir, 'out');
  const srcDir  = pkg ? path.join(srcRoot, ...pkg.split('.')) : srcRoot;
  const srcFile = path.join(srcDir, className + '.java');

  try {
    await fs.mkdir(srcDir, { recursive: true });
    await fs.mkdir(outDir,  { recursive: true });
    await fs.writeFile(srcFile, code, 'utf8');

    const compile = await runProcess('javac',
      ['-encoding', 'UTF-8', '-d', outDir, srcFile],
      { timeout: COMPILE_TIMEOUT_MS, cwd: workDir });

    if (compile.spawnError) {
      return res.json({ ok: false, error: '`javac` was not found on PATH.', durationMs: Date.now() - started });
    }
    if (compile.code !== 0) {
      return res.json({
        ok: false, stage: 'compile',
        stdout: truncate(compile.stdout),
        stderr: truncate(compile.stderr),
        durationMs: Date.now() - started
      });
    }
    const classFiles = await collectClassFiles(outDir, outDir);
    res.json({
      ok: true, className, packageName: pkg || null,
      classFiles,
      durationMs: Date.now() - started
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  } finally {
    fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
});

/* ------------------------------------------------------------------ *
 *  WebSocket + HTTP server
 * ------------------------------------------------------------------ */
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws/run' });

function sendWs(ws, obj) {
  if (ws.readyState === 1) {
    try { ws.send(JSON.stringify(obj)); } catch (_) {}
  }
}

/* Stream a `java` subprocess: stdout/stderr are forwarded live, and
 * whatever the client sends as `input` messages gets piped to stdin. */
function streamJavaProcess(ws, state, { javaArgs, cwd, presetStdin, started }) {
  return new Promise((resolve) => {
    const child = spawn('java', javaArgs, { cwd, windowsHide: true });
    state.proc = child;

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      sendWs(ws, { type: 'note', data: `\n[timeout — killed after ${RUN_TIMEOUT_MS / 1000}s]\n` });
      try { child.kill('SIGKILL'); } catch (_) {}
    }, RUN_TIMEOUT_MS);

    child.stdin.on('error', () => {});
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', d => sendWs(ws, { type: 'stdout', data: d }));
    child.stderr.on('data', d => sendWs(ws, { type: 'stderr', data: d }));

    child.on('error', (err) => {
      clearTimeout(timer);
      state.proc = null;
      sendWs(ws, { type: 'error', error: err.message });
      resolve();
    });

    child.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      state.proc = null;
      const killed = signal === 'SIGKILL';
      sendWs(ws, {
        type: 'exit',
        code: killed ? -2 : exitCode,
        signal: signal || null,
        timedOut,
        durationMs: Date.now() - started
      });
      try { ws.close(); } catch (_) {}
      resolve();
    });

    if (presetStdin) {
      try { child.stdin.write(presetStdin); } catch (_) {}
    }
  });
}

/* ------------------------------------------------------------------ *
 *  Compile-then-run  (used by Run and Save & Run)
 * ------------------------------------------------------------------ */
async function handleCompileAndRun(ws, msg, state) {
  const started   = Date.now();
  const code      = msg.code;
  const preset    = typeof msg.stdin === 'string' ? msg.stdin : '';
  const args      = sanitizeArgs(msg.args);
  const wantClass = !!msg.wantClassFiles;

  if (typeof code !== 'string' || !code.trim()) {
    sendWs(ws, { type: 'error', error: 'No code provided.' });
    sendWs(ws, { type: 'exit', code: -1 });
    try { ws.close(); } catch (_) {}
    return;
  }
  if (Buffer.byteLength(code, 'utf8') > MAX_CODE_BYTES) {
    sendWs(ws, { type: 'error', error: 'Source too large (max 512 KB).' });
    sendWs(ws, { type: 'exit', code: -1 });
    try { ws.close(); } catch (_) {}
    return;
  }

  const className = detectClassName(code);
  if (!className || !IDENT_RE.test(className)) {
    sendWs(ws, { type: 'error', error: 'Could not detect a valid class / interface / enum / record.' });
    sendWs(ws, { type: 'exit', code: -1 });
    try { ws.close(); } catch (_) {}
    return;
  }
  const pkg = detectPackage(code);
  if (pkg && !pkg.split('.').every(p => IDENT_RE.test(p))) {
    sendWs(ws, { type: 'error', error: 'Invalid package declaration.' });
    sendWs(ws, { type: 'exit', code: -1 });
    try { ws.close(); } catch (_) {}
    return;
  }

  const workDir = path.join(os.tmpdir(), 'java-web-ide', crypto.randomUUID());
  state.workDir = workDir;

  const srcRoot = path.join(workDir, 'src');
  const outDir  = path.join(workDir, 'out');
  const srcDir  = pkg ? path.join(srcRoot, ...pkg.split('.')) : srcRoot;
  const srcFile = path.join(srcDir, className + '.java');
  const fqn     = pkg ? `${pkg}.${className}` : className;

  try {
    await fs.mkdir(srcDir, { recursive: true });
    await fs.mkdir(outDir,  { recursive: true });
    await fs.writeFile(srcFile, code, 'utf8');

    if (state.cancelled) return;

    sendWs(ws, { type: 'stage', stage: 'compile', className });

    const compile = await runProcess('javac',
      ['-encoding', 'UTF-8', '-d', outDir, srcFile],
      { timeout: COMPILE_TIMEOUT_MS, cwd: workDir });

    if (state.cancelled) return;

    if (compile.spawnError) {
      sendWs(ws, { type: 'error', error: '`javac` was not found on PATH.' });
      sendWs(ws, { type: 'exit', code: -1, durationMs: Date.now() - started });
      try { ws.close(); } catch (_) {}
      return;
    }
    if (compile.code !== 0) {
      if (compile.stdout) sendWs(ws, { type: 'stdout', data: compile.stdout });
      if (compile.stderr) sendWs(ws, { type: 'stderr', data: compile.stderr });
      sendWs(ws, { type: 'exit', code: compile.code, stage: 'compile', durationMs: Date.now() - started });
      try { ws.close(); } catch (_) {}
      return;
    }

    if (wantClass) {
      const classFiles = await collectClassFiles(outDir, outDir);
      sendWs(ws, {
        type: 'classFiles',
        className, packageName: pkg || null,
        classFiles
      });

      /* Wait for the client to finish writing files to disk before we run,
       * so the "✓ Saved" messages appear above the program's output. */
      await new Promise((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          state.ackResolvers.delete('classFiles');
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(finish, ACK_TIMEOUT_MS);
        state.ackResolvers.set('classFiles', finish);
      });
    }

    if (state.cancelled) return;

    sendWs(ws, { type: 'stage', stage: 'run' });

    await streamJavaProcess(ws, state, {
      javaArgs: [
        '-Dfile.encoding=UTF-8', '-Dstdout.encoding=UTF-8',
        '-cp', outDir, fqn, ...args
      ],
      cwd: workDir,
      presetStdin: preset,
      started
    });

  } catch (err) {
    sendWs(ws, { type: 'error', error: err.message || String(err) });
    sendWs(ws, { type: 'exit', code: -1 });
    try { ws.close(); } catch (_) {}
  } finally {
    try { await fs.rm(workDir, { recursive: true, force: true }); } catch (_) {}
    state.workDir = null;
  }
}

/* ------------------------------------------------------------------ *
 *  Direct-class run  (used by CMD "java")
 * ------------------------------------------------------------------ */
async function handleDirectClassRun(ws, msg, state) {
  const started   = Date.now();
  const className = msg.className;
  const classFiles = msg.classFiles;
  const args      = sanitizeArgs(msg.args);
  const preset    = typeof msg.stdin === 'string' ? msg.stdin : '';

  if (typeof className !== 'string' || !FQN_RE.test(className)) {
    sendWs(ws, { type: 'error', error: 'Invalid class name.' });
    sendWs(ws, { type: 'exit', code: -1 });
    try { ws.close(); } catch (_) {}
    return;
  }
  if (!Array.isArray(classFiles) || classFiles.length === 0) {
    sendWs(ws, { type: 'error', error: 'No class files provided.' });
    sendWs(ws, { type: 'exit', code: -1 });
    try { ws.close(); } catch (_) {}
    return;
  }

  const workDir = path.join(os.tmpdir(), 'java-web-ide', crypto.randomUUID());
  const cpDir   = path.join(workDir, 'classes');
  state.workDir = workDir;

  try {
    await fs.mkdir(cpDir, { recursive: true });
    for (const cf of classFiles) {
      if (!cf || typeof cf.name !== 'string' || typeof cf.data !== 'string') continue;
      const parts = cf.name.split('/').filter(p => p && p !== '.' && p !== '..');
      if (!parts.length) continue;
      const dest = path.resolve(cpDir, parts.join(path.sep));
      if (dest !== cpDir && !dest.startsWith(cpDir + path.sep)) continue;
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, Buffer.from(cf.data, 'base64'));
    }

    if (state.cancelled) return;

    sendWs(ws, { type: 'stage', stage: 'run' });

    await streamJavaProcess(ws, state, {
      javaArgs: [
        '-Dfile.encoding=UTF-8', '-Dstdout.encoding=UTF-8',
        '-cp', cpDir, className, ...args
      ],
      cwd: workDir,
      presetStdin: preset,
      started
    });

  } catch (err) {
    sendWs(ws, { type: 'error', error: err.message || String(err) });
    sendWs(ws, { type: 'exit', code: -1 });
    try { ws.close(); } catch (_) {}
  } finally {
    try { await fs.rm(workDir, { recursive: true, force: true }); } catch (_) {}
    state.workDir = null;
  }
}

function handleStart(ws, msg, state) {
  if (Array.isArray(msg.classFiles) && msg.classFiles.length && typeof msg.className === 'string') {
    return handleDirectClassRun(ws, msg, state);
  }
  return handleCompileAndRun(ws, msg, state);
}

wss.on('connection', (ws) => {
  const state = {
    proc: null,
    workDir: null,
    cancelled: false,
    started: false,
    ackResolvers: new Map()
  };

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === 'start') {
      if (state.started) return;
      state.started = true;
      handleStart(ws, msg, state).catch(() => {});
    } else if (msg.type === 'input') {
      if (state.proc && state.proc.stdin
          && state.proc.stdin.writable
          && !state.proc.stdin.destroyed) {
        try { state.proc.stdin.write(String(msg.data || '')); } catch (_) {}
      }
    } else if (msg.type === 'kill') {
      state.cancelled = true;
      if (state.proc) { try { state.proc.kill('SIGKILL'); } catch (_) {} }
    } else if (msg.type === 'classFilesAck') {
      const resolver = state.ackResolvers.get('classFiles');
      if (resolver) resolver();
    }
  });

  ws.on('close', () => {
    state.cancelled = true;
    /* release any pending ack wait so nothing hangs */
    const r = state.ackResolvers.get('classFiles');
    if (r) r();
    if (state.proc) { try { state.proc.kill('SIGKILL'); } catch (_) {} }
    if (state.workDir) {
      fs.rm(state.workDir, { recursive: true, force: true }).catch(() => {});
      state.workDir = null;
    }
  });

  ws.on('error', () => {});
});

/* ------------------------------------------------------------------ *
 *  JSON 404 for /api/*
 * ------------------------------------------------------------------ */
app.use('/api', (req, res) => {
  res.status(404).json({
    ok: false,
    error: `Unknown API endpoint: ${req.method} ${req.originalUrl}`,
    hint: 'Restart the Node server if you just edited server.js — routes load once at boot.'
  });
});
app.use((err, _req, res, _next) => {
  res.status(err.status || 500).json({ ok: false, error: err.message || 'Internal server error' });
});

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  Java Web IDE');
  console.log('  ────────────────────────────────────────');
  console.log(`  ▸  http://${HOST}:${PORT}`);
  console.log(`  ▸  ws:  ws://${HOST}:${PORT}/ws/run`);
  console.log(`  ▸  temp workspace: ${path.join(os.tmpdir(), 'java-web-ide')}`);
  console.log('');
});