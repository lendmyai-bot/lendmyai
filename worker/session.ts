// Website sign-in session: an AES-GCM encrypted GitHub token in an HttpOnly
// cookie. Shared by the website API and the connector consent page, which
// recognises owners who are signed in on lendmyai.com.

export interface SessionEnv { SESSION_SECRET: string }

export const SESSION_COOKIE = "lmai_session";
export const SESSION_DAYS = 30;

// ---------- session cookie: AES-GCM encrypted GitHub token ----------

export async function sessionKey(env: SessionEnv): Promise<CryptoKey> {
  if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32) throw new Error("SESSION_SECRET must be set (32+ characters).");
  const raw = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(env.SESSION_SECRET));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function sealSession(token: string, env: SessionEnv): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = new TextEncoder().encode(JSON.stringify({ t: token, exp: Date.now() + SESSION_DAYS * 86400_000 }));
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await sessionKey(env), plain));
  const out = new Uint8Array(iv.length + sealed.length);
  out.set(iv);
  out.set(sealed, iv.length);
  return base64url(out);
}

export async function openSession(value: string | undefined, env: SessionEnv): Promise<string | undefined> {
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

export function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64url(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export function cookie(req: Request, name: string): string | undefined {
  const header = req.headers.get("Cookie") ?? "";
  for (const part of header.split(/;\s*/)) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i) === name) return part.slice(i + 1);
  }
  return undefined;
}

export function setCookie(name: string, value: string, maxAge: number): string {
  return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

export function redirect(location: string, cookies: string[]): Response {
  const headers = new Headers({ Location: location });
  for (const c of cookies) headers.append("Set-Cookie", c);
  return new Response(null, { status: 302, headers });
}
