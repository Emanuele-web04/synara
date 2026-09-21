import type { NativeApi, ThreadId } from "@synara/contracts";
import {
  collectErrorMessages,
  THREAD_NOT_ARCHIVED_INVARIANT_MARKER,
} from "@synara/shared/errorMessages";

import { newCommandId } from "./utils";

type ThreadCommandDispatcher = Pick<NativeApi["orchestration"], "dispatchCommand">;

export async function archiveThreadFromClient(
  api: ThreadCommandDispatcher,
  threadId: ThreadId,
): Promise<void> {
  await api.dispatchCommand({
    type: "thread.archive",
    commandId: newCommandId(),
    threadId,
  });
}

// detects the server invariant for an Undo racing another restore (already unarchived): matches the server-embedded marker — one shared source of truth — scoped to unarchive + this thread so unrelated invariants never read as restored
export function isThreadAlreadyUnarchivedError(error: unknown, threadId: ThreadId): boolean {
  const errorText = collectErrorMessages(error).join("\n");
  return (
    errorText.includes("thread.unarchive") &&
    errorText.includes(THREAD_NOT_ARCHIVED_INVARIANT_MARKER) &&
    errorText.includes(String(threadId))
  );
}

export async function unarchiveThreadFromClient(
  api: ThreadCommandDispatcher,
  threadId: ThreadId,
): Promise<void> {
  await api.dispatchCommand({
    type: "thread.unarchive",
    commandId: newCommandId(),
    threadId,
  });
}
