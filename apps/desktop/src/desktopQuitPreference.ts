// FILE: desktopQuitPreference.ts
// Purpose: Persist whether an idle desktop quit asks first, so the quit policy
//          survives restarts and Settings can turn the question back on.
// Layer: Desktop main process
// Depends on: filesystem. Pure parse helpers keep the store testable without
//             Electron; the file path is supplied by the caller.

import * as FS from "node:fs";
import * as Path from "node:path";

export interface PersistedDesktopQuitPreference {
  readonly version: 1;
  /** False skips the question when no chat is running; a running chat always asks. */
  readonly askOnIdleQuit: boolean;
}

/**
 * The stored preference's normalized form. A missing, malformed, or unknown
 * version falls back to asking, which is the safe default for a quit.
 */
export function parseDesktopQuitPreference(value: unknown): PersistedDesktopQuitPreference | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.version !== 1 || typeof candidate.askOnIdleQuit !== "boolean") return null;
  return { version: 1, askOnIdleQuit: candidate.askOnIdleQuit };
}

/** Whether an idle quit asks first; true when the file is missing or unreadable. */
export function readAskOnIdleQuit(filePath: string): boolean {
  try {
    const parsed = parseDesktopQuitPreference(JSON.parse(FS.readFileSync(filePath, "utf8")));
    return parsed?.askOnIdleQuit ?? true;
  } catch {
    return true;
  }
}

/** Persist whether an idle quit asks. Unwritable state keeps the choice for this run only. */
export function writeAskOnIdleQuit(filePath: string, askOnIdleQuit: boolean): void {
  const payload: PersistedDesktopQuitPreference = { version: 1, askOnIdleQuit };
  try {
    FS.mkdirSync(Path.dirname(filePath), { recursive: true });
    FS.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  } catch {
    // A read-only data folder must not stop the app from quitting.
  }
}
