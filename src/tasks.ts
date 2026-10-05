import { api, getComments, graphql, prStateFetcher } from "./github.js";
import {
  REPO_TOPIC,
  TASK_LABEL,
  computeState,
  isTrusted,
  parseMarker,
  type Comment,
  type TaskState,
} from "./protocol.js";

export interface Task {
  owner: string;
  repo: string;
  number: number;
  title: string;
  body: string;
  url: string;
  open: boolean;
  defaultBranch: string;
  /** Viewer can push branches directly to the upstream repo (no fork needed). */
  canPush: boolean;
  comments: Comment[];
  state: TaskState;
  /** Set when the task must not be worked on (e.g. not approved by a maintainer). */
  blocked?: string;
  /** Concerns the contributor should review before running their agent. */
  warnings: string[];
}

const ISSUE_QUERY = `
query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    viewerPermission
    defaultBranchRef { name }
    issue(number: $number) {
      title body url closed authorAssociation
      author { login }
      lastEditedAt
      editor { login }
      labels(first: 50) { nodes { name } }
      timelineItems(itemTypes: [LABELED_EVENT], last: 50) {
        nodes { ... on LabeledEvent { createdAt actor { login } label { name } } }
      }
    }
  }
}`;

export async function loadTask(owner: string, repo: string, number: number): Promise<Task> {
  const data = await graphql<any>(ISSUE_QUERY, { owner, repo, number });
  const r = data.repository;
  if (!r?.issue) throw new Error(`Issue ${owner}/${repo}#${number} not found.`);
  const issue = r.issue;

  const comments = await getComments(owner, repo, number);
  const state = await stateOf(owner, repo, comments);
  const warnings: string[] = [];
  let blocked: string | undefined;

  // Only users with triage access or higher can label issues, except that issue
  // templates may auto-apply labels on behalf of the author. So the label counts
  // as maintainer approval when someone other than the author applied it, or
  // when the author is a maintainer themselves.
  const author = issue.author?.login;
  const labelEvent = [...issue.timelineItems.nodes].reverse().find((e: any) => e?.label?.name === TASK_LABEL);
  const hasLabel = issue.labels.nodes.some((l: any) => l.name === TASK_LABEL);
  const labeler = labelEvent?.actor?.login;
  if (issue.closed) blocked = "Issue is closed.";
  else if (!hasLabel) blocked = `Issue is not labeled "${TASK_LABEL}".`;
  else if (!labelEvent || (labeler === author && !isTrusted(issue.authorAssociation))) {
    blocked = `The "${TASK_LABEL}" label was not applied by a maintainer.`;
  } else if (issue.lastEditedAt && issue.lastEditedAt > labelEvent.createdAt) {
    const editor = issue.editor?.login;
    const editorTrusted = editor === labeler || (editor === author && isTrusted(issue.authorAssociation));
    if (!editorTrusted) warnings.push(`Issue text was edited by @${editor} after a maintainer approved it. Read it carefully.`);
  }

  return {
    owner,
    repo,
    number,
    title: issue.title,
    body: issue.body ?? "",
    url: issue.url,
    open: !issue.closed,
    defaultBranch: r.defaultBranchRef?.name ?? "main",
    canPush: ["WRITE", "MAINTAIN", "ADMIN"].includes(r.viewerPermission),
    comments,
    state,
    blocked,
    warnings,
  };
}

export async function stateOf(owner: string, repo: string, comments: Comment[]): Promise<TaskState> {
  const prs = comments.map((c) => parseMarker(c.body)).flatMap((m) => (m?.kind === "done" && Number.isInteger(m.data.pr) ? [m.data.pr] : []));
  return computeState(comments, new Date(), await prStateFetcher(owner, repo, prs));
}

/** Comments from maintainers that add context to the task (markers excluded). */
export function maintainerNotes(task: Task): string[] {
  return task.comments.filter((c) => isTrusted(c.association) && !parseMarker(c.body)).map((c) => `@${c.user}: ${c.body.trim()}`);
}

export interface TaskSummary {
  ref: string;
  title: string;
  url: string;
  state: TaskState;
}

/** Lists open agent tasks, either in one repo or across all repos with the lendmyai topic. */
export async function listTasks(repoFilter?: string, limit = 30): Promise<TaskSummary[]> {
  const q = [`is:issue`, `is:open`, `label:${TASK_LABEL}`, repoFilter ? `repo:${repoFilter}` : `archived:false`].join(" ");
  const res = await api<any>("GET", `/search/issues?q=${encodeURIComponent(q)}&sort=updated&per_page=${limit}`);

  const optedIn = new Map<string, boolean>();
  const out: TaskSummary[] = [];
  for (const item of res.items) {
    const fullName = item.repository_url.replace("https://api.github.com/repos/", "");
    if (!repoFilter) {
      // Repos opt in to public discovery by adding the lendmyai topic.
      if (!optedIn.has(fullName)) {
        const topics = await api<any>("GET", `/repos/${fullName}/topics`);
        optedIn.set(fullName, topics.names.includes(REPO_TOPIC));
      }
      if (!optedIn.get(fullName)) continue;
    }
    const [owner, repo] = fullName.split("/");
    const comments = await getComments(owner, repo, item.number);
    out.push({ ref: `${fullName}#${item.number}`, title: item.title, url: item.html_url, state: await stateOf(owner, repo, comments) });
  }
  return out;
}
