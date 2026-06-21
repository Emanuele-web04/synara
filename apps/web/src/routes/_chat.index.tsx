// FILE: _chat.index.tsx
// Purpose: Restores the last chat route on app launch, falling back to a fresh home-chat draft.
// Layer: Routing
// Depends on: the shared restore/create route surface plus the home-chat new-chat handler.

import { createFileRoute } from "@tanstack/react-router";
import { useCallback } from "react";

import { RestoreOrCreateChatRoute } from "../components/RestoreOrCreateChatRoute";
import { useHandleNewChat } from "../hooks/useHandleNewChat";
import { EMPTY_THREAD_IDS, useStore } from "../store";

function ChatIndexRouteView() {
  const { handleNewChat } = useHandleNewChat();
  const threadIds = useStore((state) => state.threadIds ?? EMPTY_THREAD_IDS);
  const createFreshChat = useCallback(() => handleNewChat({ fresh: true }), [handleNewChat]);

  // Home chats can restore any thread.
  return (
    <RestoreOrCreateChatRoute restorableThreadIds={threadIds} createFreshChat={createFreshChat} />
  );
}

export const Route = createFileRoute("/_chat/")({
  component: ChatIndexRouteView,
});
