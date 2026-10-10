import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { resolveAgent } from "./agents.js";
import { readSettings, writeSettings } from "./settings.js";

process.env.LENDMYAI_HOME = mkdtempSync(join(tmpdir(), "lendmyai-settings-"));

test("settings start empty and persist what is written", () => {
  assert.deepEqual(readSettings(), {});
  writeSettings({ agent: "codex", model: "gpt-5" });
  assert.deepEqual(readSettings(), { agent: "codex", model: "gpt-5" });
});

test("an empty string clears a field and other fields stay", () => {
  writeSettings({ agent: "gemini", model: "m" });
  writeSettings({ model: "" });
  assert.deepEqual(readSettings(), { agent: "gemini", model: undefined });
});

test("saved model is the default, an explicit model wins", () => {
  writeSettings({ agent: "", model: "saved-model" });
  assert.equal(resolveAgent({ custom: "echo {prompt}" }).model, "saved-model");
  assert.equal(resolveAgent({ custom: "echo {prompt}", model: "flag-model" }).model, "flag-model");
});

test("an unknown saved agent is ignored instead of breaking the run", () => {
  writeSettings({ agent: "not-a-real-agent", model: "" });
  assert.doesNotThrow(() => resolveAgent({ custom: "echo {prompt}" }));
  // Without a custom command it falls back to auto-detection, which only fails if no CLI is installed.
  try {
    resolveAgent({});
  } catch (e) {
    assert.match((e as Error).message, /No supported agent CLI found/);
  }
});
