// Task state lives entirely in GitHub issue comments. Each state change is a
// comment carrying a hidden marker, e.g. <!-- lendmyai:claim {...} -->.
// State is derived by replaying marker comments in chronological order, so
// concurrent claims resolve deterministically: the earliest valid claim wins.

export const TASK_LABEL = "agent-task";
export const REPO_TOPIC = "lendmyai";
export const CLAIM_HOURS = 24;

const TRUSTED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

export type MarkerKind = "claim" | "release" | "handoff" | "done";

export interface ClaimData { expires: string; agent: string }
export interface HandoffData { repo: string; branch: string }
export interface DoneData { pr: number }

export interface Comment {
  id: number;
  user: string;
  association: string;
  createdAt: string;
  body: string;
}

export interface Handoff extends HandoffData { user: string; note: string; at: string }

export type TaskState =
  | { kind: "available"; handoff?: Handoff }
  | {
      kind: "claimed"; user: string; expires: string; agent: string; commentId: number;
      /** When the claim was made, and the owner/repo the contributor pushes to (website claims only). */
      since: string; repo?: string; handoff?: Handoff;
    }
  | { kind: "in-review"; user: string; pr: number; handoff?: Handoff };

const MARKER_RE = /<!--\s*lendmyai:(claim|release|handoff|done)\s+(\{.*?\})\s*-->/s;

export function marker(kind: MarkerKind, data: object): string {
  return `<!-- lendmyai:${kind} ${JSON.stringify(data)} -->`;
}

export function parseMarker(body: string): { kind: MarkerKind; data: any } | null {
  const m = MARKER_RE.exec(body);
  if (!m) return null;
  try {
    return { kind: m[1] as MarkerKind, data: JSON.parse(m[2]) };
  } catch {
    return null;
  }
}

export function isTrusted(association: string): boolean {
  return TRUSTED_ASSOCIATIONS.has(association);
}

/** Strips the marker so only the human-readable part of a comment remains. */
export function stripMarker(body: string): string {
  return body.replace(MARKER_RE, "").trim();
}

/**
 * Replays marker comments to compute the current task state.
 * `prState` reports whether a PR from a `done` marker is still open; a closed
 * unmerged PR makes the task available again.
 */
export function computeState(
  comments: Comment[],
  now: Date,
  prState: (pr: number) => "open" | "merged" | "closed" = () => "open",
): TaskState {
  let state: TaskState = { kind: "available" };
  let handoff: Handoff | undefined;

  const sorted = [...comments].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const c of sorted) {
    const m = parseMarker(c.body);
    if (!m) continue;
    const at = new Date(c.createdAt);
    const claimLive = state.kind === "claimed" && new Date(state.expires) > at;
    const holder: string | undefined = state.kind === "available" ? undefined : state.user;

    switch (m.kind) {
      case "claim": {
        const expires = String(m.data.expires ?? "");
        if (Number.isNaN(Date.parse(expires))) break;
        // A claim only counts if nobody else holds a live claim at that moment.
        if (state.kind === "in-review" && prState(state.pr) !== "closed") break;
        if (claimLive && holder !== c.user) break;
        // A renewal by the holder keeps the original start time.
        const since: string = state.kind === "claimed" && holder === c.user && claimLive ? state.since : c.createdAt;
        const repo = typeof m.data.repo === "string" ? m.data.repo : undefined;
        state = { kind: "claimed", user: c.user, expires, agent: String(m.data.agent ?? "unknown"), commentId: c.id, since, repo };
        break;
      }
      case "release":
        // The holder, or a maintainer, can free the task.
        if (holder && (holder === c.user || isTrusted(c.association))) state = { kind: "available" };
        break;
      case "handoff":
        if (state.kind === "claimed" && holder === c.user && m.data.repo && m.data.branch) {
          handoff = { user: c.user, repo: String(m.data.repo), branch: String(m.data.branch), note: stripMarker(c.body), at: c.createdAt };
          state = { kind: "available" };
        }
        break;
      case "done":
        if (state.kind === "claimed" && holder === c.user && Number.isInteger(m.data.pr)) {
          state = { kind: "in-review", user: c.user, pr: m.data.pr };
        }
        break;
    }
  }

  if (state.kind === "claimed" && new Date(state.expires) <= now) state = { kind: "available" };
  if (state.kind === "in-review" && prState(state.pr) === "closed") state = { kind: "available" };
  return { ...state, handoff };
}

/** The issue fields checkApproval needs, as returned by GitHub's GraphQL API. */
export interface ApprovalIssue {
  closed: boolean;
  authorAssociation: string;
  author: { login: string } | null;
  lastEditedAt: string | null;
  editor: { login: string } | null;
  labels: { nodes: { name: string }[] };
  timelineItems: { nodes: ({ createdAt: string; actor: { login: string } | null; label: { name: string } | null } | null)[] };
}

/**
 * Decides whether an issue is a maintainer-approved task.
 *
 * Only users with triage access or higher can label issues, except that issue
 * templates may auto-apply labels on behalf of the author. So the label counts
 * as maintainer approval when someone other than the author applied it, or when
 * the author is a maintainer themselves. GitHub records the label event a few
 * seconds after an issue is created with labels, so a maintainer-authored issue
 * is trusted even before its label event shows up.
 */
export function checkApproval(issue: ApprovalIssue): { blocked?: string; warnings: string[] } {
  const warnings: string[] = [];
  const author = issue.author?.login;
  const authorTrusted = isTrusted(issue.authorAssociation);
  const labelEvent = [...issue.timelineItems.nodes].reverse().find((e) => e?.label?.name === TASK_LABEL);
  const labeler = labelEvent?.actor?.login;

  if (issue.closed) return { blocked: "Issue is closed.", warnings };
  if (!issue.labels.nodes.some((l) => l.name === TASK_LABEL)) return { blocked: `Issue is not labeled "${TASK_LABEL}".`, warnings };
  if (!labelEvent) {
    if (!authorTrusted) return { blocked: "Can't confirm yet that a maintainer approved this task. If it was just created, refresh in a few seconds.", warnings };
    return { warnings };
  }
  if (labeler === author && !authorTrusted) return { blocked: `The "${TASK_LABEL}" label was not applied by a maintainer.`, warnings };

  if (issue.lastEditedAt && issue.lastEditedAt > labelEvent.createdAt) {
    const editor = issue.editor?.login;
    const editorTrusted = editor === labeler || (editor === author && authorTrusted);
    if (!editorTrusted) warnings.push(`Issue text was edited by @${editor} after a maintainer approved it. Read it carefully.`);
  }
  return { warnings };
}

export function parseIssueRef(ref: string): { owner: string; repo: string; number: number } {
  const m = /^(?:https:\/\/github\.com\/)?([\w.-]+)\/([\w.-]+)(?:#|\/issues\/)(\d+)$/.exec(ref.trim());
  if (!m) throw new Error(`Invalid issue reference "${ref}". Use owner/repo#123 or an issue URL.`);
  return { owner: m[1], repo: m[2], number: Number(m[3]) };
}
