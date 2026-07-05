// FILE: threadExport.ts
// Purpose: Single source of truth for when a thread transcript may be exported.
//          Exports must not capture in-flight output: a partial assistant
//          response would be serialized as if it were a completed message.
// Layer: Shared runtime utility (used by the server export route's 409 guard
//         and the web composer's /export availability so they cannot drift).
// Exports: threadExportBlockedReason.

export interface ThreadExportSnapshot {
  readonly latestTurn: { readonly state: string } | null;
  readonly messages: ReadonlyArray<{ readonly streaming: boolean }>;
}

export function threadExportBlockedReason(thread: ThreadExportSnapshot): string | null {
  if (thread.latestTurn?.state === "running") {
    return "Thread is still running. Wait for the current turn to finish before exporting.";
  }
  if (thread.messages.some((message) => message.streaming)) {
    return "Thread has a streaming message. Wait for the current response to finish before exporting.";
  }
  return null;
}
