// FILE: agentCursorPreference.ts
// Purpose: Persist the agent cursor colors mirrored from the renderer, so the
//          Cua driver host can push them at every session open.
// Layer: Desktop main process
// Depends on: filesystem. Pure parse/normalize helpers so the store is testable
//             without Electron; the file path is supplied by the caller.

import * as FS from "node:fs";
import * as Path from "node:path";

/** A `#rrggbb` channel for the driver's `set_agent_cursor_style`. */
export interface AgentCursorStylePreference {
  readonly fill?: string;
  readonly rim?: string;
  readonly shadow?: string;
}

export interface PersistedAgentCursorPreference {
  readonly version: 1;
  readonly style: AgentCursorStylePreference | null;
}

const AGENT_CURSOR_COLOR_PATTERN = /^#[0-9a-f]{6}$/;

function normalizeChannel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const candidate = value.trim().toLowerCase();
  return AGENT_CURSOR_COLOR_PATTERN.test(candidate) ? candidate : undefined;
}

/**
 * The preference's normalized form: only usable lowercase `#rrggbb` channels
 * survive, and a style with no usable channel collapses to null (stock). This
 * is the boundary the renderer payload crosses, so nothing half-typed or
 * malformed ever reaches the driver.
 */
export function normalizeAgentCursorStylePreference(
  value: unknown,
): AgentCursorStylePreference | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const fill = normalizeChannel(candidate.fill);
  const rim = normalizeChannel(candidate.rim);
  const shadow = normalizeChannel(candidate.shadow);
  if (!fill && !rim && !shadow) return null;
  return {
    ...(fill ? { fill } : {}),
    ...(rim ? { rim } : {}),
    ...(shadow ? { shadow } : {}),
  };
}

export function parseAgentCursorPreference(value: unknown): PersistedAgentCursorPreference | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.version !== 1 || !("style" in candidate)) return null;
  return { version: 1, style: normalizeAgentCursorStylePreference(candidate.style) };
}

/** The stored style, or null for stock (missing, empty, or unreadable file). */
export function readAgentCursorPreference(filePath: string): AgentCursorStylePreference | null {
  try {
    const parsed = parseAgentCursorPreference(JSON.parse(FS.readFileSync(filePath, "utf8")));
    return parsed?.style ?? null;
  } catch {
    return null;
  }
}

/**
 * Persist the preference. Stock (null) removes the file, so "no overrides
 * stored" is literal — the default install never leaves a colors file behind.
 */
export function writeAgentCursorPreference(
  filePath: string,
  style: AgentCursorStylePreference | null | undefined,
): void {
  const normalized = normalizeAgentCursorStylePreference(style);
  if (!normalized) {
    FS.rmSync(filePath, { force: true });
    return;
  }
  const payload: PersistedAgentCursorPreference = { version: 1, style: normalized };
  FS.mkdirSync(Path.dirname(filePath), { recursive: true });
  FS.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}
