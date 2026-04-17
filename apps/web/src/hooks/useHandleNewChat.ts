import { useCallback } from "react";

import { ensureHomeChatProject } from "../lib/chatProjects";
import type { NewThreadOptions } from "../lib/threadBootstrap";
import { useWorkspaceStore } from "../workspaceStore";
import { useHandleNewThread } from "./useHandleNewThread";

export function useHandleNewChat() {
  const homeDir = useWorkspaceStore((state) => state.homeDir);
  const { handleNewThread } = useHandleNewThread();

  const handleNewChat = useCallback(
    async (options?: { fresh?: boolean }): Promise<{ ok: true } | { ok: false; error: string }> => {
      if (!homeDir) {
        return {
          ok: false,
          error: "Home folder is not available yet.",
        };
      }

      const projectId = await ensureHomeChatProject(homeDir);
      if (!projectId) {
        return {
          ok: false,
          error: "Unable to prepare a new chat.",
        };
      }

      try {
        const threadOptions: NewThreadOptions | undefined =
          options?.fresh === true
            ? {
                fresh: true,
                envMode: "local",
                worktreePath: null,
              }
            : undefined;
        await handleNewThread(projectId, threadOptions);
        return { ok: true };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : "Unable to prepare a new chat.",
        };
      }
    },
    [handleNewThread, homeDir],
  );

  return { handleNewChat };
}
