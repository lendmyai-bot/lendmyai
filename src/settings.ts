import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HOME_DIR } from "./auth.js";

// Local preferences, kept in ~/.lendmyai/settings.json. Node only (the website has no local disk).

export interface Settings {
  /** Add the ponytail "smallest working change" rules to the agent's prompt. */
  ponytail: boolean;
}

const FILE = join(HOME_DIR, "settings.json");
const DEFAULTS: Settings = { ponytail: true };

export function readSettings(): Settings {
  let saved: Partial<Settings> = {};
  try {
    saved = JSON.parse(readFileSync(FILE, "utf8"));
  } catch {}
  const settings = { ponytail: typeof saved.ponytail === "boolean" ? saved.ponytail : DEFAULTS.ponytail };
  // LENDMYAI_PONYTAIL=0 (or --no-ponytail on the command line) wins over the saved choice.
  if (process.env.LENDMYAI_PONYTAIL === "0") settings.ponytail = false;
  return settings;
}

export function writeSettings(patch: Partial<Settings>): Settings {
  const next = { ...readSettings(), ...(typeof patch.ponytail === "boolean" ? { ponytail: patch.ponytail } : {}) };
  mkdirSync(HOME_DIR, { recursive: true });
  writeFileSync(FILE, JSON.stringify({ ponytail: next.ponytail }, null, 2));
  return next;
}
