// FILE: terminalThreadTitleTracker.ts
// Purpose: Tracks per-terminal input buffers and emits safe one-shot thread title updates.
// Layer: Server terminal metadata helper
// Exports: TerminalThreadTitleTracker

import {
  consumeTerminalThreadTitleInput,
  isGenericTerminalThreadTitle,
} from "./terminalThreadTitle";

function terminalTitleSessionKey(threadId: string, terminalId: string): string {
  return `${threadId}:${terminalId}`;
}

export class TerminalThreadTitleTracker {
  private readonly bufferBySession = new Map<string, string>();

  reset(threadId: string, terminalId?: string | null): void {
    if (terminalId && terminalId.length > 0) {
      this.bufferBySession.delete(terminalTitleSessionKey(threadId, terminalId));
      return;
    }
    for (const key of Array.from(this.bufferBySession.keys())) {
      if (key.startsWith(`${threadId}:`)) {
        this.bufferBySession.delete(key);
      }
    }
  }

  // Returns a safe title only when a submitted command should rename a generic thread.
  consumeWrite(input: {
    currentTitle: string | null | undefined;
    data: string;
    terminalId: string;
    threadId: string;
  }): string | null {
    const sessionKey = terminalTitleSessionKey(input.threadId, input.terminalId);
    const nextInputState = consumeTerminalThreadTitleInput(
      this.bufferBySession.get(sessionKey) ?? "",
      input.data,
    );

    if (nextInputState.buffer.length > 0) {
      this.bufferBySession.set(sessionKey, nextInputState.buffer);
    } else {
      this.bufferBySession.delete(sessionKey);
    }

    if (!nextInputState.title || !isGenericTerminalThreadTitle(input.currentTitle)) {
      return null;
    }
    return nextInputState.title;
  }
}
