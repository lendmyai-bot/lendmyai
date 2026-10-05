import { GitHubError, api, isAnonymous, me, postComment } from "./github.js";
import { REPO_TOPIC, TASK_LABEL, marker, parseMarker, stripMarker } from "./protocol.js";
import { listTasks, loadTask, maintainerNotes } from "./tasks.js";

// JSON API shared by the local app (src/server.ts) and the website
// (worker/worker.ts). Everything here only talks to GitHub, so it runs in both
// Node and Cloudflare Workers. Agent runs exist only in the local app.

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export type Handler = (params: string[], body: any, url: URL) => Promise<unknown>;
/** `isPublic` routes only read public data, so the website serves them to signed-out visitors too. */
export type Route = [method: string, pattern: RegExp, handler: Handler, isPublic: boolean];

export function route(method: string, pattern: string, handler: Handler, opts: { public?: boolean } = {}): Route {
  return [method, new RegExp(`^${pattern.replace(/:(\w+)/g, "([^/]+)")}$`), handler, !!opts.public];
}

export function match(routes: Route[], method: string, pathname: string): { handler: Handler; params: string[]; isPublic: boolean } | null {
  for (const [m, re, handler, isPublic] of routes) {
    const res = re.exec(pathname);
    if (res && m === method) return { handler, params: res.slice(1).map(decodeURIComponent), isPublic };
  }
  return null;
}

/** Maps an error to an HTTP status and message. */
export function errorResponse(e: unknown): { status: number; error: string } {
  const status = e instanceof HttpError ? e.status : e instanceof GitHubError ? (e.status >= 500 ? 502 : e.status) : 500;
  return { status, error: e instanceof Error ? e.message : String(e) };
}

export const refOf = (o: string, r: string, n: string | number) => `${o}/${r}#${n}`;

// A project is a public repo with the lendmyai topic; its tasks are its open
// issues labeled agent-task.
function projectSummary(r: any, openTasks: number) {
  return {
    fullName: r.full_name,
    description: r.description ?? "",
    language: r.language ?? "",
    stars: r.stargazers_count ?? 0,
    avatar: r.owner?.avatar_url ?? "",
    url: r.html_url,
    openTasks,
  };
}

export const sharedRoutes: Route[] = [
  route("GET", "/api/projects", async () => {
    const [repos, issues] = await Promise.all([
      api<any>("GET", `/search/repositories?q=${encodeURIComponent(`topic:${REPO_TOPIC} is:public archived:false`)}&sort=updated&per_page=60`),
      api<any>("GET", `/search/issues?q=${encodeURIComponent(`is:issue is:open label:${TASK_LABEL}`)}&per_page=100`),
    ]);
    const counts = new Map<string, number>();
    for (const i of issues.items) {
      const full = i.repository_url.replace("https://api.github.com/repos/", "");
      counts.set(full, (counts.get(full) ?? 0) + 1);
    }
    return repos.items.map((r: any) => projectSummary(r, counts.get(r.full_name) ?? 0));
  }, { public: true }),

  route("GET", "/api/projects/:owner/:repo", async ([o, r]) => {
    const full = `${o}/${r}`;
    const closedQ = `is:issue is:closed label:${TASK_LABEL} repo:${full}`;
    const [repo, tasks, closed] = await Promise.all([
      api<any>("GET", `/repos/${full}`),
      listTasks(full, 100),
      api<any>("GET", `/search/issues?q=${encodeURIComponent(closedQ)}&per_page=1`),
    ]);
    return {
      ...projectSummary(repo, tasks.length),
      listed: (repo.topics ?? []).includes(REPO_TOPIC),
      canManage: !isAnonymous() && !!(repo.permissions?.triage || repo.permissions?.push),
      completedTasks: closed.total_count ?? 0,
      tasks,
    };
  }, { public: true }),

  route("POST", "/api/projects/:owner/:repo/unlist", async ([o, r]) => {
    const full = `${o}/${r}`;
    const { names } = await api<{ names: string[] }>("GET", `/repos/${full}/topics`);
    await api("PUT", `/repos/${full}/topics`, { names: names.filter((n) => n !== REPO_TOPIC) });
    return { ok: true };
  }),

  route("GET", "/api/tasks", async (_p, _b, url) => listTasks(url.searchParams.get("repo") || undefined), { public: true }),

  route("GET", "/api/tasks/:owner/:repo/:n", async ([o, r, n]) => {
    const task = await loadTask(o, r, Number(n));
    const events = task.comments.flatMap((c) => {
      const mk = parseMarker(c.body);
      return mk ? [{ kind: mk.kind, user: c.user, at: c.createdAt, text: stripMarker(c.body), data: mk.data }] : [];
    });
    return {
      ref: refOf(o, r, n),
      title: task.title,
      body: task.body,
      url: task.url,
      state: task.state,
      blocked: task.blocked,
      warnings: task.warnings,
      canPush: !isAnonymous() && task.canPush,
      notes: maintainerNotes(task),
      events,
    };
  }, { public: true }),

  route("POST", "/api/tasks/:owner/:repo/:n/release", async ([o, r, n]) => {
    const [login, task] = await Promise.all([me(), loadTask(o, r, Number(n))]);
    const s = task.state;
    if (s.kind === "available") throw new HttpError(400, "Task is not claimed.");
    if (s.user !== login && !task.canPush) throw new HttpError(403, `Only @${s.user} or a maintainer can release this task.`);
    await postComment(o, r, Number(n), `🤖 @${login} released this task.\n${marker("release", {})}`);
    return { ok: true };
  }),

  route("GET", "/api/repos", async () => {
    const repos = await api<any[]>("GET", "/user/repos?affiliation=owner,collaborator,organization_member&sort=updated&per_page=100");
    return repos
      .filter((r) => !r.private && (r.permissions?.triage || r.permissions?.push))
      .map((r) => ({ fullName: r.full_name, listed: (r.topics ?? []).includes(REPO_TOPIC) }));
  }),

  route("POST", "/api/repos/:owner/:repo/init", async ([o, r]) => {
    const full = `${o}/${r}`;
    try {
      await api("POST", `/repos/${full}/labels`, { name: TASK_LABEL, color: "5319e7", description: "Ready for an AI agent (lendmyai)" });
    } catch (e) {
      if (!(e instanceof GitHubError && e.status === 422)) throw e;
    }
    const { names } = await api<{ names: string[] }>("GET", `/repos/${full}/topics`);
    if (!names.includes(REPO_TOPIC)) await api("PUT", `/repos/${full}/topics`, { names: [...names, REPO_TOPIC] });
    return { ok: true };
  }),

  route("POST", "/api/repos/:owner/:repo/tasks", async ([o, r], body) => {
    const title = String(body?.title ?? "").trim();
    if (!title) throw new HttpError(400, "Title is required.");
    const section = (h: string, v: unknown) => (String(v ?? "").trim() ? `## ${h}\n${String(v).trim()}\n` : "");
    const text = [section("Goal", body.goal), section("Done when", body.doneWhen), section("Notes", body.notes)].filter(Boolean).join("\n");
    const issue = await api<any>("POST", `/repos/${o}/${r}/issues`, { title, body: text, labels: [TASK_LABEL] });
    return { ref: refOf(o, r, issue.number), url: issue.html_url };
  }),
];
