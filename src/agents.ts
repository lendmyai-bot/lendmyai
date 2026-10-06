import { spawn, spawnSync } from "node:child_process";

// Each adapter turns a prompt into a command line for an agent CLI the
// contributor already has installed and logged in to with their own
// subscription. Adding an agent means adding one entry here.

/** A headless run whose output is streamed to a UI. */
export interface StreamRun {
  cmd: [string, string[]];
  /** Turns a raw output line into a log line (or null to hide it). */
  format: (line: string) => string | null;
}

export interface Agent {
  name: string;
  bin: string;
  /** Human-in-the-loop session: the contributor watches and approves actions. */
  interactive(prompt: string): string[];
  /** Unattended run, restricted to file edits / sandboxed where the agent supports it. */
  headless(prompt: string): string[];
  /** Optional headless variant with machine-readable progress, plus a formatter for each output line. */
  /** Flags that let an unattended run use a small set of safe-ish shell commands (build, test, read-only). */
  shellArgs?(): string[];
  /** Extra flags that select the model, for agents that support them. */
  modelArgs?(model?: string): string[];
  stream?: { args(prompt: string): string[]; format(line: string): string | null };
}

const CLAUDE_SHELL_TOOLS = ["npm", "npx", "node", "git status", "git diff", "git log", "ls", "cat", "grep"].map((c) => `Bash(${c}:*)`).join(",");

export const AGENTS: Agent[] = [
  {
    name: "claude",
    bin: "claude",
    interactive: (p) => [p],
    headless: (p) => ["-p", p, "--permission-mode", "acceptEdits"],
    modelArgs: (m) => (m ? ["--model", m] : []),
    shellArgs: () => ["--allowedTools", CLAUDE_SHELL_TOOLS],
    stream: {
      args: (p) => ["-p", p, "--permission-mode", "acceptEdits", "--output-format", "stream-json", "--verbose"],
      format: formatClaudeEvent,
    },
  },
  {
    name: "codex",
    bin: "codex",
    interactive: (p) => [p],
    headless: (p) => ["exec", "--full-auto", p],
    modelArgs: (m) => (m ? ["-m", m] : []),
  },
  {
    name: "gemini",
    bin: "gemini",
    interactive: (p) => ["-i", p],
    headless: (p) => ["-p", p, "--approval-mode", "auto_edit"],
    modelArgs: (m) => (m ? ["-m", m] : []),
  },
];

/** Which model a run used, recorded on the commit and pull request. */
export interface RunInfo {
  model?: string;
}

export interface ResolvedAgent extends RunInfo {
  name: string;
  command(prompt: string, headless: boolean): [string, string[]];
  /** Headless command for streaming output to a UI; `format` turns raw output lines into log lines. */
  streamCommand(prompt: string): StreamRun;
}

function installed(bin: string): boolean {
  return spawnSync("which", [bin], { stdio: "ignore" }).status === 0;
}

export function installedAgents(): string[] {
  return AGENTS.filter((a) => installed(a.bin)).map((a) => a.name);
}

/**
 * Resolves the agent to run. `custom` is a command template such as
 * "aider --message {prompt}"; without a {prompt} placeholder the prompt is appended.
 */
export function resolveAgent(opts: { agent?: string; custom?: string; model?: string; allowShell?: boolean }): ResolvedAgent {
  const { model } = opts;
  if (opts.custom) {
    const parts = opts.custom.trim().split(/\s+/);
    const command = (prompt: string): [string, string[]] => {
      const args = parts.slice(1);
      const withPrompt = args.includes("{prompt}") ? args.map((a) => (a === "{prompt}" ? prompt : a)) : [...args, prompt];
      return [parts[0], withPrompt];
    };
    // A custom command is run as written; the model is recorded only.
    return { name: parts[0], model, command, streamCommand: (p) => ({ cmd: command(p), format: (l) => l }) };
  }

  const candidates = opts.agent ? AGENTS.filter((a) => a.name === opts.agent) : AGENTS;
  if (opts.agent && !candidates.length) {
    throw new Error(`Unknown agent "${opts.agent}". Known: ${AGENTS.map((a) => a.name).join(", ")}, or use --agent-cmd.`);
  }
  const agent = candidates.find((a) => installed(a.bin));
  if (!agent) {
    throw new Error(opts.agent ? `"${opts.agent}" is not installed or not on PATH.` : `No supported agent CLI found (${AGENTS.map((a) => a.bin).join(", ")}). Install one or use --agent-cmd.`);
  }
  const extra = agent.modelArgs?.(model) ?? [];
  // Only for unattended runs: an interactive session asks the contributor instead.
  const unattended = opts.allowShell ? agent.shellArgs?.() ?? [] : [];
  return {
    name: agent.name,
    model,
    command: (prompt, headless) => [agent.bin, headless ? [...extra, ...unattended, ...agent.headless(prompt)] : [...extra, ...agent.interactive(prompt)]],
    streamCommand: (prompt) =>
      agent.stream
        ? { cmd: [agent.bin, [...extra, ...unattended, ...agent.stream.args(prompt)]], format: agent.stream.format }
        : { cmd: [agent.bin, [...extra, ...unattended, ...agent.headless(prompt)]], format: (l) => l },
  };
}

export function runAgent(cmd: [string, string[]], cwd: string): number {
  const res = spawnSync(cmd[0], cmd[1], { cwd, stdio: "inherit" });
  if (res.error) throw res.error;
  return res.status ?? 1;
}

/** Runs an agent without a terminal, passing each formatted output line to `onLine`. */
export function streamAgent(
  run: StreamRun,
  cwd: string,
  onLine: (line: string) => void,
): { done: Promise<number>; kill(): void } {
  const child = spawn(run.cmd[0], run.cmd[1], { cwd, stdio: ["ignore", "pipe", "pipe"] });
  const pipe = (stream: NodeJS.ReadableStream, format: (l: string) => string | null) => {
    let buf = "";
    const handle = (l: string) => {
      if (!l.trim()) return;
      const out = format(l);
      if (out) onLine(out);
    };
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      buf += chunk;
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const l of lines) handle(l);
    });
    stream.on("end", () => handle(buf));
  };
  pipe(child.stdout!, run.format);
  pipe(child.stderr!, (l) => l);
  const done = new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
  return { done, kill: () => child.kill("SIGTERM") };
}

function formatClaudeEvent(line: string): string | null {
  let ev: any;
  try {
    ev = JSON.parse(line);
  } catch {
    return line;
  }
  if (ev.type === "assistant") {
    return (ev.message?.content ?? [])
      .map((b: any) => {
        if (b.type === "text") return b.text.trim();
        if (b.type === "tool_use") {
          const i = b.input ?? {};
          const detail = i.file_path ?? i.command ?? i.pattern ?? i.path ?? i.description ?? "";
          return `→ ${b.name}${detail ? ` ${String(detail).slice(0, 160)}` : ""}`;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n") || null;
  }
  if (ev.type === "result") {
    const cost = typeof ev.total_cost_usd === "number" ? `, $${ev.total_cost_usd.toFixed(2)}` : "";
    return `■ Agent finished (${ev.num_turns ?? "?"} turns${cost})${ev.is_error ? `: ${ev.result}` : ""}`;
  }
  return null;
}
