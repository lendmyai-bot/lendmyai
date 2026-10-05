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
  | { kind: "claimed"; user: string; expires: string; agent: string; commentId: number; handoff?: Handoff }
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
        state = { kind: "claimed", user: c.user, expires, agent: String(m.data.agent ?? "unknown"), commentId: c.id };
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

export function parseIssueRef(ref: string): { owner: string; repo: string; number: number } {
  const m = /^(?:https:\/\/github\.com\/)?([\w.-]+)\/([\w.-]+)(?:#|\/issues\/)(\d+)$/.exec(ref.trim());
  if (!m) throw new Error(`Invalid issue reference "${ref}". Use owner/repo#123 or an issue URL.`);
  return { owner: m[1], repo: m[2], number: Number(m[3]) };
}
