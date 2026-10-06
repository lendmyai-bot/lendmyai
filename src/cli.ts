#!/usr/bin/env node
import { parseArgs } from "node:util";
import { AGENTS } from "./agents.js";
import { match, sharedRoutes } from "./api.js";
import { findToken, login, logout, useNodeAuth } from "./auth.js";
import { GitHubError, api, getComments, me, postComment } from "./github.js";
import { REPO_TOPIC, TASK_LABEL, marker, parseIssueRef } from "./protocol.js";
import { listTasks, loadTask, stateOf } from "./tasks.js";
import { serve } from "./server.js";
import { describeState } from "./ui.js";
import { auto } from "./auto.js";
import { work } from "./work.js";

const HELP = `lendmyai: lend your AI to open GitHub tasks.

  lendmyai                          Sign in if needed and open the app in your browser
  lendmyai serve [--port 4321]      Start the local app without opening a browser
  lendmyai login | logout           Sign in to / out of GitHub

Contributors
  lendmyai projects                 List projects looking for help
  lendmyai tasks [owner/repo]       List open agent tasks (all projects, or one project)
  lendmyai work <owner/repo#123>    Claim a task, run your agent on it, then open a PR or hand off
      --agent <${AGENTS.map((a) => a.name).join("|")}>   Agent CLI to use (default: first one installed)
      --agent-cmd "<cmd {prompt}>"    Any other agent, e.g. "aider --message {prompt}"
      --model <name>                  Model to use (passed to the agent and recorded on the PR as a tag)
      --effort <level>                Reasoning effort, e.g. low, medium, high (recorded as a tag too)
      --headless                      Run unattended (edits only, no shell approval prompts)
      --yes                           Skip confirmations
  lendmyai auto [owner/repo]        Find open tasks and work on several at once, unattended
      --parallel <n>                  Tasks to work on at the same time (default 2, max 5)
      --max <n>                       Stop after this many tasks (default 5)
      --dry-run                       Only list the tasks that would be picked up
      (also takes --agent, --agent-cmd, --model, --effort and --yes)
  lendmyai release <owner/repo#123> Give up your claim (maintainers can release any claim)

Maintainers
  lendmyai init <owner/repo>        Create the "${TASK_LABEL}" label and list the repo for discovery
  Then label any issue "${TASK_LABEL}" to publish it as a task.

Auth: \`lendmyai login\`, GITHUB_TOKEN, or an existing \`gh auth login\`.`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      agent: { type: "string" },
      "agent-cmd": { type: "string" },
      model: { type: "string" },
      effort: { type: "string" },
      headless: { type: "boolean" },
      yes: { type: "boolean", short: "y" },
      port: { type: "string", short: "p" },
      parallel: { type: "string" },
      max: { type: "string" },
      "dry-run": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [cmd, arg] = positionals;
  const port = Number(values.port ?? 4321);
  useNodeAuth();

  if (values.help || cmd === "help") return console.log(HELP);

  switch (cmd) {
    case undefined:
      if (!findToken()) await login();
      return serve(port, { open: true });
    case "login":
      return login();
    case "logout":
      return logout();
    case "projects": {
      const projects = (await match(sharedRoutes, "GET", "/api/projects")!.handler([], undefined, new URL("http://x"))) as any[];
      if (!projects.length) return console.log("No projects listed yet.");
      for (const p of projects) console.log(`${p.fullName.padEnd(40)} ${String(p.openTasks).padStart(3)} open  ${p.description}`);
      return;
    }
    case "tasks": {
      const tasks = await listTasks(arg);
      if (!tasks.length) return console.log("No open agent tasks found.");
      for (const t of tasks) console.log(`${t.ref.padEnd(40)} ${describeState(t.state).padEnd(34)} ${t.title}`);
      return;
    }
    case "work":
      if (!arg) throw new Error("Usage: lendmyai work <owner/repo#123>");
      return work(arg, { agent: values.agent, agentCmd: values["agent-cmd"], model: values.model, effort: values.effort, headless: values.headless, yes: values.yes });
    case "auto":
      return auto(arg, {
        agent: values.agent,
        agentCmd: values["agent-cmd"],
        model: values.model,
        effort: values.effort,
        yes: values.yes,
        parallel: values.parallel ? Number(values.parallel) : undefined,
        max: values.max ? Number(values.max) : undefined,
        dryRun: values["dry-run"],
      });
    case "release":
      if (!arg) throw new Error("Usage: lendmyai release <owner/repo#123>");
      return releaseCmd(arg);
    case "serve":
      return serve(port);
    case "init":
      if (!arg?.includes("/")) throw new Error("Usage: lendmyai init <owner/repo>");
      return init(arg);
    default:
      throw new Error(`Unknown command "${cmd}".\n\n${HELP}`);
  }
}

async function releaseCmd(ref: string): Promise<void> {
  const { owner, repo, number } = parseIssueRef(ref);
  const [login, task] = await Promise.all([me(), loadTask(owner, repo, number)]);
  const s = task.state;
  if (s.kind === "available") return console.log("Task is not claimed.");
  if (s.user !== login && !task.canPush) throw new Error(`Only @${s.user} or a maintainer can release this task.`);
  await postComment(owner, repo, number, `🤖 @${login} released this task.\n${marker("release", {})}`);
  const after = await stateOf(owner, repo, await getComments(owner, repo, number));
  console.log(`✓ Released. State: ${describeState(after)}`);
}

async function init(fullName: string): Promise<void> {
  try {
    await api("POST", `/repos/${fullName}/labels`, { name: TASK_LABEL, color: "5319e7", description: "Ready for an AI agent (lendmyai)" });
    console.log(`✓ Created label "${TASK_LABEL}"`);
  } catch (e) {
    if (!(e instanceof GitHubError && e.status === 422)) throw e;
    console.log(`✓ Label "${TASK_LABEL}" already exists`);
  }
  const { names } = await api<{ names: string[] }>("GET", `/repos/${fullName}/topics`);
  if (!names.includes(REPO_TOPIC)) await api("PUT", `/repos/${fullName}/topics`, { names: [...names, REPO_TOPIC] });
  console.log(`✓ Topic "${REPO_TOPIC}" set, so the repo shows up in \`lendmyai tasks\``);
  console.log(`
Next: label an issue "${TASK_LABEL}". Good tasks have
  - a clear goal and acceptance criteria ("done when…")
  - a scope one agent session can finish
  - CI that runs on pull requests, so every agent's PR is checked the same way`);
}

main().catch((e) => {
  console.error(`✗ ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
