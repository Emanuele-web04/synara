// FILE: useOpenChat.ts
// Purpose: Opens a to-do's linked agent chat — the one navigation the task row and the
//          inspector share for every "Open chat" affordance.
// Layer: Tasks UI hook
// Exports: useOpenChat

import type { ThreadId } from "@synara/contracts";
import { useNavigate } from "@tanstack/react-router";

/** A handler that opens `threadId`'s chat; it does nothing while the to-do has no chat. */
export function useOpenChat(threadId: ThreadId | null): () => void {
  const navigate = useNavigate();
  return () => {
    if (threadId) void navigate({ to: "/$threadId", params: { threadId } });
  };
}
