import { api, isAnonymous, me } from "./github.js";
import { TASK_LABEL } from "./protocol.js";

// A project suggestion is a GitHub issue carrying a hidden marker in its body,
// so anyone with read access to a public repo can add one, unlike tasks,
// which need label permission. Voting reuses GitHub's own +1 reaction. The
// project owner turns a suggestion into a task by labeling it agent-task
// (which only a maintainer can do), or declines it by closing the issue.

const SUGGESTION_MARKER = "<!-- lendmyai:idea -->";

export interface Suggestion {
  number: number;
  title: string;
  body: string;
  author: string;
  createdAt: string;
  votes: number;
  voted: boolean;
}

async function upvotes(fullName: string, number: number): Promise<any[]> {
  const reactions = await api<any[]>("GET", `/repos/${fullName}/issues/${number}/reactions?per_page=100`);
  return reactions.filter((r) => r.content === "+1");
}

/** Open suggestions for a project, newest first. Approved ones (labeled agent-task) have become tasks and drop out of this list. */
export async function listSuggestions(fullName: string): Promise<Suggestion[]> {
  const issues = await api<any[]>("GET", `/repos/${fullName}/issues?state=open&per_page=100&sort=created&direction=desc`);
  const suggestions = issues.filter(
    (i) => !i.pull_request && typeof i.body === "string" && i.body.includes(SUGGESTION_MARKER) && !i.labels.some((l: any) => (typeof l === "string" ? l : l.name) === TASK_LABEL),
  );
  const login = isAnonymous() ? undefined : await me();
  return Promise.all(
    suggestions.map(async (i) => {
      const ups = await upvotes(fullName, i.number);
      return {
        number: i.number,
        title: i.title,
        body: i.body.replace(SUGGESTION_MARKER, "").trim(),
        author: i.user?.login ?? "",
        createdAt: i.created_at,
        votes: ups.length,
        voted: !!login && ups.some((r) => r.user?.login === login),
      };
    }),
  );
}

/** Creates a suggestion: an open issue, marked so it shows up in the suggestion bar. */
export async function createSuggestion(fullName: string, title: string, body: string): Promise<{ number: number; url: string }> {
  const t = title.trim();
  if (!t) throw new Error("Every suggestion needs a title.");
  const issue = await api<any>("POST", `/repos/${fullName}/issues`, {
    title: t.slice(0, 200),
    body: `${body.trim()}\n\n${SUGGESTION_MARKER}`.trim(),
  });
  return { number: issue.number, url: issue.html_url };
}

/** Toggles the signed-in user's upvote on a suggestion. */
export async function voteSuggestion(fullName: string, number: number): Promise<{ voted: boolean }> {
  const [login, ups] = await Promise.all([me(), upvotes(fullName, number)]);
  const mine = ups.find((r) => r.user?.login === login);
  if (mine) {
    await api("DELETE", `/repos/${fullName}/issues/${number}/reactions/${mine.id}`);
    return { voted: false };
  }
  await api("POST", `/repos/${fullName}/issues/${number}/reactions`, { content: "+1" });
  return { voted: true };
}

/** Approves a suggestion: the project owner turns it into a task by labeling it agent-task. GitHub requires triage access to label, so this fails for anyone else. */
export async function approveSuggestion(fullName: string, number: number): Promise<void> {
  await api("POST", `/repos/${fullName}/issues/${number}/labels`, { labels: [TASK_LABEL] });
}

/** Declines a suggestion: closes the issue without turning it into a task. */
export async function declineSuggestion(fullName: string, number: number): Promise<void> {
  await api("PATCH", `/repos/${fullName}/issues/${number}`, { state: "closed", state_reason: "not_planned" });
}
