import { spawnSync } from "node:child_process";
import { getToken } from "./github.js";

// Supplies the GitHub token through a one-off credential helper so it is never
// written to .git/config or remote URLs.
const AUTH_ARGS = [
  "-c", "credential.helper=",
  "-c", 'credential.helper=!f() { echo username=x-access-token; echo "password=$AGENTBOARD_TOKEN"; }; f',
];

export function git(args: string[], cwd: string, opts: { quiet?: boolean; allowFail?: boolean } = {}): string {
  const res = spawnSync("git", [...AUTH_ARGS, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, AGENTBOARD_TOKEN: getToken(), GIT_TERMINAL_PROMPT: "0" },
    stdio: ["ignore", "pipe", opts.quiet ? "pipe" : "inherit"],
  });
  if (res.status !== 0 && !opts.allowFail) {
    throw new Error(`git ${args.join(" ")} failed${res.stderr ? `:\n${res.stderr}` : ""}`);
  }
  return res.status === 0 ? res.stdout.trim() : "";
}

export const repoUrl = (fullName: string) => `https://github.com/${fullName}.git`;
