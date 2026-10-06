import { GitHubError, api } from "./github.js";
import { PRIORITY_LABELS, REPO_TOPIC, TASK_LABEL, type Priority } from "./protocol.js";

// Project-owner actions, run with the owner's own GitHub token: tasks must be
// created by a maintainer to count as approved. Used by the website and by the
// Claude connector's planning tools.

export interface NewTask {
  title: string;
  goal?: string;
  doneWhen?: string;
  notes?: string;
  priority?: Priority;
}

const PRIORITY_COLORS: Record<Priority, string> = { high: "d93f0b", medium: "fbca04", low: "0e8a16" };

/** Lists a repo on lendmyai: creates the agent-task and priority labels, and adds the lendmyai topic. */
export async function listProject(fullName: string): Promise<void> {
  const labels = [
    { name: TASK_LABEL, color: "5319e7", description: "Ready for an AI agent (lendmyai)" },
    ...Object.entries(PRIORITY_LABELS).map(([p, name]) => ({ name, color: PRIORITY_COLORS[p as Priority], description: `${p[0].toUpperCase()}${p.slice(1)} priority (lendmyai)` })),
  ];
  for (const label of labels) {
    try {
      await api("POST", `/repos/${fullName}/labels`, label);
    } catch (e) {
      if (!(e instanceof GitHubError && e.status === 422)) throw e;
    }
  }
  const { names } = await api<{ names: string[] }>("GET", `/repos/${fullName}/topics`);
  if (!names.includes(REPO_TOPIC)) await api("PUT", `/repos/${fullName}/topics`, { names: [...names, REPO_TOPIC] });
}

export function taskBody(t: NewTask): string {
  const section = (h: string, v: unknown) => (String(v ?? "").trim() ? `## ${h}\n${String(v).trim()}\n` : "");
  return [section("Goal", t.goal), section("Done when", t.doneWhen), section("Notes", t.notes)].filter(Boolean).join("\n");
}

/** Creates one task: an issue labeled agent-task (and a priority label, if given), opened by the owner. */
export async function createTask(fullName: string, t: NewTask): Promise<{ number: number; url: string }> {
  const title = String(t.title ?? "").trim();
  if (!title) throw new Error("Every task needs a title.");
  const labels = [TASK_LABEL, ...(t.priority ? [PRIORITY_LABELS[t.priority]] : [])];
  const issue = await api<any>("POST", `/repos/${fullName}/issues`, { title: title.slice(0, 200), body: taskBody(t), labels });
  return { number: issue.number, url: issue.html_url };
}

/** Public repos the signed-in user can add tasks to. */
export async function managedRepos(): Promise<{ fullName: string; listed: boolean; description: string }[]> {
  const repos = await api<any[]>("GET", "/user/repos?affiliation=owner,collaborator,organization_member&sort=updated&per_page=100");
  return repos
    .filter((r) => !r.private && (r.permissions?.triage || r.permissions?.push))
    .map((r) => ({ fullName: r.full_name, listed: (r.topics ?? []).includes(REPO_TOPIC), description: r.description ?? "" }));
}
