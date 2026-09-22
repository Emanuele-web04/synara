// FILE: groupWorkerRouting.ts
// Purpose: Resolves and applies a Group's coordinator worker-routing defaults
//          for a new chat draft. Kept apart from groupProjects.ts so the
//          container classifiers stay light for broadly-imported modules like
//          lib/spaces.ts.
// Layer: Web orchestration helper
// Exports: resolveGroupWorkerRoutingDefaults, applyGroupWorkerRoutingDefaults

import { type ProjectId, type ThreadId } from "@synara/contracts";

import { useComposerDraftStore } from "../composerDraftStore";
import { readNativeApi } from "../nativeApi";
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

export function applyGroupWorkerRoutingDefaults(input: {
  readonly threadId: ThreadId;
  readonly defaults: ContainerThreadDefaults;
}): void {
  const draftStore = useComposerDraftStore.getState();
  if (input.defaults.modelSelection) {
    draftStore.setModelSelection(input.threadId, input.defaults.modelSelection);
  }
  if (input.defaults.providerOptions) {
    draftStore.setProviderOptionsForDispatch(input.threadId, input.defaults.providerOptions);
  }
}
