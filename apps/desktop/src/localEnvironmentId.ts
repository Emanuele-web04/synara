import * as FS from "node:fs";
import * as Path from "node:path";

import type { SynaraDesktopFlavor } from "@synara/shared/desktopIdentity";

/**
 * The backend creates this file on its first start and reuses it afterwards, so
 * the desktop can know the backend's identity before the backend is running.
 */
export function readLocalEnvironmentId(stateDir: string): string | null {
  try {
    const environmentId = FS.readFileSync(Path.join(stateDir, "environment-id"), "utf8").trim();
    return environmentId.length > 0 ? environmentId : null;
  } catch {
    return null;
  }
}

/**
 * The id a window may start from before its backend answers, or null when the
 * desktop cannot be sure its backend uses the same state directory: a
 * development URL moves the backend to another directory, and the remote
 * flavor keeps its own verified start.
 */
export function resolveEarlyLocalEnvironmentId(input: {
  readonly stateDir: string;
  readonly flavor: SynaraDesktopFlavor;
  readonly env: NodeJS.ProcessEnv;
}): string | null {
  if (input.flavor === "remote") return null;
  if (input.env.VITE_DEV_SERVER_URL?.trim()) return null;
  return readLocalEnvironmentId(input.stateDir);
}
