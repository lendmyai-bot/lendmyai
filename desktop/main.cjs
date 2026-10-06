// lendmyai for macOS: a window around the local app. It starts the same local
// server as `npx lendmyai` (127.0.0.1 only) and shows it, so project owners get
// "Review all pull requests" without a terminal.
const { app, BrowserWindow, dialog, shell } = require("electron");
const { execFileSync } = require("node:child_process");
const { createServer } = require("node:net");
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");

/** Apps opened from Finder don't get the shell's PATH, so claude, git and gh would not be found. */
function fixPath() {
  const extra = ["/opt/homebrew/bin", "/usr/local/bin", `${process.env.HOME}/.local/bin`, `${process.env.HOME}/.claude/local`];
  let fromShell = "";
  try {
    fromShell = execFileSync(process.env.SHELL || "/bin/zsh", ["-ilc", 'printf %s "$PATH"'], { encoding: "utf8", timeout: 5000 });
  } catch {}
  process.env.PATH = [fromShell, ...extra, process.env.PATH].filter(Boolean).join(":");
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

const load = (file) => import(pathToFileURL(join(__dirname, "bundle", "dist", file)).href);

async function start() {
  fixPath();
  const auth = await load("auth.js");
  auth.useNodeAuth();
  if (!auth.findToken()) {
    // GitHub's device flow: the browser opens, the person types this code.
    await auth.login((url, code) => {
      dialog.showMessageBox({ type: "info", message: "Sign in to GitHub", detail: `Your browser opened ${url}.\nEnter this code there:\n\n${code}`, buttons: ["OK"] });
    });
  }
  const port = await freePort();
  const { serve } = await load("server.js");
  serve(port, { open: false });

  const win = new BrowserWindow({ width: 1180, height: 820, title: "lendmyai", backgroundColor: "#0f0f12" });
  // Links to GitHub and other sites open in the browser, not in this window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith(`http://localhost:${port}`)) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });
  win.loadURL(`http://localhost:${port}/#/`);
}

app.whenReady().then(() =>
  start().catch((e) => {
    dialog.showErrorBox("lendmyai could not start", e instanceof Error ? e.message : String(e));
    app.quit();
  }),
);
app.on("window-all-closed", () => app.quit());
