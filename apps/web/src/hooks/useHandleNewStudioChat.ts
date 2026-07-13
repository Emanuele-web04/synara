// FILE: useHandleNewStudioChat.ts
// Purpose: Starts ordinary AI threads inside the hidden Studio project container.
// Layer: Web hook
// Exports: useHandleNewStudioChat

import { useCallback } from "react";

import { ensureStudioProject } from "../lib/studioProjects";
import { startContainerChat, type StartContainerChatResult } from "../lib/startContainerChat";
import { useWorkspaceStore } from "../workspaceStore";
import { useHandleNewThread } from "./useHandleNewThread";

export function useHandleNewStudioChat() {
  const homeDir = useWorkspaceStore((state) => state.homeDir);
  const chatWorkspaceRoot = useWorkspaceStore((state) => state.chatWorkspaceRoot);
  const studioWorkspaceRoot = useWorkspaceStore((state) => state.studioWorkspaceRoot);
  const { handleNewThread } = useHandleNewThread();

  const handleNewStudioChat = useCallback(
    async (options?: { fresh?: boolean }): Promise<StartContainerChatResult> =>
      startContainerChat({
        ensureProjectId: () =>
          ensureStudioProject({ homeDir, chatWorkspaceRoot, studioWorkspaceRoot }),
        handleNewThread,
        fresh: options?.fresh,
        errorLabel: "Unable to prepare a new Studio chat.",
      }),
    [chatWorkspaceRoot, handleNewThread, homeDir, studioWorkspaceRoot],
  );

  return { handleNewStudioChat };
}
