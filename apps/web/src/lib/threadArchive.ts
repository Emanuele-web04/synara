// FILE: threadArchive.ts
// Purpose: Dispatches thread archive/unarchive commands from the client.
// Layer: Web orchestration helper
// Exports: archiveThreadFromClient, unarchiveThreadFromClient, isThreadAlreadyUnarchivedError

import type { NativeApi, ThreadId } from "@synara/contracts";
import {
  collectErrorMessages,
  THREAD_NOT_ARCHIVED_INVARIANT_MARKER,
} from "@synara/shared/errorMessages";

import { newCommandId } from "./utils";

type ThreadCommandDispatcher = Pick<NativeApi["orchestration"], "dispatchCommand">;

// Archives a thread on the server. Archived threads are hidden from the sidebar
// but can be restored later via {@link unarchiveThreadFromClient}.
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

// Detects the server invariant returned when an Undo races another restore (the
// thread is already unarchived). Matches the marker the server embeds in the
// invariant message — a single shared source of truth so the two sides cannot
// drift — and scopes it to the unarchive command and this thread so unrelated
// invariants (e.g. "thread not found") never read as "already restored".
export function isThreadAlreadyUnarchivedError(error: unknown, threadId: ThreadId): boolean {
  const errorText = collectErrorMessages(error).join("\n");
  return (
    errorText.includes("thread.unarchive") &&
    errorText.includes(THREAD_NOT_ARCHIVED_INVARIANT_MARKER) &&
    errorText.includes(String(threadId))
  );
}

// Restores a previously archived thread back into the sidebar.
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
