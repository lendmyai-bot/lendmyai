import { HttpError, errorResponse, match, route, sharedRoutes, type Route } from "../src/api.js";
import { GitHubError, me, withToken } from "../src/github.js";
import { connector, isConnectorPath } from "./connector.js";
import { SESSION_COOKIE, SESSION_DAYS, base64url, cookie, openSession, redirect, sealSession, setCookie } from "./session.js";

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
  /** Read-only token (public repositories only) used to show projects and tasks to signed-out visitors. */
  GITHUB_PUBLIC_TOKEN?: string;
  /** Classic token (public_repo) of the lendmyai-bot account, which acts for contributors without GitHub. */
  BOT_GITHUB_TOKEN?: string;
}

/** Seconds that pages for signed-out visitors are cached, to stay within GitHub's rate limits. */
const PUBLIC_CACHE_SECONDS = 15;

const STATE_COOKIE = "lmai_oauth_state";
const RETURN_COOKIE = "lmai_return";

/** Only same-site paths, so sign-in can't be used to redirect elsewhere. */
const safeReturn = (p: string | null | undefined) => (p && p.startsWith("/") && !p.startsWith("//") && !p.includes("\\") ? p : "/");
const SCOPE = "public_repo";

const hostedRoutes: Route[] = [
  route("GET", "/api/me", async () => ({ login: await me(), agents: [], mode: "hosted" })),
  ...sharedRoutes,
];

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    // docs.lendmyai.com serves the static pages in web/docs/ from its own root.
    if (url.hostname.startsWith("docs.")) {
      const assetUrl = new URL(url);
      assetUrl.pathname = "/docs" + url.pathname;
      return noStaleHtml(await env.ASSETS.fetch(new Request(assetUrl, req)));
    }
    if (isConnectorPath(url.pathname)) return connector(req, url, env);
    if (url.pathname.startsWith("/auth/")) return auth(req, url, env);
    if (url.pathname.startsWith("/api/")) return apiRequest(req, url, env);
    return noStaleHtml(await env.ASSETS.fetch(req));
  },
};

/** Pages are always revalidated, so a new version or a new task shows up on the next load. */
function noStaleHtml(res: Response): Response {
  if (!res.headers.get("Content-Type")?.includes("text/html")) return res;
  const out = new Response(res.body, res);
  out.headers.set("Cache-Control", "no-cache, must-revalidate");
  return out;
}

async function apiRequest(req: Request, url: URL, env: Env): Promise<Response> {
  try {
    let body: unknown;
    if (req.method === "POST") {
      // Cross-site request protection on top of the SameSite=Lax cookie.
      if (req.headers.get("Origin") !== url.origin) throw new HttpError(403, "Forbidden origin");
      if (!req.headers.get("Content-Type")?.startsWith("application/json")) throw new HttpError(415, "Expected JSON");
      body = await req.json().catch(() => ({}));
    }
    const token = await openSession(cookie(req, SESSION_COOKIE), env);
    if (!token) return await anonymousRequest(req, url, env);

    const m = match(hostedRoutes, req.method, url.pathname);
    if (!m) throw new HttpError(404, "Not found");
    let data: unknown;
    try {
      data = await withToken(token, () => m.handler(m.params, body, url));
    } catch (e) {
      // GitHub no longer accepts the saved token (revoked or expired): sign the
      // visitor out and answer as if they were signed out.
      if (!(e instanceof GitHubError && e.status === 401)) throw e;
      const res = await anonymousRequest(req, url, env).catch((err) => {
        const { status, error } = errorResponse(err);
        return json(status, { error });
      });
      res.headers.append("Set-Cookie", setCookie(SESSION_COOKIE, "", 0));
      return res;
    }
    return json(200, data);
  } catch (e) {
    const { status, error } = errorResponse(e);
    return json(status, { error });
  }
}

/** Signed-out visitors can read public routes, served with the site's read-only token and cached. */
async function anonymousRequest(req: Request, url: URL, env: Env): Promise<Response> {
  if (url.pathname === "/api/me") {
    if (!env.GITHUB_PUBLIC_TOKEN) throw new HttpError(401, "Not signed in.");
    return json(200, { login: null, agents: [], mode: "hosted" });
  }
  const m = match(hostedRoutes, req.method, url.pathname);
  if (!m) throw new HttpError(404, "Not found");
  if (!m.isPublic || !env.GITHUB_PUBLIC_TOKEN) throw new HttpError(401, "Sign in with GitHub to do this.");

  // Responses are identical for every signed-out visitor, so they are cached by URL.
  const cache = (caches as unknown as { default: Cache }).default;
  const key = new Request(url.toString(), { method: "GET" });
  const hit = await cache.match(key);
  // Cached at Cloudflare only: browsers must not reuse it after the visitor signs in.
  if (hit) return json(200, await hit.json());

  const data = await withToken(env.GITHUB_PUBLIC_TOKEN, () => m.handler(m.params, undefined, url), { anonymous: true });
  await cache.put(key, new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${PUBLIC_CACHE_SECONDS}` },
  }));
  return json(200, data);
}

async function auth(req: Request, url: URL, env: Env): Promise<Response> {
  const redirectUri = `${url.origin}/auth/callback`;

  if (url.pathname === "/auth/login") {
    const state = base64url(crypto.getRandomValues(new Uint8Array(16)));
    const authorize = new URL("https://github.com/login/oauth/authorize");
    authorize.search = new URLSearchParams({ client_id: env.GITHUB_CLIENT_ID, redirect_uri: redirectUri, scope: SCOPE, state }).toString();
    const back = safeReturn(url.searchParams.get("return"));
    return redirect(authorize.toString(), [setCookie(STATE_COOKIE, state, 600), setCookie(RETURN_COOKIE, encodeURIComponent(back), 600)]);
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
    const back = safeReturn(decodeURIComponent(cookie(req, RETURN_COOKIE) ?? ""));
    return redirect(back, [setCookie(SESSION_COOKIE, session, SESSION_DAYS * 86400), setCookie(STATE_COOKIE, "", 0), setCookie(RETURN_COOKIE, "", 0)]);
  }

  if (url.pathname === "/auth/logout") {
    return redirect("/", [setCookie(SESSION_COOKIE, "", 0)]);
  }
  return new Response("Not found", { status: 404 });
}

function json(status: number, data: unknown): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
