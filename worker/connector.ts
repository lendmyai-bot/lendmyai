import { withToken } from "../src/github.js";
import { handleMcpMessage } from "../src/mcp.js";
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

const VERSION = "0.4.0";
const CONTRIBUTOR_COOKIE = "lmai_contributor";
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Authorization, Content-Type, Mcp-Protocol-Version, Mcp-Session-Id", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" };

const json = (status: number, data: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...CORS, ...headers } });

export function isConnectorPath(path: string): boolean {
  return path === "/mcp" || path.startsWith("/oauth/") || path.startsWith("/.well-known/oauth-");
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
    return json(404, { error: "not_found" });
  } catch (e) {
    if (e instanceof OAuthError) return json(e.status, { error: e.code, error_description: e.message });
    return json(500, { error: "server_error", error_description: e instanceof Error ? e.message : String(e) });
  }
}

// ---------- consent page ----------

async function authorize(req: Request, url: URL, env: ConnectorEnv): Promise<Response> {
  const secret = env.SESSION_SECRET;
  const known = await unseal<Contributor>(secret, "contributor", cookie(req, CONTRIBUTOR_COOKIE));

  if (req.method === "GET") {
    let ar: AuthorizeRequest;
    try {
      ar = await checkAuthorize(secret, url.searchParams);
    } catch (e) {
      return page("Can't connect", `<p>${esc((e as Error).message)}</p>`, 400);
    }
    return page("Connect Claude to lendmyai", consentForm(ar, url.searchParams, known));
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
  } catch (e) {
    return page("Connect Claude to lendmyai", `<div class="error">${esc((e as Error).message)}</div>${consentForm(ar, form, known)}`, 400);
  }
  const location = await issueCode(secret, ar, who);
  const headers = new Headers({ Location: location });
  headers.append("Set-Cookie", `${CONTRIBUTOR_COOKIE}=${await seal(secret, "contributor", who)}; Path=/oauth; HttpOnly; Secure; SameSite=Lax; Max-Age=${365 * 86400}`);
  return new Response(null, { status: 302, headers });
}

function consentForm(ar: AuthorizeRequest, params: URLSearchParams, known?: Contributor): string {
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
    <p class="fine">No GitHub account needed: lendmyai's bot account delivers your work and credits you by this name.</p>`;
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
  const ctx = { who: { id: who.u, name: who.n } };

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
