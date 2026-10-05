import assert from "node:assert/strict";
import { test } from "node:test";
import { computeState, marker, parseIssueRef, type Comment } from "./protocol.js";

const NOW = new Date("2026-10-05T12:00:00Z");
const LATER = "2026-10-06T12:00:00Z";
let id = 0;

function c(user: string, at: string, body: string, association = "NONE"): Comment {
  return { id: ++id, user, association, createdAt: `2026-10-05T${at}:00Z`, body };
}
const claim = (user: string, at: string, expires = LATER) => c(user, at, marker("claim", { expires, agent: "claude" }));

test("no markers means available", () => {
  assert.equal(computeState([c("bob", "10:00", "looks good")], NOW).kind, "available");
});

test("earliest claim wins a race", () => {
  const s = computeState([claim("bob", "10:01"), claim("alice", "10:00")], NOW);
  assert.equal(s.kind === "claimed" && s.user, "alice");
});

test("expired claim makes task available and lets others claim", () => {
  assert.equal(computeState([claim("alice", "09:00", "2026-10-05T10:00:00Z")], NOW).kind, "available");
  const s = computeState([claim("alice", "09:00", "2026-10-05T10:00:00Z"), claim("bob", "11:00")], NOW);
  assert.equal(s.kind === "claimed" && s.user, "bob");
});

test("markers are attributed to the comment author, not the JSON", () => {
  const forged = c("mallory", "10:01", marker("release", { user: "alice" }));
  const s = computeState([claim("alice", "10:00"), forged], NOW);
  assert.equal(s.kind === "claimed" && s.user, "alice");
});

test("maintainer can release someone else's claim", () => {
  const rel = c("owner", "10:01", marker("release", {}), "OWNER");
  assert.equal(computeState([claim("alice", "10:00"), rel], NOW).kind, "available");
});

test("handoff frees the task and is carried to the next claimer", () => {
  const h = c("alice", "10:01", `progress notes\n${marker("handoff", { repo: "alice/x", branch: "lendmyai/issue-1" })}`);
  const s = computeState([claim("alice", "10:00"), h, claim("bob", "10:02")], NOW);
  assert.equal(s.kind, "claimed");
  assert.deepEqual(s.handoff && { user: s.handoff.user, repo: s.handoff.repo, note: s.handoff.note }, { user: "alice", repo: "alice/x", note: "progress notes" });
});

test("done blocks claims while PR is open, reopens when PR is closed unmerged", () => {
  const comments = [claim("alice", "10:00"), c("alice", "10:05", marker("done", { pr: 7 })), claim("bob", "10:10")];
  const open = computeState(comments, NOW, () => "open");
  assert.equal(open.kind === "in-review" && open.pr, 7);
  const closed = computeState(comments, NOW, () => "closed");
  assert.equal(closed.kind === "claimed" && closed.user, "bob");
});

test("only the claim holder can mark done", () => {
  const s = computeState([claim("alice", "10:00"), c("bob", "10:05", marker("done", { pr: 9 }))], NOW);
  assert.equal(s.kind, "claimed");
});

test("parseIssueRef accepts short refs and URLs", () => {
  assert.deepEqual(parseIssueRef("acme/app#12"), { owner: "acme", repo: "app", number: 12 });
  assert.deepEqual(parseIssueRef("https://github.com/acme/app/issues/12"), { owner: "acme", repo: "app", number: 12 });
  assert.throws(() => parseIssueRef("acme/app"));
});
