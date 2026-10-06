import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { installedAgents, resolveAgent, streamAgent } from "./agents.js";
import { HttpError, errorResponse, match, refOf, route, sharedRoutes, type Route } from "./api.js";
import { openBrowser } from "./auth.js";
import { me } from "./github.js";
import { loadTask, type Task } from "./tasks.js";
import { checkWorkable } from "./contribute.js";
import { pickTasks, startTasks, type AutoRun, type Outcome as AutoOutcome } from "./auto.js";
import { findPrs, mergePr, reviewPrs, type Outcome } from "./review.js";
import { attachImages, begin, buildPrompt, complete, defaultChoice, finishAutomatically, review, type Choice, type Review, type Workspace } from "./work.js";

// Local app: the shared website API plus agent runs on this computer. It binds
// to 127.0.0.1 only and rejects requests whose Host or Origin is not this
// server, so other websites open in the browser cannot drive it (it can start
// agents and post to GitHub as the user).

interface Job {
  id: string;
  ref: string;
  agent: string;
  status: "starting" | "running" | "review" | "completing" | "done" | "error";
  log: string[];
  review?: Review;
  defaultChoice?: Choice;
  result?: { message: string; url?: string };
  error?: string;
  startedAt: string;
  kill?: () => void;
  ctx?: { task: Task; ws: Workspace; login: string };
}

interface ReviewJob {
  id: string;
  repo: string;
  status: "running" | "done" | "error";
  log: string[];
  outcomes: Outcome[];
  error?: string;
  startedAt: string;
}

interface AutoJob {
  id: string;
  repo?: string;
  status: "running" | "done" | "error";
  log: string[];
  tasks: string[];
  outcomes: AutoOutcome[];
  error?: string;
  startedAt: string;
  run?: AutoRun;
}

const autos = new Map<string, AutoJob>();
const reviews = new Map<string, ReviewJob>();
const jobs = new Map<string, Job>();
let jobSeq = 0;

const activeJob = (ref: string) => [...jobs.values()].find((j) => j.ref === ref && !["done", "error"].includes(j.status));

const sharedTaskDetail = match(sharedRoutes, "GET", "/api/tasks/o/r/1")!.handler;

const localRoutes: Route[] = [
  route("GET", "/api/me", async () => ({ login: await me(), agents: installedAgents(), mode: "local" })),

  // Same as the shared task detail, plus the agent run in progress on this computer.
  route("GET", "/api/tasks/:owner/:repo/:n", async (p, b, u) => ({
    ...(await sharedTaskDetail(p, b, u) as object),
    jobId: activeJob(refOf(p[0], p[1], p[2]))?.id,
  })),

  route("POST", "/api/tasks/:owner/:repo/:n/run", async ([o, r, n], body) => {
    const ref = refOf(o, r, n);
    if (activeJob(ref)) throw new HttpError(409, "An agent is already running on this task.");
    const [login, task] = await Promise.all([me(), loadTask(o, r, Number(n))]);
    const force = !!body?.force;
    await checkWorkable(task, login, { force }).catch((e) => {
      throw new HttpError(400, e.message);
    });
    const agent = resolveAgent({ agent: body?.agent || undefined });

    const job: Job = { id: String(++jobSeq), ref, agent: agent.name, status: "starting", log: [], startedAt: new Date().toISOString() };
    jobs.set(job.id, job);
    const log = (line: string) => job.log.push(line);

    (async () => {
      const ws = await begin(task, login, agent.name, log, { force });
      job.ctx = { task, ws, login };
      log(`Workspace: ${ws.dir} (branch ${ws.branch})`);
      log(`Starting ${agent.name} (headless)…`);
      job.status = "running";
      const run = streamAgent(agent.streamCommand(buildPrompt(task, await attachImages(task, ws.dir))), ws.dir, log);
      job.kill = run.kill;
      const code = await run.done;
      job.kill = undefined;
      log(`${agent.name} exited with code ${code}.`);
      job.review = review(task, ws);
      job.defaultChoice = defaultChoice(job.review);
      // Nobody has to decide: the agent's verdict does. If posting fails the run stays open so the choice can be made by hand.
      job.status = "completing";
      try {
        job.result = await finishAutomatically(task, ws, login, job.agent, job.review, agent);
        log(`✓ ${job.result.message}${job.result.url ? `: ${job.result.url}` : ""}`);
        job.status = "done";
      } catch (e) {
        job.error = e instanceof Error ? e.message : String(e);
        job.status = "review";
      }
    })().catch((e) => {
      job.status = "error";
      job.error = e instanceof Error ? e.message : String(e);
    });

    return { jobId: job.id };
  }),

  // Contributors: find open tasks and work on a few at once, unattended (same as `lendmyai auto`).
  route("POST", "/api/auto", async (_p, body) => {
    const repo = typeof body?.repo === "string" && body.repo.includes("/") ? body.repo : undefined;
    if ([...autos.values()].some((j) => j.status === "running")) throw new HttpError(409, "AI is already working on tasks.");
    const agent = resolveAgent({ agent: body?.agent || undefined });
    const max = Math.min(Math.max(Number(body?.max ?? 3), 1), 10);
    const parallel = Math.min(Math.max(Number(body?.parallel ?? 2), 1), 5);
    const login = await me();
    const job: AutoJob = { id: String(++jobSeq), repo, status: "running", log: [], tasks: [], outcomes: [], startedAt: new Date().toISOString() };
    autos.set(job.id, job);
    (async () => {
      job.log.push(`Looking for open tasks${repo ? ` in ${repo}` : ""}…`);
      const tasks = await pickTasks(repo, login, max);
      job.tasks = tasks.map((t) => `${t.owner}/${t.repo}#${t.number}`);
      if (!tasks.length) job.log.push("No tasks are waiting for someone right now.");
      else {
        job.log.push(`Working on ${tasks.length} task(s) with ${agent.name}…`);
        job.run = startTasks(tasks, login, agent, (ref, line) => job.log.push(`[${ref}] ${line}`), parallel);
        job.outcomes = await job.run.done;
      }
      job.status = "done";
    })().catch((e) => {
      job.status = "error";
      job.error = e instanceof Error ? e.message : String(e);
    });
    return { autoId: job.id };
  }),

  route("GET", "/api/autos/:id", async ([id], _b, url) => {
    const job = getAuto(id);
    const since = Number(url.searchParams.get("since") ?? 0);
    const { run, log, ...rest } = job;
    return { ...rest, log: log.slice(since), logLength: log.length };
  }),

  route("POST", "/api/autos/:id/stop", async ([id]) => {
    await getAuto(id).run?.stop();
    return { ok: true };
  }),

  // Maintainers: review every pull request in review for one project and fix merge conflicts.
  route("POST", "/api/projects/:owner/:repo/review", async ([o, r], body) => {
    const repo = `${o}/${r}`;
    if ([...reviews.values()].some((j) => j.repo === repo && j.status === "running")) throw new HttpError(409, "A review is already running for this project.");
    const agent = resolveAgent({ agent: body?.agent || undefined, shell: false });
    const job: ReviewJob = { id: String(++jobSeq), repo, status: "running", log: [], outcomes: [], startedAt: new Date().toISOString() };
    reviews.set(job.id, job);
    (async () => {
      const prs = await findPrs(repo);
      if (!prs.length) job.log.push("No pull requests in review that you can merge.");
      else {
        job.log.push(`Reviewing ${prs.length} pull request(s) with ${agent.name}…`);
        job.outcomes = await reviewPrs(prs, agent, (ref, line) => job.log.push(`[${ref}] ${line}`));
      }
      job.status = "done";
    })().catch((e) => {
      job.status = "error";
      job.error = e instanceof Error ? e.message : String(e);
    });
    return { reviewId: job.id };
  }),

  route("GET", "/api/reviews/:id", async ([id], _b, url) => {
    const job = getReview(id);
    const since = Number(url.searchParams.get("since") ?? 0);
    return { ...job, log: job.log.slice(since), logLength: job.log.length };
  }),

  // Merges the pull requests this review found ready (approved, CI passing, no conflicts, unchanged since review).
  route("POST", "/api/reviews/:id/merge", async ([id]) => {
    const job = getReview(id);
    if (job.status !== "done") throw new HttpError(400, "The review is still running.");
    for (const o of job.outcomes.filter((x) => x.ready)) {
      await mergePr(o);
      job.log.push(o.merged ? `[${o.ref}] ✓ Merged` : `[${o.ref}] ✗ ${o.note}`);
    }
    return { ...job, log: [], logLength: job.log.length };
  }),

  route("GET", "/api/jobs", async () => [...jobs.values()].map(publicJob).reverse()),

  route("GET", "/api/jobs/:id", async ([id], _b, url) => {
    const job = getJob(id);
    const since = Number(url.searchParams.get("since") ?? 0);
    return { ...publicJob(job), log: job.log.slice(since), logLength: job.log.length };
  }),

  route("POST", "/api/jobs/:id/stop", async ([id]) => {
    getJob(id).kill?.();
    return { ok: true };
  }),

  route("POST", "/api/jobs/:id/finish", async ([id], body) => {
    const job = getJob(id);
    const choice = body?.choice as Choice;
    if (job.status !== "review" || !job.ctx || !job.review) throw new HttpError(400, "This run is not waiting for a decision.");
    if (!["pr", "checkpoint", "keep", "release"].includes(choice)) throw new HttpError(400, "Invalid choice.");
    job.status = "completing";
    try {
      const { task, ws, login } = job.ctx;
      job.result = await complete(task, ws, login, job.agent, choice, job.review);
      job.status = "done";
    } catch (e) {
      job.status = "review";
      throw e;
    }
    return publicJob(job);
  }),
];

const routes = [...localRoutes, ...sharedRoutes];

function getAuto(id: string): AutoJob {
  const job = autos.get(id);
  if (!job) throw new HttpError(404, "Not found.");
  return job;
}

function getReview(id: string): ReviewJob {
  const job = reviews.get(id);
  if (!job) throw new HttpError(404, "Review not found.");
  return job;
}

function getJob(id: string): Job {
  const job = jobs.get(id);
  if (!job) throw new HttpError(404, "Run not found.");
  return job;
}

function publicJob(j: Job) {
  const { kill, ctx, log, ...rest } = j;
  return { ...rest, running: !!kill };
}

const INDEX_HTML = new URL("../web/index.html", import.meta.url);

export function serve(port: number, opts: { open?: boolean } = {}): Server {
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const send = (status: number, data: unknown, type = "application/json") => {
      res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
      res.end(type === "application/json" ? JSON.stringify(data) : data);
    };
    try {
      // DNS-rebinding and cross-site request protection.
      if (!allowedHosts.has(req.headers.host ?? "")) return send(403, { error: "Forbidden host" });
      const origin = req.headers.origin;
      if (origin && !allowedHosts.has(origin.replace(/^https?:\/\//, ""))) return send(403, { error: "Forbidden origin" });

      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        // Read on every request so edits show up on reload.
        return send(200, readFileSync(INDEX_HTML, "utf8"), "text/html; charset=utf-8");
      }

      let body: any;
      if (req.method === "POST") {
        if (!req.headers["content-type"]?.startsWith("application/json")) return send(415, { error: "Expected JSON" });
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
      }

      const m = match(routes, req.method ?? "GET", url.pathname);
      if (!m) return send(404, { error: "Not found" });
      send(200, await m.handler(m.params, body, url));
    } catch (e) {
      const { status, error } = errorResponse(e);
      send(status, { error });
    }
  });

  server.listen(port, "127.0.0.1", () => {
    const url = `http://localhost:${port}`;
    console.log(`lendmyai is running at ${url}  (keep this window open; Ctrl+C to stop)`);
    if (opts.open) openBrowser(url);
  });
  return server;
}
