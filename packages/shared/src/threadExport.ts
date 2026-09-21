// exports must not capture in-flight output — a partial response would serialize as a completed message; shared by the server's 409 guard and the web composer so they can't drift

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
