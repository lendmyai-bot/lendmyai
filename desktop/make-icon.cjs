// Renders icon.svg (the website's favicon) to build/icon.png at 1024px, using Electron itself
// so the SVG renders exactly as in a browser, with the margin macOS icons have.
// Run: electron make-icon.cjs, then make-icns.sh
const { app, BrowserWindow } = require("electron");
const { readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");

app.whenReady().then(async () => {
  const svg = readFileSync(join(__dirname, "icon.svg"), "utf8");
  const win = new BrowserWindow({ width: 1024, height: 1024, show: false, transparent: true, frame: false, webPreferences: { offscreen: true } });
  const html = `<html><body style="margin:0;background:transparent"><img src="data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}" style="margin:100px" width="824" height="824"></body></html>`;
  await win.loadURL("data:text/html;base64," + Buffer.from(html).toString("base64"));
  await new Promise((r) => setTimeout(r, 500));
  const img = await win.webContents.capturePage();
  writeFileSync(join(__dirname, "build", "icon.png"), img.toPNG());
  app.quit();
});
