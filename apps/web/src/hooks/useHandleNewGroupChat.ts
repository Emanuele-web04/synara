// FILE: useHandleNewGroupChat.ts
// Purpose: Starts ordinary AI threads inside a specific Group container project.
//          Groups are explicit — never auto-created — so the target project id is
//          always passed in. The group's coordinator worker-routing defaults
//          (model selection / provider options) are applied to the new chat.
// Layer: Web hook
// Exports: useHandleNewGroupChat

import type { ProjectId } from "@synara/contracts";

import {
  applyGroupWorkerRoutingDefaults,
  resolveGroupWorkerRoutingDefaults,
} from "../lib/groupWorkerRouting";
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
      resolveThreadDefaults: () => resolveGroupWorkerRoutingDefaults({ groupProjectId }),
      applyThreadDefaults: (threadId, defaults) =>
        applyGroupWorkerRoutingDefaults({ threadId, defaults }),
      errorLabel: "Unable to prepare a new group chat.",
    });

  return { handleNewGroupChat };
}
