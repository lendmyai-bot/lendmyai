import { spawnSync } from "node:child_process";
import { getToken } from "./github.js";

// Supplies the GitHub token through a one-off credential helper so it is never
// written to .git/config or remote URLs.
//
// The helper uses POSIX shell syntax. Git runs any `!` helper through `sh -c`, and
// Git for Windows ships its own sh.exe (Git\usr\bin) for exactly that, so this should
// work there without a separate helper script: it uses only `echo` and an environment
// variable, which the shell inherits from the env set in git() below.
// NOT yet verified on a real Windows machine. To check, run in cmd or PowerShell:
//   set AGENTBOARD_TOKEN=test && git -c credential.helper= -c "credential.helper=!f() { echo username=x-access-token; echo password=$AGENTBOARD_TOKEN; }; f" credential fill
// (then type protocol=https and host=github.com, and a blank line) and expect
// password=test in the output. If it fails, replace this with a small helper script
// passed as `credential.helper=<path>`.
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
