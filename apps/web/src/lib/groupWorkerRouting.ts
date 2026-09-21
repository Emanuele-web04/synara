// FILE: groupWorkerRouting.ts
// Purpose: Applies a Group's coordinator worker-routing defaults to a new chat draft.
//          Kept apart from groupProjects.ts so the container classifiers stay light for
//          broadly-imported modules like lib/spaces.ts.
// Layer: Web orchestration helper
// Exports: applyGroupWorkerRoutingDefaults

import { type ProjectId, type ThreadId } from "@synara/contracts";

import { useComposerDraftStore } from "../composerDraftStore";
import { readNativeApi } from "../nativeApi";

// New chats inside a group inherit the coordinator's worker routing defaults:
// model selection goes straight onto the draft, and provider start options ride
// on the draft so the first send dispatches with them.
export async function applyGroupWorkerRoutingDefaults(input: {
  readonly groupProjectId: ProjectId;
  readonly threadId: ThreadId;
}): Promise<void> {
  const api = readNativeApi();
  if (!api) {
    return;
  }
  const overview = await api.projectAgent
    .getOverview({ projectId: input.groupProjectId })
    .catch(() => null);
  const workerRouting = overview?.config?.workerRouting;
  if (!workerRouting) {
    return;
  }
  const draftStore = useComposerDraftStore.getState();
  if (workerRouting.modelSelection) {
    draftStore.setModelSelection(input.threadId, workerRouting.modelSelection);
  }
  if (workerRouting.providerOptions) {
    draftStore.setProviderOptionsForDispatch(input.threadId, workerRouting.providerOptions);
  }
}
