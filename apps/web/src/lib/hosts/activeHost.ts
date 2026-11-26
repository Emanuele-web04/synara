import { readWorkspaceFrame, workspaceRoute } from "./workspaceFrame";
import { addWorkspaceSession } from "./workspaceSessions";
import { recoverBeforeLocalEscape } from "./executionSwitch";
// Window selection contains only controller-verified identity metadata.
import type { RemoteExecutionScope } from "@synara/contracts";

const ACTIVE_HOST_STORAGE_KEY = "synara:active-host:v1";

export interface ActiveHost {
  readonly executionScope?: RemoteExecutionScope;
  readonly hostId: string;
  readonly hostName: string;
  /** The shell's local upgrade path for this host's bridged session. */
  readonly wsPath: string;
}

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

export function readActiveHost(): ActiveHost | null {
  return readWorkspaceFrame()?.host ?? null;
}

/** Read only during the one-way migration from window-wide selection. */
export function readLegacyActiveHost(): ActiveHost | null {
  const raw = storage()?.getItem(ACTIVE_HOST_STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ActiveHost>;
    if (
      typeof parsed.hostId === "string" &&
      typeof parsed.hostName === "string" &&
      typeof parsed.wsPath === "string" &&
      parsed.wsPath.startsWith("/")
    ) {
      return {
        hostId: parsed.hostId,
        hostName: parsed.hostName,
        wsPath: parsed.wsPath,
        ...(parsed.executionScope ? { executionScope: parsed.executionScope } : {}),
      };
    }
  } catch {
    // Fall through: a corrupt value is the same as none.
  }
  storage()?.removeItem(ACTIVE_HOST_STORAGE_KEY);
  return null;
}

/** Add an independently owned workspace without replacing the local runtime. */
export async function activateHost(host: ActiveHost): Promise<void> {
  const session = addWorkspaceSession(host);
  const { appHistory } = await import("../../appNavigation");
  appHistory.push(workspaceRoute(session.host.executionScope.environmentId));
}

export function deactivateHost(): void {
  const frame = readWorkspaceFrame();
  if (frame) {
    recoverBeforeLocalEscape();
    frame.close();
    return;
  }
  void import("../../appNavigation").then(({ appHistory }) => appHistory.push("/"));
}

export function clearLegacyActiveHost(): void {
  storage()?.removeItem(ACTIVE_HOST_STORAGE_KEY);
}
