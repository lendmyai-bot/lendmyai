import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AGENTS, agentInfo } from "./agents.js";

// Stub CLIs on PATH: codex answers --version, gemini hangs, claude is missing.
const bin = mkdtempSync(join(tmpdir(), "lendmyai-info-"));
const stub = (name: string, body: string) => {
  writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
  chmodSync(join(bin, name), 0o755);
};
stub("codex", 'echo "codex 1.2.3"');
stub("gemini", "sleep 30");
process.env.PATH = `${bin}:/usr/bin:/bin`;

test("agentInfo lists every agent, with versions, default and install hints", () => {
  const info = agentInfo();
  assert.deepEqual(info.map((i) => i.name), AGENTS.map((a) => a.name));
  const by = Object.fromEntries(info.map((i) => [i.name, i]));
  assert.equal(by.claude.installed, false);
  assert.match(by.claude.install, /npm install/);
  assert.equal(by.codex.installed, true);
  assert.equal(by.codex.version, "codex 1.2.3");
  assert.equal(by.codex.isDefault, true);
  assert.equal(by.gemini.installed, true);
  assert.equal(by.gemini.version, undefined);
  assert.equal(by.gemini.isDefault, false);
  assert.equal(by.claude.streaming, true);
  assert.equal(by.claude.buildAndTest, true);
  assert.equal(by.codex.streaming, false);
  assert.equal(by.codex.buildAndTest, false);
});
