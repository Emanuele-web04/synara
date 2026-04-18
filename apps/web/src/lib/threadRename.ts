// Purpose: Share the thread-title rename flow between header and sidebar surfaces,
// including draft-thread promotion when a title is edited before the first send.
// The promotion path mirrors the first-send flow: dispatch `thread.create` with the
// chosen title, then trust the existing push-event listeners in routes/__root.tsx
// to add the server thread to the store and clear the local draft. Doing the snapshot
// sync here would race with those listeners and cause the route guard to bounce the
// user to a fresh "New chat" because of a brief gap where neither draft nor server
// thread exist in the store.

import {
  type ModelSelection,
  type ProjectId,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ThreadId,
} from "@t3tools/contracts";
import { type DraftThreadEnvMode } from "../composerDraftStore";
import { readNativeApi } from "../nativeApi";
import { newCommandId } from "./utils";

type ThreadRenameOutcome = "empty" | "unchanged" | "unavailable" | "renamed";

export async function dispatchThreadRename(input: {
  threadId: ThreadId;
  newTitle: string;
  unchangedTitles: readonly string[];
  createIfMissing?:
    | {
        projectId: ProjectId;
        modelSelection: ModelSelection;
        runtimeMode: RuntimeMode;
        interactionMode: ProviderInteractionMode;
        envMode: DraftThreadEnvMode;
        branch: string | null;
        worktreePath: string | null;
        createdAt: string;
      }
    | undefined;
}): Promise<ThreadRenameOutcome> {
  const trimmed = input.newTitle.trim();
  if (trimmed.length === 0) {
    return "empty";
  }
  if (input.unchangedTitles.includes(trimmed)) {
    return "unchanged";
  }

  const api = readNativeApi();
  if (!api) {
    return "unavailable";
  }

  if (input.createIfMissing) {
    await api.orchestration.dispatchCommand({
      type: "thread.create",
      commandId: newCommandId(),
      threadId: input.threadId,
      projectId: input.createIfMissing.projectId,
      title: trimmed,
      modelSelection: input.createIfMissing.modelSelection,
      runtimeMode: input.createIfMissing.runtimeMode,
      interactionMode: input.createIfMissing.interactionMode,
      envMode: input.createIfMissing.envMode,
      branch: input.createIfMissing.branch,
      worktreePath: input.createIfMissing.worktreePath,
      createdAt: input.createIfMissing.createdAt,
    });
  } else {
    await api.orchestration.dispatchCommand({
      type: "thread.meta.update",
      commandId: newCommandId(),
      threadId: input.threadId,
      title: trimmed,
    });
  }

  return "renamed";
}
