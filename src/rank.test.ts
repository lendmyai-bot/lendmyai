import assert from "node:assert/strict";
import { test } from "node:test";
import { BOT_LOGIN, marker } from "./protocol.js";
import { MAX_REPORTED_TOKENS, monthlyTotals, parseMonth, reportedTokens, type IssueComment } from "./rank.js";

const OCT = parseMonth("2026-10")!;
const FAR = "2099-01-01T00:00:00Z";
let id = 0;

function c(issue: number, user: string, at: string, body: string): IssueComment {
  return { id: ++id, user, association: "NONE", createdAt: at, body, issue };
}
const claim = (issue: number, user: string, at: string) => c(issue, user, at, marker("claim", { expires: FAR, agent: "claude" }));
const done = (issue: number, user: string, at: string, data: object = {}) => c(issue, user, at, marker("done", { pr: 7, ...data }));

test("parseMonth returns the UTC range of the month", () => {
  const m = parseMonth("2026-10")!;
  assert.equal(m.start.toISOString(), "2026-10-01T00:00:00.000Z");
  assert.equal(m.end.toISOString(), "2026-11-01T00:00:00.000Z");
  assert.equal(parseMonth("2026-12")!.end.toISOString(), "2027-01-01T00:00:00.000Z");
});

test("parseMonth rejects anything that is not YYYY-MM", () => {
  for (const bad of ["2026-13", "2026-00", "2026-1", "26-10", "2026-10-05", "", "october"]) assert.equal(parseMonth(bad), undefined, bad);
});

test("reportedTokens accepts positive whole numbers and caps huge values", () => {
  assert.equal(reportedTokens({ tokens: 1234 }), 1234);
  assert.equal(reportedTokens({ tokens: 5e12 }), MAX_REPORTED_TOKENS);
  for (const bad of [{}, { tokens: 0 }, { tokens: -5 }, { tokens: 1.5 }, { tokens: "7" }, { tokens: null }, null, undefined]) {
    assert.equal(reportedTokens(bad), 0);
  }
});

test("tokens and finished tasks are summed across issues", () => {
  const totals = monthlyTotals(
    [
      claim(1, "alice", "2026-10-05T10:00:00Z"), done(1, "alice", "2026-10-05T10:30:00Z", { tokens: 1000 }),
      claim(2, "bob", "2026-10-06T09:00:00Z"), done(2, "bob", "2026-10-06T09:30:00Z", { tokens: 250 }),
    ],
    OCT,
  );
  assert.deepEqual(totals, { tokens: 1250, tasks: 2 });
});

test("a finished task without a token report counts as a task only", () => {
  const totals = monthlyTotals([claim(1, "alice", "2026-10-05T10:00:00Z"), done(1, "alice", "2026-10-05T10:30:00Z")], OCT);
  assert.deepEqual(totals, { tokens: 0, tasks: 1 });
});

test("a done marker from someone who doesn't hold the claim is ignored", () => {
  const totals = monthlyTotals(
    [claim(1, "alice", "2026-10-05T10:00:00Z"), done(1, "mallory", "2026-10-05T10:05:00Z", { tokens: 999_999 })],
    OCT,
  );
  assert.deepEqual(totals, { tokens: 0, tasks: 0 });
});

test("a done marker without any claim is ignored", () => {
  assert.deepEqual(monthlyTotals([done(1, "mallory", "2026-10-05T10:05:00Z", { tokens: 500 })], OCT), { tokens: 0, tasks: 0 });
});

test("a second done marker on the same issue is not counted again", () => {
  const totals = monthlyTotals(
    [
      claim(1, "alice", "2026-10-05T10:00:00Z"),
      done(1, "alice", "2026-10-05T10:30:00Z", { tokens: 100 }),
      done(1, "alice", "2026-10-05T10:31:00Z", { tokens: 100 }),
    ],
    OCT,
  );
  assert.deepEqual(totals, { tokens: 100, tasks: 1 });
});

test("tokens reported with a checkpoint count, but it is not a finished task", () => {
  const handoff = c(1, "alice", "2026-10-05T11:00:00Z", marker("handoff", { repo: "alice/x", branch: "lendmyai/issue-1", tokens: 400 }));
  assert.deepEqual(monthlyTotals([claim(1, "alice", "2026-10-05T10:00:00Z"), handoff], OCT), { tokens: 400, tasks: 0 });
});

test("only reports inside the month count", () => {
  const totals = monthlyTotals(
    [
      claim(1, "alice", "2026-09-30T23:00:00Z"), done(1, "alice", "2026-09-30T23:59:59Z", { tokens: 100 }),
      claim(2, "bob", "2026-10-31T23:00:00Z"), done(2, "bob", "2026-10-31T23:59:59Z", { tokens: 10 }),
      claim(3, "carol", "2026-10-31T23:30:00Z"), done(3, "carol", "2026-11-01T00:00:00Z", { tokens: 1000 }),
    ],
    OCT,
  );
  assert.deepEqual(totals, { tokens: 10, tasks: 1 });
});

test("a contributor without GitHub is credited through the bot, and only for their own claim", () => {
  const by = "lendmyai:ab12cd34";
  const botClaim = c(1, BOT_LOGIN, "2026-10-05T10:00:00Z", marker("claim", { expires: FAR, agent: "Claude", by, name: "Jane" }));
  const own = c(1, BOT_LOGIN, "2026-10-05T10:30:00Z", marker("done", { pr: 3, tokens: 500, by, name: "Jane" }));
  const other = c(2, BOT_LOGIN, "2026-10-05T10:40:00Z", marker("done", { pr: 4, tokens: 900, by: "lendmyai:ffff0000" }));
  assert.deepEqual(monthlyTotals([botClaim, own, other, claim(2, "bob", "2026-10-05T09:00:00Z")], OCT), { tokens: 500, tasks: 1 });
});
