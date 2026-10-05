import { withToken } from "../src/github.js";
import { OWNER_KEY_HOURS, handleMcpMessage } from "../src/mcp.js";
import { SESSION_COOKIE, openSession } from "./session.js";
import {
  OAuthError, checkAuthorize, cleanName, exchange, issueCode, metadata, newContributor, registerClient, seal, unseal, verifyAccess,
  type AuthorizeRequest, type Contributor,
} from "../src/oauth.js";

// The lendmyai connector for Claude: OAuth endpoints (so contributors can
// connect without GitHub) and the MCP endpoint at /mcp.

export interface ConnectorEnv {
  SESSION_SECRET: string;
  /** Classic token (public_repo) of the lendmyai-bot GitHub account, which works for contributors. */
  BOT_GITHUB_TOKEN?: string;
}

const VERSION = "0.5.1";
const CONTRIBUTOR_COOKIE = "lmai_contributor";
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Authorization, Content-Type, Mcp-Protocol-Version, Mcp-Session-Id", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" };

const json = (status: number, data: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...CORS, ...headers } });

export function isConnectorPath(path: string): boolean {
  return path === "/mcp" || path === "/api/connector" || path.startsWith("/api/plan/") || path.startsWith("/oauth/") || path.startsWith("/.well-known/oauth-");
}

export async function connector(req: Request, url: URL, env: ConnectorEnv): Promise<Response> {
  // OAuth metadata must advertise https, whatever scheme the request arrived with.
  const local = ["localhost", "127.0.0.1"].includes(url.hostname);
  const origin = local ? url.origin : `https://${url.host}`;
  const path = url.pathname;
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  try {
    if (path.startsWith("/.well-known/oauth-protected-resource")) {
      return json(200, { resource: `${origin}/mcp`, authorization_servers: [origin], bearer_methods_supported: ["header"], resource_name: "lendmyai" });
    }
    if (path === "/.well-known/oauth-authorization-server") return json(200, metadata(origin));
    if (path === "/oauth/register" && req.method === "POST") return json(201, await registerClient(env.SESSION_SECRET, await req.json().catch(() => ({}))));
    if (path === "/oauth/token" && req.method === "POST") {
      return json(200, await exchange(env.SESSION_SECRET, new URLSearchParams(await req.text())));
    }
    if (path === "/oauth/authorize") return await authorize(req, url, env);
    if (path === "/mcp") return await mcp(req, origin, env);
    if (path.startsWith("/api/plan/")) return await planLink(req, path, env);
    if (path === "/api/connector") {
      // Lets lendmyai.com know this browser finished connecting Claude, so the site can guide setup itself.
      const known = await unseal<Contributor>(env.SESSION_SECRET, "contributor", cookie(req, CONTRIBUTOR_COOKIE));
      return json(200, known ? { connected: true, name: known.n, github: known.g ?? null } : { connected: false });
    }
    return json(404, { error: "not_found" });
  } catch (e) {
    if (e instanceof OAuthError) return json(e.status, { error: e.code, error_description: e.message });
    return json(500, { error: "server_error", error_description: e instanceof Error ? e.message : String(e) });
  }
}

// ---------- "Plan tasks with Claude" ----------

/**
 * Returns the Claude link for the Plan button: a new chat whose message carries
 * an owner key, a sealed 24-hour grant to post tasks to this one project as the
 * signed-in owner. No CORS headers: only lendmyai.com itself may read it.
 */
async function planLink(req: Request, path: string, env: ConnectorEnv): Promise<Response> {
  const reply = (status: number, data: unknown) =>
    new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
  const m = /^\/api\/plan\/([\w.-]+)\/([\w.-]+)$/.exec(path);
  if (!m || req.method !== "GET") return reply(404, { error: "Not found" });
  const owner = await signedInGitHub(req, env);
  if (!owner) return reply(401, { error: "Sign in with GitHub first." });

  const res = await fetch(`https://api.github.com/repos/${m[1]}/${m[2]}`, {
    headers: { Authorization: `Bearer ${owner.token}`, Accept: "application/vnd.github+json", "User-Agent": "lendmyai" },
  });
  const repo = (await res.json().catch(() => ({}))) as any;
  if (!res.ok) return reply(404, { error: "Project not found." });
  if (repo.private) return reply(400, { error: "lendmyai only works with public projects." });
  if (!(repo.permissions?.triage || repo.permissions?.push)) return reply(403, { error: "Only the project's owners can plan its tasks." });

  const key = await seal(env.SESSION_SECRET, "ownerkey", { g: owner.login, t: owner.token, p: repo.full_name }, OWNER_KEY_HOURS * 3600);
  const prompt = `Help me plan lendmyai tasks for my project ${repo.full_name} (owner key: ${key}).\n\nWhat I want to achieve: `;
  return reply(200, { claudeUrl: `https://claude.ai/new?q=${encodeURIComponent(prompt)}` });
}

// ---------- consent page ----------

async function authorize(req: Request, url: URL, env: ConnectorEnv): Promise<Response> {
  const secret = env.SESSION_SECRET;
  const known = await unseal<Contributor>(secret, "contributor", cookie(req, CONTRIBUTOR_COOKIE));
  const github = await signedInGitHub(req, env);
  const signInHref = `/auth/login?return=${encodeURIComponent(url.pathname + url.search)}`;

  if (req.method === "GET") {
    let ar: AuthorizeRequest;
    try {
      ar = await checkAuthorize(secret, url.searchParams);
    } catch (e) {
      return page("Can't connect", `<p>${esc((e as Error).message)}</p>`, 400);
    }
    return page("Connect Claude to lendmyai", consentForm(ar, url.searchParams, known, github, signInHref));
  }

  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  // The consent form must be submitted from this site (CSRF protection).
  const formOrigin = req.headers.get("Origin");
  if (!formOrigin || new URL(formOrigin).host !== url.host) return page("Can't connect", "<p>Please start again from Claude.</p>", 403);
  const form = new URLSearchParams(await req.text());
  const params = Object.fromEntries(form);
  const ar = await checkAuthorize(secret, params);

  let who: Contributor;
  try {
    // Returning contributors keep their identity; they may change their display name.
    who = known ? { u: known.u, n: cleanName(form.get("name") || known.n) } : newContributor(form.get("name") ?? "");
    if (github) Object.assign(who, { g: github.login, t: github.token });
  } catch (e) {
    return page("Connect Claude to lendmyai", `<div class="error">${esc((e as Error).message)}</div>${consentForm(ar, form, known, github, signInHref)}`, 400);
  }
  const location = await issueCode(secret, ar, who);
  const headers = new Headers({ Location: location });
  const remembered: Contributor = { u: who.u, n: who.n, ...(who.g ? { g: who.g } : {}) };
  headers.append("Set-Cookie", `${CONTRIBUTOR_COOKIE}=${await seal(secret, "contributor", remembered)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${365 * 86400}`);
  return new Response(null, { status: 302, headers });
}

function consentForm(
  ar: AuthorizeRequest, params: URLSearchParams, known: Contributor | undefined, github: { login: string } | undefined, signInHref: string,
): string {
  const keep = ["client_id", "redirect_uri", "state", "code_challenge", "code_challenge_method", "response_type", "scope", "resource"];
  const hidden = keep.map((k) => (params.get(k) ? `<input type="hidden" name="${k}" value="${esc(params.get(k)!)}">` : "")).join("");
  return `
    <p>${esc(ar.clientName)} wants to connect to lendmyai. Once connected, Claude can:</p>
    <ul>
      <li>find tasks that open-source projects need help with,</li>
      <li>read and edit the project's files for a task you start,</li>
      <li>send your finished work to the project owner.</li>
    </ul>
    <form method="post" action="/oauth/authorize">
      ${hidden}
      <label for="name">Your name, as it's shown on your contributions</label>
      <input id="name" name="name" required minlength="2" maxlength="40" value="${esc(known?.n ?? "")}" placeholder="e.g. Jane D." autofocus>
      <button type="submit">${known ? "Continue" : "Connect"}</button>
    </form>
    ${github
      ? `<p class="linked">✓ Linked to GitHub as <b>@${esc(github.login)}</b>, so Claude can also plan and post tasks for your projects.</p>`
      : `<p class="fine">No GitHub account needed: lendmyai's bot account delivers your work and credits you by this name.</p>
         <p class="fine">Own a project? <a href="${esc(signInHref)}">Sign in with GitHub first</a> so Claude can also post tasks for you.</p>`}`;
}

function page(title: string, body: string, status = 200): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · lendmyai</title>
<style>
  :root { --bg:#f7f7f8; --surface:#fff; --border:#e3e3e8; --text:#18181b; --muted:#6b6b76; --accent:#5b3ee6; --danger:#b42318; --danger-soft:#fde8e6; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0f0f12; --surface:#18181c; --border:#2e2e36; --text:#ececf1; --muted:#9c9ca8; --accent:#9b87ff; --danger:#ff8a7f; --danger-soft:#3a1714; } }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif; display:grid; place-items:center; min-height:100vh; padding:16px; }
  main { background:var(--surface); border:1px solid var(--border); border-radius:14px; padding:28px; max-width:440px; width:100%; }
  .logo { font-weight:700; display:flex; gap:8px; align-items:center; margin-bottom:16px; }
  .logo span { width:22px; height:22px; border-radius:6px; background:var(--accent); color:#fff; display:inline-grid; place-items:center; font-size:13px; }
  h1 { font-size:20px; margin:0 0 12px; }
  ul { padding-left:20px; color:var(--muted); }
  label { display:block; font-weight:600; margin:16px 0 6px; }
  input { width:100%; font:inherit; padding:10px 12px; border-radius:8px; border:1px solid var(--border); background:var(--bg); color:var(--text); }
  button { margin-top:14px; width:100%; font:inherit; font-weight:600; padding:11px; border:0; border-radius:8px; background:var(--accent); color:#fff; cursor:pointer; }
  .fine { color:var(--muted); font-size:13px; margin-top:14px; }
  .linked { background:var(--bg); border:1px solid var(--border); border-radius:8px; padding:10px 12px; font-size:14px; }
  a { color:var(--accent); }
  .error { background:var(--danger-soft); color:var(--danger); padding:10px 12px; border-radius:8px; margin-bottom:12px; }
</style></head><body><main><div class="logo"><span>◆</span>lendmyai</div><h1>${esc(title)}</h1>${body}</main></body></html>`;
  return new Response(html, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Frame-Options": "DENY" } });
}

// ---------- MCP endpoint ----------

async function mcp(req: Request, origin: string, env: ConnectorEnv): Promise<Response> {
  const who = await verifyAccess(env.SESSION_SECRET, req.headers.get("Authorization"));
  if (!who) {
    return json(401, { error: "invalid_token", error_description: "Connect lendmyai in Claude's connector settings." }, {
      "WWW-Authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
    });
  }
  if (req.method !== "POST") return json(405, { error: "Use POST." }, { Allow: "POST" });

  const body = await req.json().catch(() => undefined);
  if (!body) return json(400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
  const messages = Array.isArray(body) ? body : [body];
  const ctx = { who: { id: who.u, name: who.n }, github: who.g && who.t ? { login: who.g, token: who.t } : undefined, secret: env.SESSION_SECRET };

  const run = async () => (await Promise.all(messages.map((m) => handleMcpMessage(m, ctx, VERSION)))).filter(Boolean);
  // GitHub work happens as the lendmyai bot account.
  const replies = env.BOT_GITHUB_TOKEN
    ? await withToken(env.BOT_GITHUB_TOKEN, run)
    : await runWithoutBot(messages, ctx);

  if (!replies.length) return new Response(null, { status: 202, headers: CORS });
  return json(200, Array.isArray(body) ? replies : replies[0]);
}

/** Before the bot account is configured, the connector still connects but tools explain why they can't run. */
async function runWithoutBot(messages: any[], ctx: { who: { id: string; name: string } }) {
  return (await Promise.all(messages.map(async (m) => {
    if (m?.method === "tools/call" && m.id != null) {
      return { jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "lendmyai isn't fully set up yet (the bot account is missing). Please try again later." }], isError: true } };
    }
    return handleMcpMessage(m, ctx, VERSION);
  }))).filter(Boolean);
}

// ---------- helpers ----------

/** The GitHub account signed in on lendmyai.com in this browser, if any. */
async function signedInGitHub(req: Request, env: ConnectorEnv): Promise<{ login: string; token: string } | undefined> {
  const token = await openSession(cookie(req, SESSION_COOKIE), env);
  if (!token) return undefined;
  const res = await fetch("https://api.github.com/user", {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "lendmyai" },
  });
  if (!res.ok) return undefined;
  const { login } = (await res.json()) as { login?: string };
  return login ? { login, token } : undefined;
}

function cookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.get("Cookie") ?? "").split(/;\s*/)) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i) === name) return part.slice(i + 1);
  }
  return undefined;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
