// FILE: workspaceReconnect.ts
// Purpose: On-demand reconnect for one connected computer from the controller window.
// Layer: Web remote-access workspace orchestration
// Exports: reconnectWorkspaceComputer

import { ensureHostsApi } from "./api";
import { readWorkspaceSessions, resumeWorkspaceSession } from "./workspaceSessions";

/**
 * Ask the controller to redial a computer now, then retry its workspace. The controller's
 * `connect` replaces a parked relationship and returns the live one unchanged.
 */
export async function reconnectWorkspaceComputer(environmentId: string): Promise<void> {
  const session = readWorkspaceSessions().find(
    (entry) => entry.host.executionScope.environmentId === environmentId,
  );
  if (!session) throw new Error("This computer is no longer connected.");
  const connection = await ensureHostsApi().connect({ hostId: session.host.hostId });
  if (JSON.stringify(connection.executionScope) !== JSON.stringify(session.host.executionScope))
    throw new Error(
      "This host's account or identity changed. Disconnect it before connecting again.",
    );
  const current = readWorkspaceSessions().find((entry) => entry.host === session.host);
  if (current) resumeWorkspaceSession(current);
}
