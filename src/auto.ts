import { mkdirSync, createWriteStream } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveAgent, streamAgent, type ResolvedAgent } from "./agents.js";
import { checkWorkable, release } from "./contribute.js";
import { me } from "./github.js";
import { listTasks, loadTask, type Task } from "./tasks.js";
import { confirm, describeState } from "./ui.js";
import { begin, buildPrompt, complete, defaultChoice, review } from "./work.js";

// Batch mode for advanced users: finds tasks nobody is working on (including
// ones a previous contributor handed off) and runs the agent on several of them
// at once, unattended. Each task goes through the same steps as `lendmyai work`.

export interface AutoOptions {
  agent?: string;
  agentCmd?: string;
  model?: string;
  yes?: boolean;
  parallel?: number;
  max?: number;
  dryRun?: boolean;
}

const MAX_PARALLEL = 5;
const LOG_DIR = join(homedir(), ".lendmyai", "logs");

type Outcome = { ref: string; result: string };

export async function auto(repoFilter: string | undefined, opts: AutoOptions): Promise<void> {
  if (repoFilter && !repoFilter.includes("/")) throw new Error("Usage: lendmyai auto [owner/repo]");
  const parallel = Math.min(Math.max(Math.floor(opts.parallel ?? 2), 1), MAX_PARALLEL);
  const max = Math.max(Math.floor(opts.max ?? 5), 1);
  const login = await me();

  console.log(`Looking for open tasks${repoFilter ? ` in ${repoFilter}` : ""}…`);
  const tasks = await pickTasks(repoFilter, login, max);
  if (!tasks.length) return console.log("No tasks are waiting for someone right now.");

  console.log(`\n${tasks.length} task(s) to work on, ${Math.min(parallel, tasks.length)} at a time:`);
  for (const t of tasks) console.log(`  ${`${t.owner}/${t.repo}#${t.number}`.padEnd(40)} ${describeState(t.state).padEnd(20)} ${t.title}`);
  for (const t of tasks) for (const w of t.warnings) console.warn(`⚠  ${t.owner}/${t.repo}#${t.number}: ${w}`);
  if (opts.dryRun) return;

  const agent = resolveAgent({ agent: opts.agent, custom: opts.agentCmd, model: opts.model });
  if (!(await confirm(`\nClaim these and run ${agent.name} unattended (edits only, nothing is pushed until each run finishes)?`, opts.yes))) return;

  mkdirSync(LOG_DIR, { recursive: true });
  const active = new Set<{ kill(): void; task: Task }>();
  let stopping = false;
  process.once("SIGINT", async () => {
    stopping = true;
    console.log("\nStopping: releasing the tasks still running…");
    await Promise.allSettled([...active].map(async (a) => { a.kill(); await release(a.task, login, "interrupted"); }));
    process.exit(130);
  });

  const outcomes: Outcome[] = [];
  const queue = [...tasks];
  const runner = async () => {
    for (let task = queue.shift(); task && !stopping; task = queue.shift()) outcomes.push(await runOne(task, login, agent, active));
  };
  await Promise.all(Array.from({ length: Math.min(parallel, tasks.length) }, runner));

  console.log("\nSummary");
  for (const o of outcomes) console.log(`  ${o.ref.padEnd(40)} ${o.result}`);
  console.log(`Logs: ${LOG_DIR}`);
}

/** Open tasks that are free to take: available, resumable, or already claimed by this user. */
async function pickTasks(repoFilter: string | undefined, login: string, max: number): Promise<Task[]> {
  const out: Task[] = [];
  for (const s of await listTasks(repoFilter, 50)) {
    if (out.length >= max) break;
    if (s.state.kind === "in-review" || (s.state.kind === "claimed" && s.state.user !== login)) continue;
    const [fullName, number] = s.ref.split("#");
    const [owner, repo] = fullName.split("/");
    const task = await loadTask(owner, repo, Number(number));
    if (task.blocked || !task.open) continue;
    try {
      await checkWorkable(task, login, { allowMultiple: true });
    } catch {
      continue;
    }
    out.push(task);
  }
  return out;
}

async function runOne(task: Task, login: string, agent: ResolvedAgent, active: Set<{ kill(): void; task: Task }>): Promise<Outcome> {
  const ref = `${task.owner}/${task.repo}#${task.number}`;
  const log = (line: string) => console.log(`[${ref}] ${line}`);
  try {
    const ws = await begin(task, login, agent.name, log);
    const file = createWriteStream(join(LOG_DIR, `${task.owner}__${task.repo}__${task.number}.log`));
    const run = streamAgent(agent.streamCommand(buildPrompt(task)), ws.dir, (line) => {
      file.write(`${line}\n`);
      // Live progress: the first line of each step, shortened.
      log(`  ${line.split("\n")[0].slice(0, 110)}`);
    });
    const handle = { kill: run.kill, task };
    active.add(handle);
    log(`${agent.name} started`);
    const code = await run.done.finally(() => { active.delete(handle); file.end(); });

    const r = review(task, ws);
    if (!r.hasWork) {
      // Nothing to push: free the task and say why, so the owner and the contributor both see the agent's reason.
      const why = r.note.replace(/\s+/g, " ").replace(/@/g, "@\u200b").slice(0, 400);
      await release(task, login, `the agent made no changes: ${why}`);
      log(`no changes made: ${why}`);
      return { ref, result: `No changes made, task released. Agent said: ${why.slice(0, 160)}` };
    }
    // Unattended: finished work becomes a PR, partial work a checkpoint.
    const choice = defaultChoice(r);
    const done = await complete(task, ws, login, agent.name, choice, r, agent);
    log(`${done.message}${done.url ? `: ${done.url}` : ""}${code ? ` (agent exit code ${code})` : ""}`);
    return { ref, result: done.url ? `${done.message}: ${done.url}` : done.message };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(`failed: ${msg}`);
    await release(task, login, "run failed").catch(() => {});
    return { ref, result: `failed: ${msg.split("\n")[0]}` };
  }
}
