import { GitHubError, api, isAnonymous, me, postComment } from "./github.js";
import { PRIORITIES, REPO_TOPIC, TASK_LABEL, actorOf, marker, parseMarker, stripMarker } from "./protocol.js";
import {
  branchFor, buildCloudPrompt, checkWorkable, claim, claudeCodeUrl, findPushedWork, headRepo, postHandoff, prepareBranch, release, submitPullRequest,
} from "./contribute.js";
import { createTask, listProject, managedRepos } from "./projects.js";
import { listTasks, loadTask, maintainerNotes, type Task } from "./tasks.js";

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

const CLOUD_AGENT = "Claude (cloud)";

/** The signed-in user's own cloud claim on a task, or a 400 if they don't hold one. */
async function myCloudClaim(o: string, r: string, n: string) {
  const [login, task] = await Promise.all([me(), loadTask(o, r, Number(n))]);
  const s = task.state;
  if (s.kind !== "claimed" || s.user !== login || !s.repo) throw new HttpError(400, "You're not working on this task right now.");
  return { login, task, head: s.repo, since: s.since };
}

/** Lets the signed-in holder of a cloud claim reopen Claude with the same task. */
async function cloudSession(task: Task) {
  const s = task.state;
  if (s.kind !== "claimed" || !s.repo || s.user !== (await me())) return undefined;
  const branch = branchFor(task);
  return { head: s.repo, branch, claudeUrl: claudeCodeUrl(buildCloudPrompt(task, s.repo, branch), s.repo) };
}

/** GitHub timestamps are already ISO 8601 strings; normalise them and fall back to "" like the other optional fields. */
function isoDate(value: unknown): string {
  if (typeof value !== "string" || !value) return "";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString();
}

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
    updatedAt: isoDate(r.updated_at),
    createdAt: isoDate(r.created_at),
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
      return mk ? [{ kind: mk.kind, ...actorOf(c, mk.data), at: c.createdAt, text: stripMarker(c.body), data: mk.data }] : [];
    });
    return {
      ref: refOf(o, r, n),
      title: task.title,
      body: task.body,
      url: task.url,
      state: task.state,
      priority: task.priority,
      blocked: task.blocked,
      warnings: task.warnings,
      canPush: !isAnonymous() && task.canPush,
      notes: maintainerNotes(task),
      events,
      cloud: isAnonymous() ? undefined : await cloudSession(task),
    };
  }, { public: true }),

  // ---------- lending your AI through Claude Code in the cloud ----------

  route("POST", "/api/tasks/:owner/:repo/:n/start", async ([o, r, n], body) => {
    const [login, task] = await Promise.all([me(), loadTask(o, r, Number(n))]);
    const force = !!body?.force;
    await checkWorkable(task, login, { force }).catch((e) => {
      throw new HttpError(400, e.message);
    });
    const head = await headRepo(task);
    const branch = await prepareBranch(task, head, login);
    await claim(task, login, CLOUD_AGENT, head, { force });
    return { head, branch, claudeUrl: claudeCodeUrl(buildCloudPrompt(task, head, branch), head) };
  }),

  route("GET", "/api/tasks/:owner/:repo/:n/work", async ([o, r, n]) => {
    const { task, head, since } = await myCloudClaim(o, r, n);
    return { work: (await findPushedWork(task, head, since)) ?? null };
  }),

  route("POST", "/api/tasks/:owner/:repo/:n/submit", async ([o, r, n]) => {
    const { task, head, since, login } = await myCloudClaim(o, r, n);
    const work = await findPushedWork(task, head, since);
    if (!work) throw new HttpError(400, "Claude hasn't saved any changes yet. Wait until Claude says it's done, then try again.");
    const note = `### What changed\n${work.commits.map((c) => `- ${c}`).join("\n")}`;
    const pr = await submitPullRequest(task, head, work.branch, login, CLOUD_AGENT, note);
    return { prUrl: pr.html_url, pr: pr.number };
  }),

  route("POST", "/api/tasks/:owner/:repo/:n/giveup", async ([o, r, n]) => {
    const { task, head, since, login } = await myCloudClaim(o, r, n);
    const work = await findPushedWork(task, head, since);
    if (work) {
      const note = `Unfinished work so far:\n${work.commits.map((c) => `- ${c}`).join("\n")}`;
      await postHandoff(task, login, CLOUD_AGENT, head, work.branch, note);
      return { handedOff: true };
    }
    await release(task, login, "gave up");
    return { handedOff: false };
  }),

  route("POST", "/api/tasks/:owner/:repo/:n/release", async ([o, r, n]) => {
    const [login, task] = await Promise.all([me(), loadTask(o, r, Number(n))]);
    const s = task.state;
    if (s.kind === "available") throw new HttpError(400, "Task is not claimed.");
    if (s.user !== login && !task.canPush) throw new HttpError(403, `Only @${s.user} or a maintainer can release this task.`);
    await postComment(o, r, Number(n), `🤖 @${login} released this task.\n${marker("release", {})}`);
    return { ok: true };
  }),

  route("GET", "/api/repos", async () => managedRepos()),

  route("POST", "/api/repos/:owner/:repo/init", async ([o, r]) => {
    await listProject(`${o}/${r}`);
    return { ok: true };
  }),

  route("POST", "/api/repos/:owner/:repo/tasks", async ([o, r], body) => {
    if (!String(body?.title ?? "").trim()) throw new HttpError(400, "Title is required.");
    const priority = PRIORITIES.includes(body?.priority) ? body.priority : undefined;
    const issue = await createTask(`${o}/${r}`, { title: body.title, goal: body.goal, doneWhen: body.doneWhen, notes: body.notes, priority });
    return { ref: refOf(o, r, issue.number), url: issue.url };
  }),
];
