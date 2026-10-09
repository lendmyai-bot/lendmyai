import assert from "node:assert/strict";
import { test } from "node:test";
import { AGENTS } from "./agents.js";

const codex = AGENTS.find((a) => a.name === "codex")!;
const fmt = (ev: unknown) => codex.stream!.format(typeof ev === "string" ? ev : JSON.stringify(ev));

test("codex stream runs exec with JSON events on", () => {
  const args = codex.stream!.args("fix the bug");
  assert.ok(args.includes("--json"));
  assert.equal(args[0], "exec");
  assert.equal(args.at(-1), "fix the bug");
});

test("codex assistant text is shown as one line", () => {
  assert.equal(fmt({ type: "item.completed", item: { id: "1", type: "agent_message", text: "  Fixed the parser.\n" } }), "Fixed the parser.");
});

test("codex command starts are shown, and their completion is not repeated", () => {
  assert.equal(fmt({ type: "item.started", item: { id: "2", type: "command_execution", command: "npm test", status: "in_progress" } }), "→ shell npm test");
  assert.equal(fmt({ type: "item.completed", item: { id: "2", type: "command_execution", command: "npm test", exit_code: 0, status: "completed" } }), null);
});

test("codex file changes list the touched paths", () => {
  assert.equal(
    fmt({ type: "item.completed", item: { id: "3", type: "file_change", changes: [{ path: "src/a.ts", kind: "update" }, { path: "src/b.ts", kind: "add" }] } }),
    "→ edit src/a.ts, src/b.ts",
  );
});

test("codex MCP tool calls and web searches are announced", () => {
  assert.equal(fmt({ type: "item.started", item: { id: "4", type: "mcp_tool_call", server: "github", tool: "get_issue" } }), "→ github.get_issue");
  assert.equal(fmt({ type: "item.started", item: { id: "5", type: "web_search", query: "codex exec json" } }), "→ web_search codex exec json");
});

test("codex turn completion gives a final summary line with token count", () => {
  assert.equal(fmt({ type: "turn.completed", usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 50 } }), "■ Agent finished (150 tokens)");
});

test("codex turn failure is reported with its message", () => {
  assert.equal(fmt({ type: "turn.failed", error: { message: "rate limited" } }), "■ Agent failed: rate limited");
});

test("codex bookkeeping events and reasoning are hidden", () => {
  assert.equal(fmt({ type: "thread.started", thread_id: "t1" }), null);
  assert.equal(fmt({ type: "turn.started" }), null);
  assert.equal(fmt({ type: "item.completed", item: { id: "6", type: "reasoning", text: "thinking" } }), null);
});

test("codex lines that are not JSON are returned unchanged", () => {
  assert.equal(fmt("plain stderr warning"), "plain stderr warning");
});
