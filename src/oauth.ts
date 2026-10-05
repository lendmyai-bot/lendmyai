// OAuth 2.1 authorization server for the lendmyai Claude connector (MCP).
//
// Contributors don't need GitHub or an email: connecting Claude to lendmyai
// creates a contributor identity ("lendmyai:<id>" plus a display name). Every
// artifact (registered client IDs, authorization codes, access and refresh
// tokens) is a sealed AES-GCM blob, so the server stores nothing.

const enc = new TextEncoder();

export type Kind = "client" | "code" | "access" | "refresh" | "contributor" | "ownerkey";

/**
 * A connected contributor: id and display name, plus, for project owners who
 * linked GitHub, their login (g) and GitHub token (t) so Claude can post tasks
 * as them. Everything travels inside sealed tokens; nothing is stored.
 */
export interface Contributor { u: string; n: string; g?: string; t?: string }

const githubPart = (w: Contributor) => (w.g && w.t ? { g: w.g, t: w.t } : {});

export const ACCESS_SECONDS = 3600;
const REFRESH_SECONDS = 60 * 86400;
const CODE_SECONDS = 300;

export class OAuthError extends Error {
  constructor(public code: string, description: string, public status = 400) {
    super(description);
  }
}

function base64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

const keys = new Map<string, Promise<CryptoKey>>();
function keyFor(secret: string): Promise<CryptoKey> {
  if (secret.length < 32) throw new Error("OAuth secret must be at least 32 characters.");
  let k = keys.get(secret);
  if (!k) {
    k = crypto.subtle
      .digest("SHA-256", enc.encode(`${secret}:lendmyai-oauth`))
      .then((raw) => crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]));
    keys.set(secret, k);
  }
  return k;
}

export async function seal(secret: string, kind: Kind, payload: object, ttlSeconds?: number): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const body = { ...payload, k: kind, ...(ttlSeconds ? { exp: Date.now() + ttlSeconds * 1000 } : {}) };
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await keyFor(secret), enc.encode(JSON.stringify(body))));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return base64url(out);
}

/** Opens a sealed value of the expected kind; undefined if forged, expired or of another kind. */
export async function unseal<T = any>(secret: string, kind: Kind, value: string | null | undefined): Promise<T | undefined> {
  if (!value) return undefined;
  try {
    const bytes = fromBase64url(value);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(0, 12) }, await keyFor(secret), bytes.slice(12));
    const data = JSON.parse(new TextDecoder().decode(plain));
    if (data.k !== kind || (data.exp && data.exp < Date.now())) return undefined;
    return data as T;
  } catch {
    return undefined;
  }
}

/** Claude's connector callbacks, plus loopback addresses for desktop and CLI clients. */
export function isAllowedRedirect(uri: string): boolean {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.protocol === "https:" && ["claude.ai", "claude.com"].includes(u.hostname)) return true;
  return u.protocol === "http:" && ["localhost", "127.0.0.1"].includes(u.hostname);
}

export function metadata(issuer: string) {
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["lendmyai"],
  };
}

/** Dynamic client registration (RFC 7591); the client ID itself carries the allowed redirect URIs. */
export async function registerClient(secret: string, body: any) {
  const redirects: unknown = body?.redirect_uris;
  if (!Array.isArray(redirects) || !redirects.length || !redirects.every((r) => typeof r === "string" && isAllowedRedirect(r))) {
    throw new OAuthError("invalid_redirect_uri", "Only Claude's connector redirect URIs are allowed.");
  }
  const name = String(body?.client_name ?? "Claude").slice(0, 80);
  return {
    client_id: await seal(secret, "client", { r: redirects, n: name }),
    client_name: name,
    redirect_uris: redirects,
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  };
}

export interface AuthorizeRequest {
  client_id: string;
  redirect_uri: string;
  state: string;
  code_challenge: string;
  clientName: string;
}

/** Validates an authorization request before showing the consent page. */
export async function checkAuthorize(secret: string, p: URLSearchParams | Record<string, string>): Promise<AuthorizeRequest> {
  const get = (k: string) => (p instanceof URLSearchParams ? p.get(k) : p[k]) ?? "";
  const client = await unseal<{ r: string[]; n: string }>(secret, "client", get("client_id"));
  if (!client) throw new OAuthError("invalid_client", "Unknown client. Remove and re-add the lendmyai connector in Claude.");
  const redirect = get("redirect_uri") || (client.r.length === 1 ? client.r[0] : "");
  if (!client.r.includes(redirect)) throw new OAuthError("invalid_request", "redirect_uri doesn't match the registered client.");
  if (get("response_type") !== "code") throw new OAuthError("unsupported_response_type", "Only response_type=code is supported.");
  if (!get("code_challenge") || get("code_challenge_method") !== "S256") throw new OAuthError("invalid_request", "PKCE with S256 is required.");
  return { client_id: get("client_id"), redirect_uri: redirect, state: get("state"), code_challenge: get("code_challenge"), clientName: client.n };
}

export function newContributor(name: string): Contributor {
  const id = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, "0")).join("");
  return { u: `lendmyai:${id}`, n: cleanName(name) };
}

export function cleanName(name: string): string {
  const n = name.replace(/[\u0000-\u001f<>*_`\[\]#@\\]/g, "").replace(/\s+/g, " ").trim().slice(0, 40);
  if (n.length < 2) throw new OAuthError("invalid_request", "Please enter a name of at least 2 characters.");
  return n;
}

export async function issueCode(secret: string, req: AuthorizeRequest, who: Contributor): Promise<string> {
  const code = await seal(secret, "code", { c: req.client_id, r: req.redirect_uri, ch: req.code_challenge, u: who.u, n: who.n, ...githubPart(who) }, CODE_SECONDS);
  const url = new URL(req.redirect_uri);
  url.searchParams.set("code", code);
  if (req.state) url.searchParams.set("state", req.state);
  return url.toString();
}

async function tokens(secret: string, who: Contributor, clientId: string) {
  return {
    access_token: await seal(secret, "access", { u: who.u, n: who.n, ...githubPart(who) }, ACCESS_SECONDS),
    token_type: "Bearer",
    expires_in: ACCESS_SECONDS,
    refresh_token: await seal(secret, "refresh", { u: who.u, n: who.n, ...githubPart(who), c: clientId }, REFRESH_SECONDS),
    scope: "lendmyai",
  };
}

async function pkceMatches(verifier: string, challenge: string): Promise<boolean> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(verifier)));
  return base64url(digest) === challenge;
}

/** Token endpoint: authorization_code (with PKCE) and refresh_token grants. */
export async function exchange(secret: string, form: URLSearchParams) {
  const grant = form.get("grant_type");
  if (grant === "authorization_code") {
    const code = await unseal<Contributor & { c: string; r: string; ch: string }>(secret, "code", form.get("code"));
    if (!code) throw new OAuthError("invalid_grant", "Authorization code is invalid or expired.");
    if (form.get("client_id") && form.get("client_id") !== code.c) throw new OAuthError("invalid_grant", "Code was issued to another client.");
    if (form.get("redirect_uri") && form.get("redirect_uri") !== code.r) throw new OAuthError("invalid_grant", "redirect_uri mismatch.");
    if (!(await pkceMatches(form.get("code_verifier") ?? "", code.ch))) throw new OAuthError("invalid_grant", "PKCE verification failed.");
    return tokens(secret, { u: code.u, n: code.n, g: code.g, t: code.t }, code.c);
  }
  if (grant === "refresh_token") {
    const r = await unseal<Contributor & { c: string }>(secret, "refresh", form.get("refresh_token"));
    if (!r) throw new OAuthError("invalid_grant", "Refresh token is invalid or expired.");
    return tokens(secret, { u: r.u, n: r.n, g: r.g, t: r.t }, r.c);
  }
  throw new OAuthError("unsupported_grant_type", "Use authorization_code or refresh_token.");
}

export async function verifyAccess(secret: string, header: string | null): Promise<Contributor | undefined> {
  const token = header?.match(/^Bearer\s+(.+)$/i)?.[1];
  const data = await unseal<Contributor>(secret, "access", token);
  return data && { u: data.u, n: data.n, ...githubPart(data) };
}
