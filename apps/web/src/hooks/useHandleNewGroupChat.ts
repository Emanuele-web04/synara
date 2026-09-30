// FILE: useHandleNewGroupChat.ts
// Purpose: Starts ordinary AI threads inside a specific Group container project.
//          Groups are explicit — never auto-created — so the target project id is
//          always passed in. The group's coordinator worker-routing defaults
//          (model selection / provider options) seed the fresh draft inside
//          handleNewThread, which is the single mint point for every
//          user-initiated thread in a group.
// Layer: Web hook
// Exports: useHandleNewGroupChat

import type { ProjectId } from "@synara/contracts";

import { startContainerChat, type StartContainerChatResult } from "../lib/startContainerChat";
import { useComposerDraftStore } from "../composerDraftStore";
import { useHandleNewThread } from "./useHandleNewThread";

export function useHandleNewGroupChat() {
  const { handleNewThread } = useHandleNewThread();

  const handleNewGroupChat = async (
    groupProjectId: ProjectId,
    options?: { fresh?: boolean },
  ): Promise<StartContainerChatResult> =>
    startContainerChat({
      ensureProjectId: () => Promise.resolve(groupProjectId),
      handleNewThread: (projectId, threadOptions) => {
        const storedDraft = useComposerDraftStore
          .getState()
          .getDraftThreadByProjectId(projectId, "chat");
        return handleNewThread(projectId, {
          ...threadOptions,
          // Migrate a pre-fix local draft in place: its ordinary reference folder was
          // stored in worktreePath even though no Git worktree existed.
          workingDirectory:
            threadOptions?.fresh === true
              ? null
              : (storedDraft?.workingDirectory ?? storedDraft?.worktreePath ?? null),
        });
      },
      fresh: options?.fresh,
      // A group owns one durable local workspace per chat. Reopening its stored draft
      // must never inherit an old project/worktree environment.
      forceLocalWorkspace: true,
      errorLabel: "Unable to prepare a new group chat.",
    });

  return { handleNewGroupChat };
}
