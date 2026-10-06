import assert from "node:assert/strict";
import { test } from "node:test";
import { BOT_LOGIN, TASK_LABEL, checkApproval, computeState, marker, parseIssueRef, parseMarker, type ApprovalIssue, type Comment } from "./protocol.js";

const NOW = new Date("2026-10-05T12:00:00Z");
const LATER = "2026-10-06T12:00:00Z";
let id = 0;

function c(user: string, at: string, body: string, association = "NONE"): Comment {
  return { id: ++id, user, association, createdAt: `2026-10-05T${at}:00Z`, body };
}
const claim = (user: string, at: string, expires = LATER) => c(user, at, marker("claim", { expires, agent: "claude" }));
const forceClaim = (user: string, at: string, expires = LATER) => c(user, at, marker("claim", { expires, agent: "claude", force: true }));

test("no markers means available", () => {
  assert.equal(computeState([c("bob", "10:00", "looks good")], NOW).kind, "available");
});

test("earliest claim wins a race", () => {
  const s = computeState([claim("bob", "10:01"), claim("alice", "10:00")], NOW);
  assert.equal(s.kind === "claimed" && s.user, "alice");
});

test("a forced claim takes over a task someone else is already working on", () => {
  const s = computeState([claim("alice", "10:00"), forceClaim("bob", "10:01")], NOW);
  assert.equal(s.kind === "claimed" && s.user, "bob");
  // the takeover restarts the claim clock, it doesn't inherit alice's start time
  assert.equal(s.kind === "claimed" && s.since, "2026-10-05T10:01:00Z");
});

test("a forced claim can take over a task that's already in review", () => {
  const comments = [claim("alice", "10:00"), c("alice", "10:05", marker("done", { pr: 7 })), forceClaim("bob", "10:10")];
  const s = computeState(comments, NOW, () => "open");
  assert.equal(s.kind === "claimed" && s.user, "bob");
});

test("without force, a live claim or an open PR still blocks a new claim", () => {
  const s = computeState([claim("alice", "10:00"), claim("bob", "10:01")], NOW);
  assert.equal(s.kind === "claimed" && s.user, "alice");
  const comments = [claim("alice", "10:00"), c("alice", "10:05", marker("done", { pr: 7 })), claim("bob", "10:10")];
  assert.equal(computeState(comments, NOW, () => "open").kind, "in-review");
});

test("expired claim makes task available and lets others claim", () => {
  assert.equal(computeState([claim("alice", "09:00", "2026-10-05T10:00:00Z")], NOW).kind, "available");
  const s = computeState([claim("alice", "09:00", "2026-10-05T10:00:00Z"), claim("bob", "11:00")], NOW);
  assert.equal(s.kind === "claimed" && s.user, "bob");
});

test("claim records the push repo, and renewal keeps the start time", () => {
  const first = c("alice", "10:00", marker("claim", { expires: LATER, agent: "Claude (cloud)", repo: "alice/x" }));
  const renew = c("alice", "11:00", marker("claim", { expires: LATER, agent: "Claude (cloud)", repo: "alice/x" }));
  const s = computeState([first, renew], NOW);
  assert.equal(s.kind === "claimed" && s.repo, "alice/x");
  assert.equal(s.kind === "claimed" && s.since, "2026-10-05T10:00:00Z");
});

test("bot markers count for the contributor they name", () => {
  const botClaim = (by: string, at: string) => c(BOT_LOGIN, at, marker("claim", { expires: LATER, agent: "Claude", by, name: "Jane" }));
  const s = computeState([botClaim("lendmyai:ab12cd34", "10:00")], NOW);
  assert.equal(s.kind === "claimed" && s.user, "lendmyai:ab12cd34");
  assert.equal(s.kind === "claimed" && s.name, "Jane");
  // A second contributor can't take a live claim, even through the same bot account.
  const raced = computeState([botClaim("lendmyai:ab12cd34", "10:00"), botClaim("lendmyai:ffff0000", "10:01")], NOW);
  assert.equal(raced.kind === "claimed" && raced.user, "lendmyai:ab12cd34");
  // Only the same contributor can hand off.
  const other = c(BOT_LOGIN, "10:02", marker("handoff", { repo: "lendmyai-bot/x", branch: "b", by: "lendmyai:ffff0000" }));
  assert.equal(computeState([botClaim("lendmyai:ab12cd34", "10:00"), other], NOW).kind, "claimed");
});

test("only the bot can act for contributors", () => {
  const forged = c("mallory", "10:00", marker("claim", { expires: LATER, agent: "x", by: "lendmyai:ab12cd34" }));
  const s = computeState([forged], NOW);
  assert.equal(s.kind === "claimed" && s.user, "mallory");
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

test("old done and handoff markers that still carry tokens (or other unknown fields) keep working", () => {
  const raw = (kind: string, json: string) => `<!-- lendmyai:${kind} ${json} -->`;
  assert.deepEqual(parseMarker(raw("done", '{"pr":7,"tokens":123456}'))?.data, { pr: 7, tokens: 123456 });

  const done = computeState(
    [claim("alice", "10:00"), c("alice", "10:05", raw("done", '{"pr":7,"tokens":123456,"future":"x"}'))],
    NOW,
  );
  assert.equal(done.kind === "in-review" && done.pr, 7);

  const handoff = c("alice", "10:01", `notes\n${raw("handoff", '{"repo":"alice/x","branch":"b","tokens":400}')}`);
  const s = computeState([claim("alice", "10:00"), handoff], NOW);
  assert.equal(s.kind, "available");
  assert.deepEqual(s.handoff && { repo: s.handoff.repo, branch: s.handoff.branch, note: s.handoff.note }, { repo: "alice/x", branch: "b", note: "notes" });
});

function issue(o: { author?: string; association?: string; events?: [actor: string, at: string][]; labeled?: boolean; editedAt?: string; editor?: string }): ApprovalIssue {
  return {
    closed: false,
    authorAssociation: o.association ?? "NONE",
    author: { login: o.author ?? "stranger" },
    lastEditedAt: o.editedAt ?? null,
    editor: o.editor ? { login: o.editor } : null,
    labels: { nodes: o.labeled === false ? [] : [{ name: TASK_LABEL }] },
    timelineItems: { nodes: (o.events ?? []).map(([actor, at]) => ({ createdAt: at, actor: { login: actor }, label: { name: TASK_LABEL } })) },
  };
}

test("approval: owner creates an issue with the label, before GitHub records the label event", () => {
  assert.equal(checkApproval(issue({ author: "owner", association: "OWNER" })).blocked, undefined);
});

test("approval: maintainer labels a stranger's issue", () => {
  assert.equal(checkApproval(issue({ author: "stranger", events: [["owner", "2026-10-05T10:00:00Z"]] })).blocked, undefined);
});

test("approval: label auto-applied to a stranger's own issue is rejected", () => {
  assert.match(checkApproval(issue({ author: "stranger", events: [["stranger", "2026-10-05T10:00:00Z"]] })).blocked ?? "", /not applied by a maintainer/);
});

test("approval: stranger's issue with no label event yet is not trusted", () => {
  assert.match(checkApproval(issue({ author: "stranger" })).blocked ?? "", /Can't confirm yet/);
});

test("approval: unlabeled issue is blocked", () => {
  assert.match(checkApproval(issue({ author: "owner", association: "OWNER", labeled: false })).blocked ?? "", /not labeled/);
});

test("approval: stranger edits the text after approval triggers a warning", () => {
  const i = issue({ author: "stranger", events: [["owner", "2026-10-05T10:00:00Z"]], editedAt: "2026-10-05T11:00:00Z", editor: "stranger" });
  const res = checkApproval(i);
  assert.equal(res.blocked, undefined);
  assert.equal(res.warnings.length, 1);
});

test("parseIssueRef accepts short refs and URLs", () => {
  assert.deepEqual(parseIssueRef("acme/app#12"), { owner: "acme", repo: "app", number: 12 });
  assert.deepEqual(parseIssueRef("https://github.com/acme/app/issues/12"), { owner: "acme", repo: "app", number: 12 });
  assert.throws(() => parseIssueRef("acme/app"));
});

test("a failed marker from the holder marks the task failed and keeps the reason", () => {
  const failed = c("alice", "10:05", `Not a code change.\n${marker("failed", {})}`);
  const s = computeState([claim("alice", "10:00"), failed], NOW);
  assert.equal(s.kind, "failed");
  assert.equal(s.failure?.reason, "Not a code change.");
  // Someone else cannot mark it failed.
  assert.equal(computeState([claim("alice", "10:00"), c("bob", "10:05", marker("failed", {}))], NOW).kind, "claimed");
  // Anyone can retry; the earlier reason stays visible.
  const retry = computeState([claim("alice", "10:00"), failed, claim("bob", "10:10")], NOW);
  assert.equal(retry.kind === "claimed" && retry.user, "bob");
  assert.equal(retry.failure?.user, "alice");
});
