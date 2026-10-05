import { createInterface } from "node:readline/promises";
import type { TaskState } from "./protocol.js";

export async function ask(question: string, fallback: string): Promise<string> {
  if (!process.stdin.isTTY) return fallback;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim().toLowerCase() || fallback;
  } finally {
    rl.close();
  }
}

export async function confirm(question: string, yes = false): Promise<boolean> {
  if (yes) return true;
  return (await ask(`${question} [Y/n] `, "y")).startsWith("y");
}

export function describeState(s: TaskState): string {
  const resume = s.handoff ? ` (resumable from @${s.handoff.user}'s ${s.handoff.repo}:${s.handoff.branch})` : "";
  switch (s.kind) {
    case "available":
      return `available${resume}`;
    case "claimed":
      return `claimed by @${s.user} (${s.agent}) until ${new Date(s.expires).toLocaleString()}`;
    case "in-review":
      return `in review: PR #${s.pr} by @${s.user}`;
  }
}
