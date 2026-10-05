import { GitHubError, api } from "./github.js";

// File access on a branch through the GitHub API, used when the bot account
// works on a fork for a contributor who connects through Claude. Text files only.

const MAX_READ_BYTES = 200_000;
const MAX_LIST = 1000;

function decodeBase64(b64: string): string {
  const bin = atob(b64.replace(/\s/g, ""));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

function encodeBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

const cleanPath = (p: string) => {
  const path = p.trim().replace(/^\/+/, "").replace(/\/+$/, "");
  if (path.split("/").some((seg) => seg === ".." || seg === ".")) throw new Error(`Invalid path "${p}".`);
  return path;
};
const encPath = (p: string) => p.split("/").map(encodeURIComponent).join("/");

export async function listFiles(repo: string, branch: string, under = ""): Promise<{ files: string[]; truncated: boolean }> {
  const prefix = cleanPath(under);
  const tree = await api<any>("GET", `/repos/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`);
  const all = (tree.tree as any[]).filter((e) => e.type === "blob").map((e) => e.path as string);
  const matching = prefix ? all.filter((p) => p === prefix || p.startsWith(prefix + "/")) : all;
  return { files: matching.slice(0, MAX_LIST), truncated: tree.truncated || matching.length > MAX_LIST };
}

async function getEntry(repo: string, branch: string, path: string): Promise<any | undefined> {
  try {
    return await api<any>("GET", `/repos/${repo}/contents/${encPath(path)}?ref=${encodeURIComponent(branch)}`);
  } catch (e) {
    if (e instanceof GitHubError && e.status === 404) return undefined;
    throw e;
  }
}

export async function readFile(repo: string, branch: string, p: string): Promise<string> {
  const path = cleanPath(p);
  const entry = await getEntry(repo, branch, path);
  if (!entry) throw new Error(`File not found: ${path}`);
  if (Array.isArray(entry)) throw new Error(`${path} is a folder. Use list_files to see what's inside.`);
  if (entry.size > MAX_READ_BYTES) throw new Error(`${path} is too large to read (${entry.size} bytes).`);
  if (entry.encoding !== "base64" || typeof entry.content !== "string") throw new Error(`${path} can't be read as text.`);
  return decodeBase64(entry.content);
}

/** Creates or replaces a file with one commit on the branch. */
export async function writeFile(repo: string, branch: string, p: string, content: string, message: string): Promise<void> {
  const path = cleanPath(p);
  if (!path) throw new Error("A file path is required.");
  const existing = await getEntry(repo, branch, path);
  if (Array.isArray(existing)) throw new Error(`${path} is a folder.`);
  await api("PUT", `/repos/${repo}/contents/${encPath(path)}`, {
    message,
    content: encodeBase64(content),
    branch,
    ...(existing ? { sha: existing.sha } : {}),
  });
}

export async function deleteFile(repo: string, branch: string, p: string, message: string): Promise<void> {
  const path = cleanPath(p);
  const existing = await getEntry(repo, branch, path);
  if (!existing || Array.isArray(existing)) throw new Error(`File not found: ${path}`);
  await api("DELETE", `/repos/${repo}/contents/${encPath(path)}`, { message, sha: existing.sha, branch });
}
