// FILE: localServers.ts
// Purpose: Shared presentation helpers for detected local dev servers.
// Layer: Shared runtime utility (consumed by web UI surfaces).
// Depends on: ServerLocalServerProcess contract shape.

import type { ServerLocalServerProcess } from "@synara/contracts";

import { isWorkspaceRootWithin } from "./threadWorkspace";

export interface LocalServerRunIdentity {
  readonly pid: number | null;
  readonly cwd: string;
}

/**
 * Human-facing address for a detected local dev server.
 *
 * Every entry the monitor reports is a localhost port, so we always present it
 * as a full "localhost:<port>" rather than echoing back the raw bind host
 * (127.0.0.1, ::1, 0.0.0.0) or — worse — a bare ":<port>". The port is taken
 * from the reliable ports list, falling back to the first usable address port.
 */
export function localServerAddressLabel(server: ServerLocalServerProcess): string {
  const ports = server.ports.length > 0 ? server.ports : firstAddressPort(server);
  if (ports.length === 0) {
    return "localhost";
  }
  return ports.map((port) => `localhost:${port}`).join(", ");
}

/**
 * Primary human-facing label for a detected local dev server: the live page
 * title when one was resolved, otherwise the detected tool/display name.
 */
export function localServerPrimaryLabel(server: ServerLocalServerProcess): string {
  return server.pageTitle ?? server.displayName;
}

/**
 * Short folder label for a local dev server — the final segment of its working
 * directory (e.g. "synara-website" for ".../Developer/synara-website"), or null
 * when the cwd is unknown. The monitor only resolves a cwd on POSIX hosts, but
 * the split tolerates either separator defensively.
 */
export function localServerFolderLabel(server: ServerLocalServerProcess): string | null {
  const cwd = server.cwd?.trim();
  if (!cwd) {
    return null;
  }
  const segments = cwd.split(/[/\\]/).filter((segment) => segment.length > 0);
  return segments.at(-1) ?? null;
}

// Single ownership rule for linking a detected listener to a tracked project run.
// Prefer exact PTY/process lineage, then fall back to cwd containment for tools
// whose listening child obscures the original process id.
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
