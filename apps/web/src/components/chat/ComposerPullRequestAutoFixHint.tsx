// FILE: ComposerPullRequestAutoFixHint.tsx
// Purpose: Composer tip offering Auto-fix CI (Beta) on the chat's open pull request, with
// one-click "Turn on" (same switch as the PR menu checkbox) and a permanent dismiss.
// Layer: Chat composer UI
// Exports: ComposerPullRequestAutoFixHint

import type { ThreadId } from "@synara/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useAppSettings } from "~/appSettings";
import { PULL_REQUEST_AUTO_FIX_ON } from "~/betaFeatures";
import { GitPullRequestIcon } from "~/lib/icons";
import {
  pullRequestAutoFixQueryOptions,
  pullRequestSetAutoFixMutationOptions,
} from "~/lib/pullRequestReactQuery";
import { toastManager } from "../ui/toast";
import { DEFAULT_TOAST_TIMEOUT_MS } from "../ui/toast.logic";
import {
  PULL_REQUEST_AUTO_FIX_HINT_ACTION_LABEL,
  PULL_REQUEST_AUTO_FIX_HINT_MESSAGE,
  shouldShowPullRequestAutoFixHint,
} from "./ComposerPullRequestAutoFixHint.logic";
import { COMPOSER_STACKED_PANEL_ICON_CLASS_NAME } from "./composerStackedPanelStyles";
import { findPullRequestAutoFixState } from "./environment/environmentPullRequest.logic";
import { ComposerTipRow } from "./ComposerTipRow";

interface ComposerPullRequestAutoFixHintProps {
  threadId: ThreadId;
  isServerThread: boolean;
  /** The PR git status reports for the chat's checked-out branch. */
  pullRequest: { url: string; state: "open" | "closed" | "merged" } | null;
  isWorking: boolean;
  attachedToPrevious?: boolean;
}

export function ComposerPullRequestAutoFixHint({
  threadId,
  isServerThread,
  pullRequest,
  isWorking,
  attachedToPrevious,
}: ComposerPullRequestAutoFixHintProps) {
  const queryClient = useQueryClient();
  const { settings, updateSettings } = useAppSettings();
  const dismissed = settings.dismissedPullRequestAutoFixHint;
  // Only ask the server once the cheap local checks pass.
  const candidate =
    PULL_REQUEST_AUTO_FIX_ON && isServerThread && !dismissed && pullRequest?.state === "open";
  const autoFixQuery = useQuery(pullRequestAutoFixQueryOptions(threadId, candidate));
  const mutation = useMutation(pullRequestSetAutoFixMutationOptions(queryClient));
  const turnOn = (pullRequestUrl: string) =>
    mutation.mutate(
      { threadId, enabled: true, pullRequestUrl },
      {
        onSuccess: () => updateSettings({ dismissedPullRequestAutoFixHint: true }),
        onError: (error) => {
          toastManager.add({
            type: "error",
            timeout: DEFAULT_TOAST_TIMEOUT_MS,
            title: "Couldn't turn on Auto-fix CI",
            description: error instanceof Error ? error.message : undefined,
          });
        },
      },
    );

  const visible = shouldShowPullRequestAutoFixHint({
    featureOn: PULL_REQUEST_AUTO_FIX_ON,
    isServerThread,
    pullRequestState: pullRequest?.state ?? null,
    dismissed,
    isWorking,
    autoFixState: autoFixQuery.data
      ? findPullRequestAutoFixState(autoFixQuery.data.states, pullRequest?.url)
      : undefined,
  });
  if (!visible || !pullRequest) return null;

  return (
    <ComposerTipRow
      icon={
        <GitPullRequestIcon aria-hidden="true" className={COMPOSER_STACKED_PANEL_ICON_CLASS_NAME} />
      }
      message={PULL_REQUEST_AUTO_FIX_HINT_MESSAGE}
      actionLabel={PULL_REQUEST_AUTO_FIX_HINT_ACTION_LABEL}
      actionDisabled={mutation.isPending}
      onAction={() => turnOn(pullRequest.url)}
      onDismiss={() => updateSettings({ dismissedPullRequestAutoFixHint: true })}
      attachedToPrevious={attachedToPrevious ?? false}
      testId="composer-pull-request-auto-fix-hint"
    />
  );
}
