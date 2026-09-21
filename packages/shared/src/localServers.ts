import type { ServerLocalServerProcess } from "@synara/contracts";

import { isWorkspaceRootWithin } from "./threadWorkspace";

export interface LocalServerRunIdentity {
  readonly pid: number | null;
  readonly cwd: string;
}

/** always present as "localhost:<port>" rather than the raw bind host (127.0.0.1, ::1, 0.0.0.0) or a bare ":<port>" */
export function localServerAddressLabel(server: ServerLocalServerProcess): string {
  const ports = server.ports.length > 0 ? server.ports : firstAddressPort(server);
  if (ports.length === 0) {
    return "localhost";
  }
  return ports.map((port) => `localhost:${port}`).join(", ");
}

/** live page title when resolved, else the detected tool/display name */
export function localServerPrimaryLabel(server: ServerLocalServerProcess): string {
  return server.pageTitle ?? server.displayName;
}

/** final cwd segment; the monitor only resolves cwd on POSIX but the split tolerates either separator */
export function localServerFolderLabel(server: ServerLocalServerProcess): string | null {
  const cwd = server.cwd?.trim();
  if (!cwd) {
    return null;
  }
  const segments = cwd.split(/[/\\]/).filter((segment) => segment.length > 0);
  return segments.at(-1) ?? null;
}

// prefer exact PTY/process lineage, then cwd containment for tools whose listening child obscures the original pid
export function localServerMatchesRun(
  server: ServerLocalServerProcess,
  run: LocalServerRunIdentity,
): boolean {
  if (run.pid !== null && (server.pid === run.pid || server.ppid === run.pid)) {
    return true;
  }
  return Boolean(server.cwd && isWorkspaceRootWithin(server.cwd, run.cwd));
}

function firstAddressPort(server: ServerLocalServerProcess): readonly number[] {
  for (const address of server.addresses) {
    if (address.port > 0) {
      return [address.port];
    }
  }
  return [];
}
