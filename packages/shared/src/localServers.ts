// FILE: localServers.ts
// Purpose: Shared presentation helpers for detected local dev servers.
// Layer: Shared runtime utility (consumed by web UI surfaces).
// Depends on: ServerLocalServerProcess contract shape.

import type { ServerLocalServerProcess } from "@t3tools/contracts";

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

function firstAddressPort(server: ServerLocalServerProcess): readonly number[] {
  for (const address of server.addresses) {
    if (address.port > 0) {
      return [address.port];
    }
  }
  return [];
}
