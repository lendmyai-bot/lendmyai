import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AGENTS, resolveAgent } from "./agents.js";

// installed() shells out to `which`, so put stub executables for every agent on PATH.
const bin = mkdtempSync(join(tmpdir(), "lendmyai-agents-"));
for (const a of AGENTS) {
  const file = join(bin, a.bin);
  writeFileSync(file, "#!/bin/sh\n");
  chmodSync(file, 0o755);
}
process.env.PATH = `${bin}:/usr/bin:/bin`;

const byName = (name: string) => AGENTS.find((a) => a.name === name)!;

test("AGENTS lists claude, codex and gemini with the expected argv", () => {
  assert.deepEqual(AGENTS.map((a) => a.name), ["claude", "codex", "gemini"]);
  assert.deepEqual(byName("claude").interactive("hi"), ["hi"]);
  assert.deepEqual(byName("claude").headless("hi"), ["-p", "hi", "--permission-mode", "acceptEdits"]);
  assert.deepEqual(byName("codex").interactive("hi"), ["hi"]);
  assert.deepEqual(byName("codex").headless("hi"), ["exec", "--full-auto", "hi"]);
  assert.deepEqual(byName("gemini").interactive("hi"), ["-i", "hi"]);
  assert.deepEqual(byName("gemini").headless("hi"), ["-p", "hi", "--approval-mode", "auto_edit"]);
});

test("resolveAgent builds interactive and headless commands for every agent", () => {
  for (const a of AGENTS) {
    const r = resolveAgent({ agent: a.name, shell: false });
    assert.equal(r.name, a.name);
    assert.deepEqual(r.command("go", false), [a.bin, a.interactive("go")]);
    assert.deepEqual(r.command("go", true), [a.bin, a.headless("go")]);
  }
});

test("without an agent name the first installed one (claude) is used", () => {
  assert.equal(resolveAgent({}).name, "claude");
});

test("model flags are included only when a model is passed", () => {
  const flags: Record<string, string[]> = { claude: ["--model", "m1"], codex: ["-m", "m1"], gemini: ["-m", "m1"] };
  for (const a of AGENTS) {
    const withModel = resolveAgent({ agent: a.name, model: "m1", shell: false });
    assert.equal(withModel.model, "m1");
    assert.deepEqual(withModel.command("go", true)[1], [...flags[a.name], ...a.headless("go")]);
    assert.deepEqual(withModel.command("go", false)[1], [...flags[a.name], ...a.interactive("go")]);
    const without = resolveAgent({ agent: a.name, shell: false });
    assert.equal(without.model, undefined);
    assert.deepEqual(without.command("go", true)[1], a.headless("go"));
  }
});

test("shell tool flags are added to headless and stream runs but not interactive ones or with shell: false", () => {
  const claude = byName("claude");
  const shell = claude.shellArgs!();
  assert.equal(shell[0], "--allowedTools");

  const on = resolveAgent({ agent: "claude" });
  assert.deepEqual(on.command("go", true)[1], [...shell, ...claude.headless("go")]);
  assert.deepEqual(on.command("go", false)[1], claude.interactive("go"));
  assert.deepEqual(on.streamCommand("go").cmd[1], [...shell, ...claude.stream!.args("go")]);

  const off = resolveAgent({ agent: "claude", shell: false });
  assert.deepEqual(off.command("go", true)[1], claude.headless("go"));
  assert.deepEqual(off.streamCommand("go").cmd[1], claude.stream!.args("go"));
});

test("agents without shellArgs or a stream variant fall back to their headless argv", () => {
  const codex = resolveAgent({ agent: "codex" });
  assert.deepEqual(codex.command("go", true)[1], byName("codex").headless("go"));
  assert.deepEqual(codex.streamCommand("go").cmd, ["codex", byName("codex").headless("go")]);
  assert.equal(codex.streamCommand("go").format("a line"), "a line");
});

test("a custom command substitutes {prompt} or appends the prompt", () => {
  const withPlaceholder = resolveAgent({ custom: "aider --message {prompt} --yes", model: "x" });
  assert.equal(withPlaceholder.name, "aider");
  assert.equal(withPlaceholder.model, "x");
  assert.deepEqual(withPlaceholder.command("do it", true), ["aider", ["--message", "do it", "--yes"]]);
  assert.deepEqual(withPlaceholder.command("do it", false), ["aider", ["--message", "do it", "--yes"]]);

  const appended = resolveAgent({ custom: "mytool run" });
  assert.deepEqual(appended.command("do it", true), ["mytool", ["run", "do it"]]);
  assert.deepEqual(appended.streamCommand("do it").cmd, ["mytool", ["run", "do it"]]);
});

test("an unknown agent name throws a message naming the known agents", () => {
  assert.throws(() => resolveAgent({ agent: "nope" }), /Unknown agent "nope"\. Known: claude, codex, gemini/);
});
