// FILE: _chat.index.tsx
// Purpose: Land the "New chat" route at "/" by bootstrapping a fresh home-based chat draft so
//          the full thread composer (attach, full-access, model picker, effort, mic, send)
//          is rendered by ChatView without leaking the landing state into the visible chat list.
// Layer: Routing
// Depends on: useWorkspaceStore.homeDir, useHandleNewThread, and the shared hidden chat-project
//             helper so the route always opens a fresh chat row instead of creating visible folders.

import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef } from "react";

import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { ensureHomeChatProject } from "../lib/chatProjects";
import { useWorkspaceStore } from "../workspaceStore";

function ChatIndexRouteView() {
  const homeDir = useWorkspaceStore((state) => state.homeDir);
  const { handleNewThread } = useHandleNewThread();
  const hasRedirected = useRef(false);

  useEffect(() => {
    if (!homeDir || hasRedirected.current) return;
    hasRedirected.current = true;

    void (async () => {
      const homeChatProjectId = await ensureHomeChatProject(homeDir);
      if (!homeChatProjectId) {
        hasRedirected.current = false;
        return;
      }
      await handleNewThread(homeChatProjectId, {
        fresh: true,
        envMode: "local",
        worktreePath: null,
      });
    })();
  }, [handleNewThread, homeDir]);

  return null;
}

export const Route = createFileRoute("/_chat/")({
  component: ChatIndexRouteView,
});
