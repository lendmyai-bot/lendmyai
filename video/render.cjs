// Renders explainer.html to video with Electron (already installed in desktop/) and ffmpeg.
//
//   cd desktop && npx electron ../video/render.cjs            -> video/out/lendmyai-explainer.mp4 (+ .gif)
//   cd desktop && npx electron ../video/render.cjs --stills 2 9.5 20   -> PNG stills at those seconds
//
// Each frame is drawn by seek(t), captured offscreen and piped to ffmpeg as raw pixels.
const { app, BrowserWindow } = require("electron");
const { spawn } = require("node:child_process");
const { mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");

const W = 1920, H = 1080, FPS = 30;
const OUT = join(__dirname, "out");
app.commandLine.appendSwitch("force-device-scale-factor", "1");

app.whenReady().then(async () => {
  mkdirSync(OUT, { recursive: true });
  const win = new BrowserWindow({ width: W, height: H, show: false, useContentSize: true, webPreferences: { offscreen: true, backgroundThrottling: false } });
  const wc = win.webContents;
  wc.setFrameRate(60);
  await win.loadURL(pathToFileURL(join(__dirname, "explainer.html")).href + "?render");
  await new Promise((r) => setTimeout(r, 800)); // fonts and the logo image

  const frameAt = async (t) => {
    // Draw the frame, let the page commit two animation frames, then grab what is on screen.
    await wc.executeJavaScript(`seek(${t}); new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))`);
    const img = await wc.capturePage();
    const { width, height } = img.getSize();
    return width === W && height === H ? img : img.resize({ width: W, height: H });
  };

  const stills = process.argv.indexOf("--stills");
  if (stills !== -1) {
    for (const s of process.argv.slice(stills + 1)) {
      writeFileSync(join(OUT, `still-${s}.png`), (await frameAt(Number(s))).toPNG());
      console.log("still", s);
    }
    return app.quit();
  }

  const duration = await wc.executeJavaScript("DURATION");
  const mp4 = join(OUT, "lendmyai-explainer.mp4");
  const ff = spawn("ffmpeg", ["-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "bgra", "-s", `${W}x${H}`, "-r", String(FPS), "-i", "-",
    "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart", mp4], { stdio: ["pipe", "inherit", "inherit"] });
  const frames = Math.round(duration * FPS);
  for (let i = 0; i < frames; i++) {
    const bitmap = (await frameAt(i / FPS)).toBitmap();
    if (!ff.stdin.write(bitmap)) await new Promise((r) => ff.stdin.once("drain", r));
    if (i % FPS === 0) process.stdout.write(`\r${Math.round((i / frames) * 100)}%`);
  }
  ff.stdin.end();
  await new Promise((r) => ff.on("close", r));
  console.log(`\nwrote ${mp4}`);

  // A lighter GIF for READMEs: 960 px wide, 15 fps, one shared palette.
  const gif = join(OUT, "lendmyai-explainer.gif");
  await new Promise((r) => spawn("ffmpeg", ["-y", "-loglevel", "error", "-i", mp4, "-vf",
    "fps=15,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=sierra2_4a", gif], { stdio: "inherit" }).on("close", r));
  console.log(`wrote ${gif}`);
  app.quit();
});
