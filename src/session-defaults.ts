import { resolveConfigSetting } from "./config.js";
import { listSessions } from "./store.js";
import { AUTO_COLOR_ORDER, ANSI_COLORS, DEFAULT_PRIORITY, parseColorMode } from "./session-meta.js";
import type { AnsiColor, SessionColorMode } from "./types.js";

export interface SessionDefaultFlags {
  color?: SessionColorMode | null;
  priority?: number;
}

export interface ResolvedSessionDefaults {
  color: AnsiColor | null;
  priority: number;
}

/**
 * Resolves a session's accent color and sort priority. Explicit CLI flags take
 * precedence; otherwise the hierarchical config (`session.color` /
 * `session.priority`, repo-then-global) is consulted; otherwise the built-in
 * defaults (color auto, priority 500) apply. A `session.color` of "auto"
 * resolves to the least-used concrete color, and "none" resolves to null.
 */
export async function chooseAutoSessionColor(env: NodeJS.ProcessEnv = process.env): Promise<AnsiColor> {
  const sessions = await listSessions(env);
  const counts = new Map<AnsiColor, number>();
  for (const color of AUTO_COLOR_ORDER) counts.set(color, 0);
  for (const session of sessions) {
    if (session.color && (ANSI_COLORS as readonly string[]).includes(session.color)) {
      counts.set(session.color, (counts.get(session.color) ?? 0) + 1);
    }
  }
  let selected = AUTO_COLOR_ORDER[0];
  let selectedCount = counts.get(selected) ?? 0;
  for (const color of AUTO_COLOR_ORDER.slice(1)) {
    const count = counts.get(color) ?? 0;
    if (count < selectedCount) {
      selected = color;
      selectedCount = count;
    }
  }
  return selected;
}

export async function resolveSessionDefaults(
  flags: SessionDefaultFlags,
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd()
): Promise<ResolvedSessionDefaults> {
  let color: AnsiColor | null;
  if (flags.color !== undefined) {
    color = flags.color === "auto" ? await chooseAutoSessionColor(env) : flags.color === "none" ? null : flags.color;
  } else {
    const raw = resolveConfigSetting("session.color", env, cwd);
    const mode = typeof raw === "string" ? parseColorMode(raw) : "auto";
    color = mode === "auto" ? await chooseAutoSessionColor(env) : mode === "none" ? null : mode;
  }

  let priority: number;
  if (typeof flags.priority === "number") {
    priority = flags.priority;
  } else {
    const raw = resolveConfigSetting("session.priority", env, cwd);
    const n = typeof raw === "number" ? raw : Number(raw);
    priority = Number.isInteger(n) && n >= 0 && n <= 1000 ? n : DEFAULT_PRIORITY;
  }

  return { color, priority };
}
