import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setFallbackToken } from "./github.js";

// GitHub sign-in for the CLI and local app. Token sources, in order:
// GITHUB_TOKEN/GH_TOKEN, our own saved login (~/.lendmyai/auth.json, created by
// `lendmyai login` via GitHub's device flow), then the GitHub CLI's login.

/** Public client ID of the lendmyai GitHub OAuth App (device flow enabled). Not a secret. */
const CLIENT_ID = process.env.LENDMYAI_GITHUB_CLIENT_ID || "Ov23li5bvyCUX0qTjren";
const SCOPE = "public_repo";

export const HOME_DIR = join(homedir(), ".lendmyai");
const AUTH_FILE = join(HOME_DIR, "auth.json");

export function findToken(): string | undefined {
  const env = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (env) return env;
  try {
    const saved = JSON.parse(readFileSync(AUTH_FILE, "utf8"));
    if (saved.token) return saved.token;
  } catch {}
  try {
    return execFileSync("gh", ["auth", "token"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
  } catch {
    return undefined;
  }
}

export function useNodeAuth(): void {
  let cached: string | undefined;
  setFallbackToken(() => {
    cached ??= findToken();
    if (!cached) throw new Error("Not signed in. Run `npx lendmyai login`.");
    return cached;
  });
}

/** `onCode` lets an app show the sign-in code itself instead of the terminal. */
export async function login(onCode?: (url: string, code: string) => void): Promise<void> {
  if (!CLIENT_ID) {
    throw new Error("GitHub sign-in is not configured in this build. Set LENDMYAI_GITHUB_CLIENT_ID, or sign in with `gh auth login`.");
  }
  const start = await post("https://github.com/login/device/code", { client_id: CLIENT_ID, scope: SCOPE });
  if (onCode) onCode(start.verification_uri, start.user_code);
  else console.log(`\nTo sign in, open ${start.verification_uri} and enter the code:\n\n    ${start.user_code}\n`);
  openBrowser(start.verification_uri);

  let interval = (start.interval ?? 5) * 1000;
  const deadline = Date.now() + (start.expires_in ?? 900) * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, interval));
    const res = await post("https://github.com/login/oauth/access_token", {
      client_id: CLIENT_ID,
      device_code: start.device_code,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    });
    if (res.access_token) {
      mkdirSync(HOME_DIR, { recursive: true });
      writeFileSync(AUTH_FILE, JSON.stringify({ token: res.access_token }), { mode: 0o600 });
      // Owner-only on macOS and Linux. Windows has no POSIX permission bits: Node ignores `mode` there and
      // chmod only toggles the read-only flag (0o600 keeps the file writable), so on Windows this call does not
      // throw but also does not restrict anything. That is an accepted tradeoff: the file sits in the user's
      // own profile folder (~/.lendmyai), which Windows already limits to that user, SYSTEM and administrators.
      // Restricting it further would need an ACL change (for example `icacls <file> /inheritance:r /grant:r
      // %USERNAME%:F`), which we don't run.
      chmodSync(AUTH_FILE, 0o600);
      console.log("✓ Signed in to GitHub.");
      return;
    }
    if (res.error === "slow_down") interval += 5000;
    else if (res.error !== "authorization_pending") throw new Error(`GitHub sign-in failed: ${res.error_description ?? res.error}`);
  }
  throw new Error("GitHub sign-in timed out. Run `npx lendmyai login` to try again.");
}

export function logout(): void {
  if (existsSync(AUTH_FILE)) rmSync(AUTH_FILE);
  console.log("✓ Signed out (saved lendmyai login removed).");
}

async function post(url: string, body: object): Promise<any> {
  const res = await fetch(url, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`GitHub sign-in request failed (${res.status}).`);
  return res.json();
}

export function openBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  try {
    const child = spawn(cmd, [url], { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {}
}
