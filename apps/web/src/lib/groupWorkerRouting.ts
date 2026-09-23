// FILE: groupWorkerRouting.ts
// Purpose: Resolves and applies a Group's coordinator worker-routing defaults
//          for a new chat draft. Kept apart from groupProjects.ts so the
//          container classifiers stay light for broadly-imported modules like
//          lib/spaces.ts.
// Layer: Web orchestration helper
// Exports: resolveGroupWorkerRoutingDefaults, applyGroupWorkerRoutingDefaults,
//          resolveGroupContainerThreadDefaults

import { type ProjectId, type ServerProviderStatus, type ThreadId } from "@synara/contracts";

import { useComposerDraftStore } from "../composerDraftStore";
import { readNativeApi } from "../nativeApi";
import { useStore } from "../store";
import type { ThreadPrimarySurface } from "../types";
import { useWorkspacePathsStore } from "../workspacePathsStore";
import { isGroupContainerProject } from "./groupProjects";
import { findProviderStatus, isProviderUsable } from "./providerAvailability";
import type { ContainerThreadDefaults } from "./startContainerChat";

// New chats inside a group inherit the coordinator's worker routing defaults.
// Resolution runs before the thread is minted (the getOverview round trip
// cannot overlap the user); application is a synchronous write onto the fresh
// draft — model selection goes straight on, provider start options ride on
// the draft so the first send dispatches with them.
export async function resolveGroupWorkerRoutingDefaults(input: {
  readonly groupProjectId: ProjectId;
}): Promise<ContainerThreadDefaults | null> {
  const api = readNativeApi();
  if (!api) {
    return null;
  }
  const overview = await api.projectAgent
    .getOverview({ projectId: input.groupProjectId })
    .catch(() => null);
  const workerRouting = overview?.config?.workerRouting;
  if (!workerRouting) {
    return null;
  }
  return {
    modelSelection: workerRouting.modelSelection,
    providerOptions: workerRouting.providerOptions,
  };
}

// The group's Thread model is a draft *default*, not a lock: it is pinned as
// the active provider only while that provider is usable (installed and
// authenticated). When it is not, the configured model is still recorded as
// the draft's per-provider default but the usable fallback the composer
// already resolved stays active, so a send is never blocked by the group's
// routing. An empty `providerStatuses` means availability has not been
// reconciled yet — the seed pins optimistically and the send-time
// availability check decides, matching the sticky-seed behavior.
export function applyGroupWorkerRoutingDefaults(input: {
  readonly threadId: ThreadId;
  readonly defaults: ContainerThreadDefaults;
  readonly providerStatuses: readonly ServerProviderStatus[];
}): void {
  const draftStore = useComposerDraftStore.getState();
  const modelSelection = input.defaults.modelSelection;
  if (modelSelection) {
    const status = findProviderStatus(input.providerStatuses, modelSelection.provider);
    if (input.providerStatuses.length === 0 || isProviderUsable(status)) {
      draftStore.setModelSelection(input.threadId, modelSelection);
    } else {
      draftStore.seedModelSelection(input.threadId, modelSelection);
    }
  }
  if (input.defaults.providerOptions) {
    draftStore.setProviderOptionsForDispatch(input.threadId, input.defaults.providerOptions);
  }
}

// A fresh chat draft minted inside a group container inherits the group's
// coordinator worker-routing defaults (model selection / provider options) as
// its seed — the app-level sticky/default selection would otherwise win and
// the composer would silently ignore the group's configured routing. Terminal
// threads carry no model and ordinary projects have no worker routing, so
// both resolve to null before any RPC. The overview round trip runs before
// the draft stage so the apply stays synchronous with the mint.
export async function resolveGroupContainerThreadDefaults(input: {
  readonly projectId: ProjectId;
  readonly entryPoint: ThreadPrimarySurface;
}): Promise<ContainerThreadDefaults | null> {
  if (input.entryPoint !== "chat") {
    return null;
  }
  const project = useStore
    .getState()
    .projects.find((candidate) => candidate.id === input.projectId);
  if (!project) {
    return null;
  }
  const paths = useWorkspacePathsStore.getState();
  if (
    !isGroupContainerProject(project, {
      homeDir: paths.homeDir,
      chatWorkspaceRoot: paths.chatWorkspaceRoot,
      studioWorkspaceRoot: paths.studioWorkspaceRoot,
      groupsWorkspaceRoot: paths.groupsWorkspaceRoot,
    })
  ) {
    return null;
  }
  return resolveGroupWorkerRoutingDefaults({ groupProjectId: input.projectId });
}
