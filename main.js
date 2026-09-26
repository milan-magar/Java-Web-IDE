'use strict';

const { app, BrowserWindow, Menu, shell, dialog } = require('electron');
const path = require('path');
const net  = require('net');

let mainWindow = null;
let port = 3000;

/* ---------- pick a free port, then start the built-in server ---------- */
function isPortFree(p) {
  return new Promise(resolve => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(p, '127.0.0.1');
  });
}

async function pickPort(start = 3000) {
  for (let p = start; p < start + 50; p++) {
    if (await isPortFree(p)) return p;
  }
  return start;
}

function startServer(p) {
  process.env.PORT = String(p);
  process.env.HOST = '127.0.0.1';
  try {
    require('./server.js');
  } catch (err) {
    dialog.showErrorBox(
      'Server failed to start',
      err.stack || err.message || String(err)
    );
  }
}

async function waitForServer(url, timeoutMs = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch (_) {}
    await new Promise(r => setTimeout(r, 150));
  }
  return false;
}

/* ---------- menu ---------- */
function buildMenu(baseUrl) {
  const isMac = process.platform === 'darwin';

  const template = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    }] : []),
    {
      label: 'File',
      submenu: [ isMac ? { role: 'close' } : { role: 'quit' } ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Open in Browser',
          click: () => shell.openExternal(baseUrl)
        },
        {
          label: 'About',
          click: () => dialog.showMessageBox({
            type: 'info',
            title: 'Java Web IDE',
            message: 'Java Web IDE',
            detail:
              `Version ${app.getVersion()}\n` +
              `Electron ${process.versions.electron}\n` +
              `Chromium ${process.versions.chrome}\n` +
              `Node ${process.versions.node}`,
            buttons: ['OK']
          })
        }
      ]
    }
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ---------- window ---------- */
function createWindow(baseUrl) {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'Java Web IDE',
    backgroundColor: '#1e1e1e',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.loadURL(baseUrl);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

/* ---------- boot ---------- */
app.whenReady().then(async () => {
  port = await pickPort(3000);
  const baseUrl = `http://127.0.0.1:${port}`;

  startServer(port);

  const ok = await waitForServer(`${baseUrl}/api/health`);
  if (!ok) {
    dialog.showErrorBox(
      'Server not responding',
      `The built-in server did not respond at ${baseUrl}.\n\n` +
      `Make sure a JDK is installed and that port ${port} is free.`
    );
  }

  buildMenu(baseUrl);
  createWindow(baseUrl);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(baseUrl);
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});