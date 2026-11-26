// FILE: PullRequestConfirmActionDialog.tsx
// Purpose: The one confirmation dialog for the irreversible pull request actions (merge,
//          close), shared by the PR detail panel and the Environment panel's PR menu, plus the
//          "copy PR link" helper both surfaces expose next to those actions.
// Layer: Pull request UI
// Depends on: the shared alert dialog, toast manager, and clipboard helper.

import type { PullRequestMergeMethod, PullRequestStack } from "@synara/contracts";
import { useState } from "react";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { Button } from "~/components/ui/button";
import { toastManager } from "~/components/ui/toast";
import { copyTextToClipboard } from "~/hooks/useCopyToClipboard";
import { t, useTranslation } from "~/i18n";

export type PullRequestConfirmAction =
  | { kind: "merge"; method: PullRequestMergeMethod }
  | { kind: "close" };

export function copyPullRequestLink(url: string): void {
  void copyTextToClipboard(url)
    .then(() => {
      toastManager.add({ type: "success", title: t("git:linkCopied") });
    })
    .catch((error: unknown) => {
      toastManager.add({
        type: "error",
        title: t("git:couldNotCopyLink"),
        description: error instanceof Error ? error.message : t("git:clipboardAccessFailed"),
      });
    });
}

function confirmTitle(
  action: PullRequestConfirmAction,
  stack: PullRequestStack | null,
  stackMergeTargetCount: number,
): string {
  if (action.kind === "close") return t("git:closePullRequest2");
  return stack
    ? t("git:merge2", {
        value0: stackMergeTargetCount,
        value1: stackMergeTargetCount === 1 ? t("chat:pullRequest") : t("git:pullRequests2"),
      })
    : t("git:mergePullRequest");
}

function confirmDescription(
  action: PullRequestConfirmAction,
  number: number,
  baseBranch: string | null,
  stack: PullRequestStack | null,
): string {
  if (action.kind === "close") return t("git:thisWillCloseWithoutMergingIt", { value0: number });
  if (stack) {
    return t("git:thisWillAtomicallyMergeEveryOpenPullRequestThrough", {
      value0: number,
      value1: stack.baseBranch,
      value2: action.method,
      value3:
        stack.position < stack.size ? t("git:pullRequestsAboveItWillRemainOpenAndGitHub") : "",
    });
  }
  return t("git:thisWillMergeUsing", {
    value0: number,
    value1: baseBranch ? ` into ${baseBranch}` : "",
    value2: action.method,
  });
}

export function PullRequestConfirmActionDialog({
  action,
  number,
  baseBranch = null,
  stack,
  stackMergeTargetCount,
  pending,
  onConfirm,
  onDismiss,
}: {
  /** The action awaiting confirmation; null keeps the dialog closed. */
  action: PullRequestConfirmAction | null;
  number: number;
  baseBranch?: string | null;
  stack: PullRequestStack | null;
  stackMergeTargetCount: number;
  pending: boolean;
  onConfirm: (action: PullRequestConfirmAction) => void;
  onDismiss: () => void;
}) {
  const { t } = useTranslation();

  // Keep rendering the last action while the dialog animates out, so the copy does not
  // flip to another action's text once the owner resets `action` to null.
  const [shownAction, setShownAction] = useState(action);
  // Compared by value: owners may build the action object inline on every render.
  if (
    action !== null &&
    (shownAction === null ||
      action.kind !== shownAction.kind ||
      (action.kind === "merge" &&
        shownAction.kind === "merge" &&
        action.method !== shownAction.method))
  ) {
    setShownAction(action);
  }
  const shown = action ?? shownAction;

  return (
    <AlertDialog
      open={action !== null}
      onOpenChange={(open) => {
        if (!open) onDismiss();
      }}
    >
      <AlertDialogPopup>
        {shown ? (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {confirmTitle(shown, stack, stackMergeTargetCount)}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {confirmDescription(shown, number, baseBranch, stack)}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogClose render={<Button variant="outline" size="sm" />}>
                {t("common:form_cancel")}
              </AlertDialogClose>
              <Button
                size="sm"
                variant={shown.kind === "close" ? "destructive" : "default"}
                disabled={pending}
                onClick={() => {
                  onDismiss();
                  onConfirm(shown);
                }}
              >
                {shown.kind === "close"
                  ? t("common:app_close")
                  : stack
                    ? t("git:mergeStack")
                    : t("git:merge")}
              </Button>
            </AlertDialogFooter>
          </>
        ) : null}
      </AlertDialogPopup>
    </AlertDialog>
  );
}
