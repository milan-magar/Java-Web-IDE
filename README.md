# Java Web IDE

A local, browser-based Java editor that compiles and runs your code with the JDK installed on your own machine. No cloud, no containers, no build step.

The frontend is one self-contained HTML file. The backend is a small Express server that shells out to `javac` and `java`. Everything you type, run, and save stays on your computer.

---

## Features

- **Custom code editor** — syntax highlighting, indent guides, active-line highlight, matching-bracket decoration, real code folding
- **Two run modes** — **Run** (temp workspace) and **Save & Run** (writes into your chosen folder)
- **Interactive stdin** — type into the terminal while the program runs; input lands on the same line as the prompt
- **Command-line arguments** — an **Args** field, or `java Main foo 42` in CMD mode
- **CMD mode** — folder-aware prompt with `push`, `javac`, `java`, `ls`, `pwd`, `cat`, `echo`, `cls`, `help`
- **File tree sidebar** — browse and open any `.java` file in your chosen folder
- **Snippets** — `sout`, `soutv`, `psvm`, `fori`, `foreach`, `while`, `trycatch`
- **Autocomplete** — `Ctrl+Space` for keywords, JDK types, snippet names, and identifiers from your buffer
- **Clickable stack traces** — `at Main.main(Main.java:8)` links jump to the file and line
- **Dark & soft-gray light themes**, font size control, persistence across sessions

---

## Requirements

- **Node.js 18+** — <https://nodejs.org>
- **JDK 17+** (not just a JRE) — [Eclipse Temurin](https://adoptium.net) is a good choice

Verify in a terminal:

```bash
node -v
javac -version
