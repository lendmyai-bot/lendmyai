import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// The contributor's saved preferences, kept in ~/.lendmyai/settings.json.

export interface Settings {
  /** Preferred agent CLI name (see AGENTS in agents.ts). */
  agent?: string;
  /** Preferred model, passed to the agent. */
  model?: string;
}

const file = () => join(process.env.LENDMYAI_HOME || join(homedir(), ".lendmyai"), "settings.json");

const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/** Reads the saved settings; a missing or unreadable file means no preferences. */
export function readSettings(): Settings {
  try {
    const raw = JSON.parse(readFileSync(file(), "utf8"));
    return { agent: text(raw?.agent), model: text(raw?.model) };
  } catch {
    return {};
  }
}

/** Merges `patch` into the saved settings. An empty string clears a field. */
export function writeSettings(patch: Settings): Settings {
  const next: Settings = { ...readSettings() };
  if (patch.agent !== undefined) next.agent = text(patch.agent);
  if (patch.model !== undefined) next.model = text(patch.model);
  const path = file();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(next, null, 2) + "\n");
  return next;
}
