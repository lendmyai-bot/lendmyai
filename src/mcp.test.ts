import assert from "node:assert/strict";
import { test } from "node:test";
import { TOOLS, handleMcpMessage } from "./mcp.js";

const ctx = { who: { id: "lendmyai:abcdef0123456789", name: "Jane" } };
const call = (name: string, args: object, c: object = ctx) =>
  handleMcpMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, c as any, "test") as Promise<any>;

test("initialize negotiates a supported protocol version and gives instructions", async () => {
  const res: any = await handleMcpMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } }, ctx, "test");
  assert.equal(res.result.protocolVersion, "2025-03-26");
  assert.match(res.result.instructions, /create_tasks/);
});

test("notifications get no response", async () => {
  assert.equal(await handleMcpMessage({ jsonrpc: "2.0", method: "notifications/initialized" }, ctx, "test"), undefined);
});

test("contributor and owner tools are listed", () => {
  const names = TOOLS.map((t) => t.name);
  for (const n of ["start_task", "write_file", "submit_work", "my_projects", "explore_project", "create_tasks"]) assert.ok(names.includes(n), n);
});

test("owner tools explain how to link GitHub when it isn't linked", async () => {
  for (const name of ["my_projects", "create_tasks"]) {
    const res = await call(name, { project: "a/b", tasks: [{ title: "x", goal: "y", done_when: "z" }] });
    assert.equal(res.result.isError, true);
    assert.match(res.result.content[0].text, /needs your GitHub account/);
  }
});

test("bad task references are explained, not thrown", async () => {
  const res = await call("read_file", { task: "not-a-task", path: "README.md" });
  assert.equal(res.result.isError, true);
  assert.match(res.result.content[0].text, /owner\/repo#12/);
});

test("unknown methods return a JSON-RPC error", async () => {
  const res: any = await handleMcpMessage({ jsonrpc: "2.0", id: 9, method: "resources/list" }, ctx, "test");
  assert.equal(res.error.code, -32601);
});
