// FILE: useStartGitHubItemThread.ts
// Purpose: Hand a GitHub item to a fresh agent thread: for a pull request, prepare its branch
//          (worktree or local, per Settings) first; then open a new draft thread in the chosen
//          project and attach the item as a context card for the user to review and send. Used
//          by Send to agent (pull requests and issues) and the PR panel's Fix findings /
//          Resolve conflicts. Nothing is sent to a provider here.
// Layer: Web hook
// Exports: useStartGitHubItemThread, GitHubItemThreadAction

import type { ProjectId } from "@synara/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";

import { useAppSettings } from "~/appSettings";
import { toastManager } from "~/components/ui/toast";
import { addChatPullRequestContext } from "~/lib/chatReferences";
import { gitPreparePullRequestThreadMutationOptions } from "~/lib/gitReactQuery";
import type { PullRequestContextDraft } from "~/lib/pullRequestContext";
import { useStore } from "~/store";
import { useProjectEnvironmentStore } from "~/projectEnvironmentStore";
import { useHandleNewThread } from "./useHandleNewThread";

export type GitHubItemThreadAction = "send" | "findings" | "conflicts";

export interface StartGitHubItemThreadRequest {
  action: GitHubItemThreadAction;
  projectId: ProjectId;
  /** Pull requests only: the URL whose branch is prepared for the new thread. */
  pullRequestUrl?: string;
  /** Built once the environment is known: a prepared pull request branch is checked out. */
  card: (environment: { checkedOut: boolean }) => PullRequestContextDraft;
  errorTitle: string;
}

export function useStartGitHubItemThread(input: {
  /** The item's own project checkout, used when the target project has no known root. */
  workspaceRoot: string | null;
}) {
  const queryClient = useQueryClient();
  const { settings } = useAppSettings();
  const { handleNewThread } = useHandleNewThread();
  const [pendingAction, setPendingAction] = useState<GitHubItemThreadAction | null>(null);
  const inFlight = useRef(false);
  // Shared git prepare mutation (instead of a raw native call) so Git status/snapshot caches
  // invalidate exactly like every other prepare-thread flow in the app.
  const prepareThreadMutation = useMutation(
    gitPreparePullRequestThreadMutationOptions({ cwd: input.workspaceRoot, queryClient }),
  );

  // Promise chain instead of async/try-finally: React Compiler does not yet support
  // try/finally and would skip this hook.
  const start = (request: StartGitHubItemThreadRequest) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setPendingAction(request.action);
    const mode =
      useProjectEnvironmentStore.getState().envModeByProjectId[request.projectId] ??
      settings.defaultThreadEnvMode;
    const pullRequestUrl = request.pullRequestUrl;
    // A toast stays visible when the initiating menu closes and during navigation.
    const toastId = toastManager.add({
      type: "loading",
      title: pullRequestUrl
        ? mode === "worktree"
          ? "Preparing pull request worktree…"
          : "Checking out pull request branch…"
        : "Opening chat…",
      timeout: 0,
    });
    const targetCwd =
      useStore.getState().projects.find((project) => project.id === request.projectId)?.cwd ??
      undefined;
    const createThread =
      pullRequestUrl === undefined
        ? // An issue has no branch: the thread starts in the project like any new thread.
          Promise.resolve(handleNewThread(request.projectId, { envMode: mode, fresh: true })).then(
            (threadId) => ({ threadId, checkedOut: false }),
          )
        : prepareThreadMutation
            .mutateAsync({ reference: pullRequestUrl, mode, cwd: targetCwd })
            .then((prepared) => {
              toastManager.update(toastId, { title: "Opening chat…" });
              return handleNewThread(request.projectId, {
                branch: prepared.branch,
                worktreePath: prepared.worktreePath,
                envMode: prepared.worktreePath ? "worktree" : "local",
                // An explicit handoff from the GitHub surface. Reusing the project's existing
                // draft can leave the user on this route and insert the card into a hidden
                // composer, making the button appear inert.
                fresh: true,
              });
            })
            .then((threadId) => ({ threadId, checkedOut: true }));
    void createThread
      .then(({ threadId, checkedOut }) => {
        if (!threadId) throw new Error("Could not create a draft thread for this item.");
        addChatPullRequestContext(threadId, request.card({ checkedOut }));
      })
      .catch((error: unknown) => {
        toastManager.add({
          type: "error",
          title: request.errorTitle,
          description: error instanceof Error ? error.message : "The thread could not be prepared.",
        });
      })
      .finally(() => {
        toastManager.close(toastId);
        inFlight.current = false;
        setPendingAction(null);
      });
  };

  return { start, pendingAction };
}
