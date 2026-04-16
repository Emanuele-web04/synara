// FILE: DiffPanel.logic.ts
// Purpose: Resolve the thread context the diff panel should use across server-backed and local draft chats.
// Exports: resolveDiffPanelThread
// Depends on: ChatView.logic draft-thread normalization.

import { DEFAULT_MODEL_BY_PROVIDER, type ModelSelection, type ThreadId } from "@t3tools/contracts";

import type { DraftThreadState } from "../composerDraftStore";
import type { Thread } from "../types";
import { buildLocalDraftThread } from "./ChatView.logic";

// Reuse the chat-view draft fallback so diff surfaces keep working before the first server turn exists.
export function resolveDiffPanelThread(input: {
  threadId: ThreadId | null | undefined;
  serverThread: Thread | undefined;
  draftThread: DraftThreadState | null | undefined;
  fallbackModelSelection: ModelSelection | null | undefined;
}): Thread | undefined {
  if (input.serverThread) {
    return input.serverThread;
  }
  if (!input.threadId || !input.draftThread) {
    return undefined;
  }

  return buildLocalDraftThread(
    input.threadId,
    input.draftThread,
    input.fallbackModelSelection ?? {
      provider: "codex",
      model: DEFAULT_MODEL_BY_PROVIDER.codex,
    },
    null,
  );
}
