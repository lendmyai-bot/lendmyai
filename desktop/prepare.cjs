// Copies the compiled lendmyai app and the web UI into desktop/bundle, so the
// packaged macOS app carries everything it needs (the CLI has no runtime dependencies).
const { cpSync, mkdirSync, rmSync, writeFileSync } = require("node:fs");
const { execFileSync } = require("node:child_process");
const { join } = require("node:path");

const root = join(__dirname, "..");
const out = join(__dirname, "bundle");
execFileSync("npm", ["run", "build"], { cwd: root, stdio: "inherit" });
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(join(root, "dist"), join(out, "dist"), { recursive: true, filter: (src) => !src.endsWith(".test.js") });
cpSync(join(root, "web"), join(out, "web"), { recursive: true, filter: (src) => !src.includes(`${join("web", "docs")}`) });
// dist is ES modules.
writeFileSync(join(out, "package.json"), JSON.stringify({ type: "module" }));
