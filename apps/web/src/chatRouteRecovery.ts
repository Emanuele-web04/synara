// FILE: chatRouteRecovery.ts
// Purpose: Gives route restore flows one authoritative backend refresh before falling back.
// Layer: Routing support
// Exports: empty-startup snapshot recovery helper shared by chat index and thread routes.

import type {
  NativeApi,
  OrchestrationReadModel,
  OrchestrationShellSnapshot,
} from "@synara/contracts";

import { EMPTY_ROUTE_RESTORE_FALLBACK_DELAY_MS } from "./chatRouteRestore";
import { useStore } from "./store";

function shellSnapshotHasProjectsOrThreads(snapshot: OrchestrationShellSnapshot): boolean {
  return snapshot.projects.length > 0 || snapshot.threads.length > 0;
}

function shellSnapshotHasThreads(snapshot: OrchestrationShellSnapshot): boolean {
  return snapshot.threads.length > 0;
}

function readModelHasProjectsOrThreads(snapshot: OrchestrationReadModel): boolean {
  return snapshot.projects.length > 0 || snapshot.threads.length > 0;
}

function readModelHasThreads(snapshot: OrchestrationReadModel): boolean {
  return snapshot.threads.length > 0;
}

export function waitForEmptyRouteRestoreFallbackDelay(): Promise<void> {
  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, EMPTY_ROUTE_RESTORE_FALLBACK_DELAY_MS);
  });
}

// Empty shell snapshots can arrive before desktop projection startup catches up.
// Try progressively stronger reads so route guards do not replace valid thread URLs.
export async function refreshEmptyRouteRestoreSnapshot(
  api: NativeApi | undefined,
): Promise<boolean> {
  if (!api) {
    return false;
  }

  const shellSnapshot = await api.orchestration.getShellSnapshot();
  if (shellSnapshotHasProjectsOrThreads(shellSnapshot)) {
    useStore.getState().syncServerShellSnapshot(shellSnapshot);
    if (shellSnapshotHasThreads(shellSnapshot)) {
      return true;
    }
    // Project-only shell snapshots do not prove route recovery is done; thread
    // projections may still need the full snapshot or repair path below.
  }

  const readModel = await api.orchestration.getSnapshot();
  if (readModelHasProjectsOrThreads(readModel)) {
    useStore.getState().syncServerReadModel(readModel);
    if (readModelHasThreads(readModel)) {
      return true;
    }
    // A project-only read model can still be repaired into thread projections.
  }

  const repairedReadModel = await api.orchestration.repairState();
  if (readModelHasProjectsOrThreads(repairedReadModel)) {
    useStore.getState().syncServerReadModel(repairedReadModel);
  }
  if (readModelHasThreads(repairedReadModel)) {
    return true;
  }

  return false;
}
