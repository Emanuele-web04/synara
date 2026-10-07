import { useSyncExternalStore } from "react";
import type {
  AccountStatus,
  ListHostConnectionsResponse,
  RemoteExecutionScope,
} from "@synara/contracts";
import { Schema } from "effect";
import { RemoteExecutionScope as RemoteScopeSchema } from "@synara/contracts";
import type { ActiveHost } from "./activeHost";
import { readExecutionContext } from "./executionContext";
import { accountStatusScope, controlAccountScope } from "./controlQueryScope";
import type { WorkspaceNavigation, WorkspaceSummary } from "./workspaceFrame";

export interface WorkspaceSession {
  readonly host: ActiveHost & { executionScope: RemoteExecutionScope };
  readonly summary?: WorkspaceSummary;
  readonly navigation?: WorkspaceNavigation | undefined;
  readonly error?: string | undefined;
}

let sessions: readonly WorkspaceSession[] = [];
const listeners = new Set<() => void>();
let restored = false;

function storageKey(): string {
  const controller = readExecutionContext()?.controller;
  if (!controller) throw new Error("The local computer has not been verified");
  return `synara:workspace-connections:v1:${encodeURIComponent(controller.environmentId)}`;
}

export function parseWorkspaceHost(value: unknown): WorkspaceSession["host"] | null {
  if (!value || typeof value !== "object") return null;
  const host = value as Partial<ActiveHost>;
  if (
    typeof host.hostId !== "string" ||
    !host.hostId ||
    typeof host.hostName !== "string" ||
    typeof host.wsPath !== "string" ||
    !host.wsPath.startsWith("/ws/remote/")
  )
    return null;
  const scope = Schema.decodeUnknownOption(RemoteScopeSchema)(host.executionScope);
  if (scope._tag === "None") return null;
  return {
    hostId: host.hostId,
    hostName: host.hostName,
    wsPath: host.wsPath,
    executionScope: scope.value,
  };
}

function publish(next: readonly WorkspaceSession[], persist = false): void {
  if (persist) sessionStorage.setItem(storageKey(), JSON.stringify(next.map(({ host }) => host)));
  sessions = next;
  for (const listener of listeners) listener();
}

export function restoreWorkspaceSessions(): void {
  if (restored) return;
  restored = true;
  if (readExecutionContext()?.controller.capabilities.remoteConnections !== true) return;
  try {
    const saved: unknown = JSON.parse(sessionStorage.getItem(storageKey()) ?? "[]");
    if (!Array.isArray(saved)) return;
    const seen = new Set<string>();
    publish(
      saved.flatMap((item) => {
        const host = parseWorkspaceHost(item);
        if (!host || seen.has(host.executionScope.environmentId)) return [];
        seen.add(host.executionScope.environmentId);
        return [{ host }];
      }),
    );
  } catch {
    // Corrupt or unavailable storage does not prevent using the local computer.
  }
}

/** Recover verified backend connections when a new window has no saved workspace frames. */
export function restoreConnectedWorkspaces(
  response: ListHostConnectionsResponse,
  status: AccountStatus,
): void {
  const context = readExecutionContext();
  if (
    !context ||
    context.remote ||
    !context.controller.capabilities.remoteConnections ||
    status.state !== "signed-in" ||
    accountStatusScope(status) !== controlAccountScope()
  )
    return;
  const seen = new Set(sessions.map((session) => session.host.executionScope.environmentId));
  seen.add(context.controller.environmentId);
  const recovered: WorkspaceSession[] = [];
  for (const connection of response.connections) {
    if (
      connection.state &&
      ["stopped", "revoked", "needs-sign-in", "incompatible"].includes(connection.state)
    )
      continue;
    const host = parseWorkspaceHost(connection);
    if (!host || seen.has(host.executionScope.environmentId)) continue;
    const scope = host.executionScope;
    if (
      scope.userId !== status.me.id ||
      scope.organizationId !== status.me.organization.id ||
      scope.accountAuthority !== status.accountAuthority ||
      !response.pairedHosts?.some(
        (pair) => pair.hostId === host.hostId && pair.environmentId === scope.environmentId,
      )
    )
      continue;
    seen.add(scope.environmentId);
    recovered.push({ host });
  }
  // Backend desired connections are already durable. Polling must not replace live frames,
  // activate a remote route, or depend on sessionStorage being writable.
  if (recovered.length) publish([...sessions, ...recovered]);
}

export function addWorkspaceSession(value: ActiveHost): WorkspaceSession {
  const host = parseWorkspaceHost(value);
  if (!host) throw new Error("Select and verify this host in Connections first.");
  const context = readExecutionContext();
  if (!context || context.remote || context.controller.capabilities.remoteConnections !== true)
    throw new Error("Remote connections are unavailable on this computer.");
  if (host.executionScope.environmentId === context.controller.environmentId)
    throw new Error("This project already belongs to the local computer.");
  const previous = sessions.find(
    (entry) => entry.host.executionScope.environmentId === host.executionScope.environmentId,
  );
  if (previous) {
    if (JSON.stringify(previous.host.executionScope) !== JSON.stringify(host.executionScope))
      throw new Error(
        "This host's account or identity changed. Disconnect it before connecting again.",
      );
    return previous;
  }
  const next = { host };
  publish([...sessions, next], true);
  return next;
}

export function updateWorkspaceSession(
  environmentId: string,
  update: Partial<Omit<WorkspaceSession, "host">>,
): void {
  publish(
    sessions.map((session) =>
      session.host.executionScope.environmentId === environmentId
        ? { ...session, ...update }
        : session,
    ),
  );
}

/** Preserve editor drafts before closing backend access; completion must not retry recovery. */
export function prepareWorkspaceSessionRemoval(hostId: string) {
  const removed = sessions.filter((session) => session.host.hostId === hostId);
  const resumptions: (() => void)[] = [];
  const resume = () => {
    for (const restore of resumptions) restore();
  };
  try {
    for (const session of removed) {
      const restore = session.navigation?.recover();
      if (restore) resumptions.push(restore);
    }
  } catch (error) {
    resume();
    throw error;
  }
  const complete = () => {
    const next = sessions.filter((session) => session.host.hostId !== hostId);
    publish(next);
    try {
      sessionStorage.setItem(storageKey(), JSON.stringify(next.map(({ host }) => host)));
      return true;
    } catch {
      // An old saved frame must not reconnect a host that the user just disconnected.
      try {
        sessionStorage.removeItem(storageKey());
      } catch {
        /* The visible session is still removed when browser storage is unavailable. */
      }
      return false;
    }
  };
  return {
    complete,
    async close(closeConnection: () => Promise<unknown>): Promise<boolean> {
      try {
        await closeConnection();
      } catch (error) {
        resume();
        throw error;
      }
      return complete();
    },
  };
}

export function removeWorkspaceSession(hostId: string): boolean {
  return prepareWorkspaceSessionRemoval(hostId).complete();
}

/** Sign-out removes visible remote data; identity-scoped drafts remain recoverable. */
export function reconcileWorkspaceAccount(status: AccountStatus): void {
  if (readExecutionContext()?.remote) return;
  for (const session of sessions) {
    const scope = session.host.executionScope;
    if (
      status.state !== "signed-in" ||
      status.me.id !== scope.userId ||
      status.me.organization.id !== scope.organizationId ||
      status.accountAuthority !== scope.accountAuthority
    ) {
      try {
        session.navigation?.recover();
      } catch {
        /* Never expose an old account if recovery storage is unavailable. */
      } finally {
        publish(sessions.filter((entry) => entry !== session));
      }
    }
  }
  try {
    sessionStorage.setItem(storageKey(), JSON.stringify(sessions.map(({ host }) => host)));
  } catch {
    /* in-memory isolation still applies */
  }
}

export function readWorkspaceSessions(): readonly WorkspaceSession[] {
  return sessions;
}

/** A captured row/dialog can only act through the same connected owner and frame generation. */
export function readAvailableWorkspaceNavigation(
  session: WorkspaceSession,
): WorkspaceNavigation | undefined {
  const current = sessions.find((entry) => entry.host === session.host);
  return current?.navigation === session.navigation &&
    current?.summary?.state === "open" &&
    !current.error
    ? current.navigation
    : undefined;
}
export function subscribeWorkspaceSessions(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useWorkspaceSessions(): readonly WorkspaceSession[] {
  return useSyncExternalStore(
    subscribeWorkspaceSessions,
    readWorkspaceSessions,
    readWorkspaceSessions,
  );
}

export function waitForWorkspaceNavigation(environmentId: string): Promise<WorkspaceNavigation> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      listeners.delete(check);
      clearTimeout(timeout);
    };
    const check = () => {
      const session = sessions.find(
        (entry) => entry.host.executionScope.environmentId === environmentId,
      );
      if (session?.navigation) {
        cleanup();
        resolve(session.navigation);
      } else if (!session || session.error) {
        cleanup();
        reject(new Error(session?.error ?? "This computer is no longer connected."));
      }
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("This computer did not become ready. Try again after reconnecting."));
    }, 60_000);
    listeners.add(check);
    check();
  });
}
