import assert from "node:assert/strict";
import { test } from "node:test";
import { AGENTS } from "./agents.js";

const codex = AGENTS.find((a) => a.name === "codex")!;
const format = codex.stream!.format;

test("codex stream args request JSON output", () => {
  assert.deepEqual(codex.stream!.args("fix the bug"), ["exec", "--full-auto", "--json", "fix the bug"]);
});

test("formats an assistant message", () => {
  const line = JSON.stringify({ id: "0", msg: { type: "agent_message", message: " Looking at the file now. " } });
  assert.equal(format(line), "Looking at the file now.");
});

test("formats a shell command use", () => {
  const line = JSON.stringify({ id: "0", msg: { type: "exec_command_begin", command: ["bash", "-lc", "npm test"] } });
  assert.equal(format(line), "→ exec bash -lc npm test");
});

test("formats a patch application", () => {
  const line = JSON.stringify({ id: "0", msg: { type: "patch_apply_begin", changes: { "src/agents.ts": {} } } });
  assert.equal(format(line), "→ apply_patch src/agents.ts");
});

test("formats a final summary line", () => {
  const line = JSON.stringify({ id: "0", msg: { type: "task_complete", last_agent_message: "Done, tests pass." } });
  assert.equal(format(line), "■ Agent finished: Done, tests pass.");
});

test("hides events with no useful log line", () => {
  const line = JSON.stringify({ id: "0", msg: { type: "token_count", input_tokens: 42 } });
  assert.equal(format(line), null);
});

test("returns non-JSON lines unchanged", () => {
  assert.equal(format("plain CLI output that isn't JSON"), "plain CLI output that isn't JSON");
});
