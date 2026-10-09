// Runs the compiled test files in dist/ with the Node test runner.
//
// The shell used to expand `dist/*.test.js`, but cmd.exe and PowerShell do not
// expand globs, so the pattern was passed through literally and no tests ran.
// Discovering the files here works the same in every shell.

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const testFiles = readdirSync("dist")
  .filter((name) => name.endsWith(".test.js"))
  .sort()
  .map((name) => join("dist", name));

if (testFiles.length === 0) {
  console.error("No compiled *.test.js files found in dist/.");
  process.exit(1);
}

const result = spawnSync(process.execPath, ["--test", ...testFiles], {
  stdio: "inherit",
});

if (result.error) {
  console.error(result.error);
  process.exit(1);
}
process.exit(result.status ?? 1);
