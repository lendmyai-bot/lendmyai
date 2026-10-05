import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { test } from "node:test";
import { OAuthError, checkAuthorize, exchange, issueCode, newContributor, registerClient, seal, verifyAccess } from "./oauth.js";

const SECRET = "x".repeat(40);
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";

async function connect(verifier = randomBytes(32).toString("base64url")) {
  const client = await registerClient(SECRET, { redirect_uris: [REDIRECT], client_name: "Claude" });
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const ar = await checkAuthorize(SECRET, new URLSearchParams({
    client_id: client.client_id, redirect_uri: REDIRECT, response_type: "code", code_challenge: challenge, code_challenge_method: "S256", state: "st",
  }));
  const location = new URL(await issueCode(SECRET, ar, newContributor("Jane Doe")));
  return { client, verifier, code: location.searchParams.get("code")!, state: location.searchParams.get("state") };
}

const tokenForm = (o: Record<string, string>) => new URLSearchParams(o);

test("registration only accepts Claude and loopback redirect URIs", async () => {
  await assert.rejects(registerClient(SECRET, { redirect_uris: ["https://evil.example/cb"] }), OAuthError);
  await registerClient(SECRET, { redirect_uris: ["http://localhost:6274/callback"] });
});

test("full authorization code flow with PKCE yields a working access token", async () => {
  const { client, verifier, code, state } = await connect();
  assert.equal(state, "st");
  const tokens = await exchange(SECRET, tokenForm({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: client.client_id, redirect_uri: REDIRECT }));
  const who = await verifyAccess(SECRET, `Bearer ${tokens.access_token}`);
  assert.match(who!.u, /^lendmyai:[0-9a-f]{16}$/);
  assert.equal(who!.n, "Jane Doe");

  const refreshed = await exchange(SECRET, tokenForm({ grant_type: "refresh_token", refresh_token: tokens.refresh_token }));
  assert.equal((await verifyAccess(SECRET, `Bearer ${refreshed.access_token}`))!.u, who!.u);
});

test("wrong PKCE verifier is rejected", async () => {
  const { code } = await connect();
  await assert.rejects(exchange(SECRET, tokenForm({ grant_type: "authorization_code", code, code_verifier: "wrong" })), /PKCE/);
});

test("tokens can't be used as another kind or after tampering", async () => {
  const { verifier, code } = await connect();
  const tokens = await exchange(SECRET, tokenForm({ grant_type: "authorization_code", code, code_verifier: verifier }));
  assert.equal(await verifyAccess(SECRET, `Bearer ${tokens.refresh_token}`), undefined);
  assert.equal(await verifyAccess(SECRET, `Bearer ${tokens.access_token.slice(0, -2)}xx`), undefined);
  assert.equal(await verifyAccess("y".repeat(40), `Bearer ${tokens.access_token}`), undefined);
  // An authorization code is not an access token either.
  assert.equal(await verifyAccess(SECRET, `Bearer ${code}`), undefined);
});

test("expired access tokens are rejected", async () => {
  const expired = await seal(SECRET, "access", { u: "lendmyai:aaaaaaaaaaaaaaaa", n: "J" }, -1);
  assert.equal(await verifyAccess(SECRET, `Bearer ${expired}`), undefined);
});

test("authorize rejects a redirect URI the client didn't register", async () => {
  const client = await registerClient(SECRET, { redirect_uris: [REDIRECT] });
  await assert.rejects(checkAuthorize(SECRET, new URLSearchParams({
    client_id: client.client_id, redirect_uri: "https://claude.ai/other", response_type: "code", code_challenge: "x", code_challenge_method: "S256",
  })), /redirect_uri/);
});
