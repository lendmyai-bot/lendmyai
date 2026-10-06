import assert from "node:assert/strict";
import { test } from "node:test";
import { marker } from "./protocol.js";
import { noteImageUrls, type Task } from "./tasks.js";

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

test("the agent prompt carries the ponytail rules, framed as how rather than whether", async () => {
  const { buildPrompt } = await import("./work.js");
  const task = { owner: "o", repo: "r", number: 1, title: "T", body: "B", comments: [], state: { kind: "available" }, warnings: [] } as unknown as Task;
  const prompt = buildPrompt(task);
  assert.match(prompt, /lazy senior developer/);
  assert.match(prompt, /decide HOW to implement it, not whether/);
});
