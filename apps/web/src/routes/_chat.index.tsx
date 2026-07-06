// FILE: _chat.index.tsx
// Purpose: Restores the last chat route on app launch, falling back to a fresh home-chat draft.
// Layer: Routing
// Depends on: the shared restore/create route surface plus the home-chat new-chat handler.

import { createFileRoute } from "@tanstack/react-router";
import { useCallback } from "react";

import {
  RestoreOrCreateChatRoute,
  type RestoreRouteResolver,
} from "../components/RestoreOrCreateChatRoute";
import { readSidebarUiState } from "../components/Sidebar.uiState";
import { resolveRestorableThreadRoute } from "../chatRouteRestore";
import { useHandleNewChat } from "../hooks/useHandleNewChat";
import { EMPTY_THREAD_IDS, useStore } from "../store";

function ChatIndexRouteView() {
  const { handleNewChat } = useHandleNewChat();
  const threadIds = useStore((state) => state.threadIds ?? EMPTY_THREAD_IDS);
  const createFreshChat = useCallback(() => handleNewChat({ fresh: true }), [handleNewChat]);

  // Home chats can restore any thread, keyed off the last visited route.
  const resolveRestoreRoute = useCallback<RestoreRouteResolver>(
    ({ availableSplitViewIds }) =>
      resolveRestorableThreadRoute({
        lastThreadRoute: readSidebarUiState().lastThreadRoute,
        availableThreadIds: new Set(threadIds),
        availableSplitViewIds,
      }),
    [threadIds],
  );

  return (
    <RestoreOrCreateChatRoute
      resolveRestoreRoute={resolveRestoreRoute}
      createFreshChat={createFreshChat}
    />
  );
}

export const Route = createFileRoute("/_chat/")({
  component: ChatIndexRouteView,
});
