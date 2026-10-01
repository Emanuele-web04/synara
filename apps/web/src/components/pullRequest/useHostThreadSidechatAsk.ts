// FILE: useHostThreadSidechatAsk.ts
// Purpose: Ask about a pull request shown in a chat thread's dock: the thread's own side chat
//          (its live one, or a new one from the thread's /side creator, which keeps the model,
//          permissions, and workspace inherited), seeded with the pull request's context card.
// Layer: Pull request presentation hook
// Exports: useHostThreadSidechatAsk

import type { ThreadId } from "@synara/contracts";
import { useState } from "react";

import { createGitHubItemContextDraft } from "~/components/chat/environment/environmentPullRequest.logic";
import { scheduleDeferredChatMount } from "~/components/chat/deferredChatMount";
import { toastManager } from "~/components/ui/toast";
import { requestComposerFocus } from "~/composerFocusRequestStore";
import { addChatPullRequestContext } from "~/lib/chatReferences";
import { waitForSidechatCreator } from "~/lib/sidechatCreatorRegistry";
import { selectRightDockState, useRightDockStore } from "~/rightDockStore";
import { resolveActivePane } from "~/rightDockStore.logic";
import { useStore } from "~/store";
import { createSidechatSummariesForSourceSelector } from "~/storeSelectors";
import type { GitHubItemAgentTarget } from "./githubItemAgentContext";

function seedAndFocus(threadId: ThreadId, target: GitHubItemAgentTarget): void {
  addChatPullRequestContext(
    threadId,
    createGitHubItemContextDraft(target.source, { checkedOut: false }),
  );
  // The pane's composer mounts after the dock switches tabs; focus it then.
  scheduleDeferredChatMount(window, () => requestComposerFocus(threadId));
}

export function useHostThreadSidechatAsk(hostThreadId: ThreadId | null) {
  const [pending, setPending] = useState(false);
  if (hostThreadId === null) return { ask: undefined, pending: false };

  const ask = (target: GitHubItemAgentTarget) => {
    if (pending) return;
    const live = createSidechatSummariesForSourceSelector(hostThreadId)(useStore.getState()).find(
      (thread) => !thread.sidechatExpiredAt,
    );
    if (live) {
      useRightDockStore.getState().openPane(hostThreadId, { kind: "sidechat", threadId: live.id });
      seedAndFocus(live.id, target);
      return;
    }
    setPending(true);
    void waitForSidechatCreator(hostThreadId)
      .then((createSidechat) => {
        if (!createSidechat) {
          toastManager.add({
            type: "warning",
            title: "Side chat is unavailable",
            description: "Open a server-backed main thread before starting a side chat.",
          });
          return;
        }
        return createSidechat().then(() => {
          // The creator opens the new side chat in this thread's dock.
          const pane = resolveActivePane(
            selectRightDockState(hostThreadId)(useRightDockStore.getState()),
          );
          if (pane?.kind === "sidechat" && pane.threadId) seedAndFocus(pane.threadId, target);
        });
      })
      .catch((error: unknown) => {
        toastManager.add({
          type: "error",
          title: "Could not start a side chat",
          description:
            error instanceof Error
              ? error.message
              : "An error occurred while creating the side chat.",
        });
      })
      .finally(() => setPending(false));
  };
  return { ask, pending };
}
