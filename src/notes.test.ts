import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { marker } from "./protocol.js";
import { noteImageUrls, type Task } from "./tasks.js";

// Settings live under the home directory; keep the tests away from the real one.
process.env.HOME = mkdtempSync(join(tmpdir(), "lendmyai-test-"));

const note = (text: string) => ({
  id: 1, user: "owner", association: "OWNER", createdAt: "2026-10-05T10:00:00Z",
  body: `📝 @owner added a note for the next attempt:\n\n${text}\n${marker("note", {})}`,
});

test("only images lendmyai stored are fetched for the agent", () => {
  const task = {
    comments: [
      note("![a](https://raw.githubusercontent.com/o/r/lendmyai-assets/lendmyai-assets/33/1-1.png) ![b](https://evil.example/x.png) ![c](https://raw.githubusercontent.com/o/r/main/secret.png)"),
    ],
  } as unknown as Task;
  assert.deepEqual(noteImageUrls(task), ["https://raw.githubusercontent.com/o/r/lendmyai-assets/lendmyai-assets/33/1-1.png"]);
});

const taskFor = () => ({ owner: "o", repo: "r", number: 1, title: "T", body: "B", comments: [], state: { kind: "available" }, warnings: [] }) as unknown as Task;

test("the agent prompt carries the ponytail rules, framed as how rather than whether", async () => {
  const { buildPrompt } = await import("./work.js");
  const prompt = buildPrompt(taskFor());
  assert.match(prompt, /lazy senior developer/);
  assert.match(prompt, /decide HOW to implement it, not whether/);
});

test("ponytail can be switched off and on again", async () => {
  const { buildPrompt } = await import("./work.js");
  const { readSettings, writeSettings } = await import("./settings.js");
  assert.equal(readSettings().ponytail, true);
  writeSettings({ ponytail: false });
  assert.doesNotMatch(buildPrompt(taskFor()), /lazy senior developer/);
  writeSettings({ ponytail: true });
  assert.match(buildPrompt(taskFor()), /lazy senior developer/);
  // A request without a value leaves the choice alone.
  writeSettings({});
  assert.equal(readSettings().ponytail, true);
});
