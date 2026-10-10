import assert from "node:assert/strict";
import { test } from "node:test";
import { AGENTS, formatGeminiEvent as format } from "./agents.js";

const gemini = AGENTS.find((a) => a.name === "gemini")!;

test("gemini streams stream-json with the same edit-only approval mode as its headless run", () => {
  assert.deepEqual(gemini.stream!.args("go"), ["-p", "go", "--approval-mode", "auto_edit", "--output-format", "stream-json"]);
  assert.ok(gemini.headless("go").includes("auto_edit"));
});

test("shows a tool use with its main argument", () => {
  const line = JSON.stringify({ type: "tool_use", tool_name: "read_file", tool_id: "1", parameters: { file_path: "src/a.ts" } });
  assert.equal(format(line), "→ read_file src/a.ts");
});

test("shows a shell command", () => {
  const line = JSON.stringify({ type: "tool_use", tool_name: "run_shell_command", parameters: { command: "npm test" } });
  assert.equal(format(line), "→ run_shell_command npm test");
});

test("hides successful tool results, shows failed ones", () => {
  assert.equal(format(JSON.stringify({ type: "tool_result", tool_id: "1", status: "success", output: "ok" })), null);
  assert.equal(format(JSON.stringify({ type: "tool_result", status: "error", error: { type: "X", message: "denied" } })), "✗ A tool failed: denied");
});

test("hides init and assistant text fragments", () => {
  assert.equal(format(JSON.stringify({ type: "init", model: "m" })), null);
  assert.equal(format(JSON.stringify({ type: "message", role: "assistant", content: "Hel", delta: true })), null);
});

test("shows errors and the final result", () => {
  assert.equal(format(JSON.stringify({ type: "error", severity: "error", message: "quota" })), "■ Agent error: quota");
  assert.equal(format(JSON.stringify({ type: "result", status: "success", stats: { duration_ms: 12400 } })), "■ Agent finished (success, 12s)");
});

test("non-JSON lines pass through unchanged", () => {
  assert.equal(format("plain output"), "plain output");
});
