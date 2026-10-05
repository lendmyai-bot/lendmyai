import { HttpError, errorResponse, match, route, sharedRoutes, type Route } from "../src/api.js";
import { me, withToken } from "../src/github.js";

// lendmyai.com: Cloudflare Worker serving the website (static files in web/)
// and the shared JSON API. Users sign in with GitHub (OAuth web flow); their
// token lives only in an encrypted, HttpOnly session cookie, so there is no
// database. Agent runs never happen here; they run in each user's local app.

interface Env {
  ASSETS: { fetch(req: Request): Promise<Response> };
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  /** Random string used to encrypt session cookies. */
  SESSION_SECRET: string;
}

const SESSION_COOKIE = "lmai_session";
const STATE_COOKIE = "lmai_oauth_state";
const SESSION_DAYS = 30;
const SCOPE = "public_repo";

const hostedRoutes: Route[] = [
  route("GET", "/api/me", async () => ({ login: await me(), agents: [], mode: "hosted" })),
  ...sharedRoutes,
];

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/auth/")) return auth(req, url, env);
    if (url.pathname.startsWith("/api/")) return apiRequest(req, url, env);
    return env.ASSETS.fetch(req);
  },
};

async function apiRequest(req: Request, url: URL, env: Env): Promise<Response> {
  try {
    let body: unknown;
    if (req.method === "POST") {
      // Cross-site request protection on top of the SameSite=Lax cookie.
      if (req.headers.get("Origin") !== url.origin) throw new HttpError(403, "Forbidden origin");
      if (!req.headers.get("Content-Type")?.startsWith("application/json")) throw new HttpError(415, "Expected JSON");
      body = await req.json().catch(() => ({}));
    }
    const m = match(hostedRoutes, req.method, url.pathname);
    if (!m) throw new HttpError(404, "Not found");

    const token = await openSession(cookie(req, SESSION_COOKIE), env);
    if (!token) throw new HttpError(401, "Not signed in.");
    const data = await withToken(token, () => m.handler(m.params, body, url));
    return json(200, data);
  } catch (e) {
    const { status, error } = errorResponse(e);
    return json(status, { error });
  }
}

async function auth(req: Request, url: URL, env: Env): Promise<Response> {
  const redirectUri = `${url.origin}/auth/callback`;

  if (url.pathname === "/auth/login") {
    const state = base64url(crypto.getRandomValues(new Uint8Array(16)));
    const authorize = new URL("https://github.com/login/oauth/authorize");
    authorize.search = new URLSearchParams({ client_id: env.GITHUB_CLIENT_ID, redirect_uri: redirectUri, scope: SCOPE, state }).toString();
    return redirect(authorize.toString(), [setCookie(STATE_COOKIE, state, 600)]);
  }

  if (url.pathname === "/auth/callback") {
    const state = url.searchParams.get("state");
    const code = url.searchParams.get("code");
    if (!code || !state || state !== cookie(req, STATE_COOKIE)) {
      return new Response("Sign-in expired or was tampered with. Please try again from the home page.", { status: 400 });
    }
    const res = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": "lendmyai" },
      body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code, redirect_uri: redirectUri }),
    });
    const data = (await res.json().catch(() => ({}))) as { access_token?: string; error_description?: string };
    if (!data.access_token) return new Response(`GitHub sign-in failed: ${data.error_description ?? "unknown error"}`, { status: 400 });
    const session = await sealSession(data.access_token, env);
    return redirect("/", [setCookie(SESSION_COOKIE, session, SESSION_DAYS * 86400), setCookie(STATE_COOKIE, "", 0)]);
  }

  if (url.pathname === "/auth/logout") {
    return redirect("/", [setCookie(SESSION_COOKIE, "", 0)]);
  }
  return new Response("Not found", { status: 404 });
}

// ---------- session cookie: AES-GCM encrypted GitHub token ----------

async function sessionKey(env: Env): Promise<CryptoKey> {
  if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32) throw new Error("SESSION_SECRET must be set (32+ characters).");
  const raw = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(env.SESSION_SECRET));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function sealSession(token: string, env: Env): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = new TextEncoder().encode(JSON.stringify({ t: token, exp: Date.now() + SESSION_DAYS * 86400_000 }));
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await sessionKey(env), plain));
  const out = new Uint8Array(iv.length + sealed.length);
  out.set(iv);
  out.set(sealed, iv.length);
  return base64url(out);
}

async function openSession(value: string | undefined, env: Env): Promise<string | undefined> {
  if (!value) return undefined;
  try {
    const bytes = fromBase64url(value);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(0, 12) }, await sessionKey(env), bytes.slice(12));
    const { t, exp } = JSON.parse(new TextDecoder().decode(plain));
    return typeof t === "string" && exp > Date.now() ? t : undefined;
  } catch {
    return undefined;
  }
}

// ---------- helpers ----------

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function cookie(req: Request, name: string): string | undefined {
  const header = req.headers.get("Cookie") ?? "";
  for (const part of header.split(/;\s*/)) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i) === name) return part.slice(i + 1);
  }
  return undefined;
}

function setCookie(name: string, value: string, maxAge: number): string {
  return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

function redirect(location: string, cookies: string[]): Response {
  const headers = new Headers({ Location: location });
  for (const c of cookies) headers.append("Set-Cookie", c);
  return new Response(null, { status: 302, headers });
}

function json(status: number, data: unknown): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
