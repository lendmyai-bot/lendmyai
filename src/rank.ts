import { GitHubError, api } from "./github.js";
import { REPO_TOPIC, actorOf, computeState, parseMarker, type Comment } from "./protocol.js";

// Rank list: which projects had the most AI token spending in a month.
//
// There is no database. A contributor's agent can report the tokens a run used
// in the `done` marker (result sent to the owner) or `handoff` marker
// (checkpoint) that it posts on the task's issue. This module replays those
// comments, so the ranking is derived from GitHub alone, like task state.
// It runs in Node and in the Cloudflare Worker.

/** Upper bound for one report, so a bogus number can't dominate the ranking. */
export const MAX_REPORTED_TOKENS = 1_000_000_000;

const MAX_REPOS = 40;
/** Pages of 100 comments read per project, which bounds API calls for busy projects. */
const MAX_PAGES = 10;
/** Claims last 24h, so a done/handoff comment is always within this window of its claim. */
const CLAIM_LOOKBACK_MS = 2 * 86400_000;

export interface MonthRange { key: string; start: Date; end: Date }
export interface IssueComment extends Comment { issue: number }
export interface SpendEvent { at: string; kind: "done" | "handoff"; tokens: number }
export interface RankRow { rank: number; fullName: string; description: string; avatar: string; url: string; tokens: number; tasks: number }
export interface RankList { month: string; totalTokens: number; projects: RankRow[] }

/** Tokens reported in a marker: a positive whole number, or 0 if missing or invalid. */
export function reportedTokens(data: any): number {
  const n = data?.tokens;
  return typeof n === "number" && Number.isSafeInteger(n) && n > 0 ? Math.min(n, MAX_REPORTED_TOKENS) : 0;
}

/** Parses "2026-10" into the UTC range of that month. */
export function parseMonth(key: string): MonthRange | undefined {
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(key);
  if (!m) return undefined;
  const year = Number(m[1]);
  const month = Number(m[2]);
  return { key, start: new Date(Date.UTC(year, month - 1, 1)), end: new Date(Date.UTC(year, month, 1)) };
}

export function currentMonth(now = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * Token reports on one issue that count: the marker must be valid at its point
 * in the history, i.e. posted by whoever holds the claim at that moment. This
 * is the same rule that decides task state, so nobody can inflate a project's
 * ranking by commenting a fake marker. `done` events are always returned (they
 * count a finished task); `handoff` events only when they carry tokens.
 */
export function spendEvents(comments: Comment[]): SpendEvent[] {
  const sorted = [...comments].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id - b.id);
  const out: SpendEvent[] = [];
  sorted.forEach((c, i) => {
    const m = parseMarker(c.body);
    if (!m || (m.kind !== "done" && m.kind !== "handoff")) return;
    const wellFormed = m.kind === "done" ? Number.isInteger(m.data.pr) : !!(m.data.repo && m.data.branch);
    if (!wellFormed) return;
    const before = computeState(sorted.slice(0, i), new Date(c.createdAt));
    if (before.kind !== "claimed" || before.user !== actorOf(c, m.data).user) return;
    const tokens = reportedTokens(m.data);
    if (m.kind === "done" || tokens > 0) out.push({ at: c.createdAt, kind: m.kind, tokens });
  });
  return out;
}

/** Tokens reported and tasks finished inside `range`, from all comments of one project. */
export function monthlyTotals(comments: IssueComment[], range: MonthRange): { tokens: number; tasks: number } {
  const byIssue = new Map<number, Comment[]>();
  for (const c of comments) {
    const list = byIssue.get(c.issue);
    if (list) list.push(c);
    else byIssue.set(c.issue, [c]);
  }
  let tokens = 0;
  let tasks = 0;
  for (const list of byIssue.values()) {
    for (const e of spendEvents(list)) {
      const at = new Date(e.at);
      if (at < range.start || at >= range.end) continue;
      tokens += e.tokens;
      if (e.kind === "done") tasks++;
    }
  }
  return { tokens, tasks };
}

/** Comments in a project's issues from `since` on, oldest first, stopping once past `end`. */
async function repoComments(fullName: string, since: Date, end: Date): Promise<IssueComment[]> {
  const out: IssueComment[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    let items: any[];
    try {
      items = await api<any[]>(
        "GET",
        `/repos/${fullName}/issues/comments?since=${encodeURIComponent(since.toISOString())}&sort=created&direction=asc&per_page=100&page=${page}`,
      );
    } catch (e) {
      // A repo that was renamed or deleted since the search shouldn't break the whole list.
      if (e instanceof GitHubError && (e.status === 404 || e.status === 410)) return out;
      throw e;
    }
    for (const c of items) {
      out.push({
        id: c.id,
        user: c.user?.login ?? "",
        association: c.author_association ?? "NONE",
        createdAt: c.created_at,
        body: c.body ?? "",
        issue: Number(String(c.issue_url).split("/").pop()),
      });
    }
    if (items.length < 100 || new Date(items[items.length - 1].created_at) >= end) break;
  }
  return out;
}

/** Ranks listed projects by tokens reported in `range`, then by finished tasks. */
export async function rankProjects(range: MonthRange): Promise<RankList> {
  const found = await api<any>(
    "GET",
    `/search/repositories?q=${encodeURIComponent(`topic:${REPO_TOPIC} is:public archived:false`)}&sort=updated&per_page=${MAX_REPOS}`,
  );
  const since = new Date(range.start.getTime() - CLAIM_LOOKBACK_MS);
  const rows = await Promise.all(
    (found.items as any[]).map(async (r) => ({
      fullName: r.full_name as string,
      description: (r.description ?? "") as string,
      avatar: (r.owner?.avatar_url ?? "") as string,
      url: r.html_url as string,
      ...monthlyTotals(await repoComments(r.full_name, since, range.end), range),
    })),
  );
  const projects = rows
    .filter((r) => r.tokens > 0 || r.tasks > 0)
    .sort((a, b) => b.tokens - a.tokens || b.tasks - a.tasks || a.fullName.localeCompare(b.fullName))
    .map((r, i) => ({ rank: i + 1, ...r }));
  return { month: range.key, totalTokens: projects.reduce((sum, p) => sum + p.tokens, 0), projects };
}
