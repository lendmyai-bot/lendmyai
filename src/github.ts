import { AsyncLocalStorage } from "node:async_hooks";
import type { Comment } from "./protocol.js";

// This module runs both in Node (CLI, local app) and in the Cloudflare Worker
// (website). The website serves many users at once, so the token is scoped to
// the current request via withToken(); the CLI sets one process-wide fallback.

const API = "https://api.github.com";

interface RequestAuth {
  token: string;
  /** Signed-out website visitor, served with the site's read-only token. */
  anonymous: boolean;
}

const requestAuth = new AsyncLocalStorage<RequestAuth>();
let fallbackToken: (() => string) | undefined;

export function withToken<T>(token: string, fn: () => Promise<T>, opts: { anonymous?: boolean } = {}): Promise<T> {
  return requestAuth.run({ token, anonymous: !!opts.anonymous }, fn);
}

/** True when the current request has no signed-in user, so permission checks must not use the token's owner. */
export function isAnonymous(): boolean {
  return requestAuth.getStore()?.anonymous ?? false;
}

export function setFallbackToken(provider: () => string): void {
  fallbackToken = provider;
}

export function getToken(): string {
  const token = requestAuth.getStore()?.token ?? fallbackToken?.();
  if (!token) throw new GitHubError(401, "Not signed in to GitHub.");
  return token;
}

export class GitHubError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path.startsWith("http") ? path : API + path, {
    method,
    headers: {
      Authorization: `Bearer ${getToken()}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "lendmyai",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  if (!res.ok) {
    let msg = text;
    try {
      msg = JSON.parse(text).message ?? text;
    } catch {}
    throw new GitHubError(res.status, `GitHub ${method} ${path} failed (${res.status}): ${msg}`);
  }
  return text ? JSON.parse(text) : (undefined as T);
}

async function paginate<T>(path: string): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; ; page++) {
    const sep = path.includes("?") ? "&" : "?";
    const items = await api<T[]>("GET", `${path}${sep}per_page=100&page=${page}`);
    out.push(...items);
    if (items.length < 100) return out;
  }
}

export async function graphql<T = any>(query: string, variables: object): Promise<T> {
  const res = await api<{ data: T; errors?: { message: string }[] }>("POST", "/graphql", { query, variables });
  if (res.errors?.length) throw new Error(`GitHub GraphQL: ${res.errors.map((e) => e.message).join("; ")}`);
  return res.data;
}

export async function me(): Promise<string> {
  return (await api<{ login: string }>("GET", "/user")).login;
}

export async function getComments(owner: string, repo: string, number: number): Promise<Comment[]> {
  const raw = await paginate<any>(`/repos/${owner}/${repo}/issues/${number}/comments`);
  return raw.map((c) => ({
    id: c.id,
    user: c.user.login,
    association: c.author_association,
    createdAt: c.created_at,
    body: c.body ?? "",
  }));
}

export async function postComment(owner: string, repo: string, number: number, body: string): Promise<number> {
  return (await api<{ id: number }>("POST", `/repos/${owner}/${repo}/issues/${number}/comments`, { body })).id;
}

export async function deleteComment(owner: string, repo: string, id: number): Promise<void> {
  await api("DELETE", `/repos/${owner}/${repo}/issues/comments/${id}`);
}

export async function prStateFetcher(owner: string, repo: string, prs: number[]) {
  const states = new Map<number, "open" | "merged" | "closed">();
  for (const n of new Set(prs)) {
    const pr = await api<any>("GET", `/repos/${owner}/${repo}/pulls/${n}`);
    states.set(n, pr.state === "open" ? "open" : pr.merged_at ? "merged" : "closed");
  }
  return (n: number) => states.get(n) ?? "open";
}
