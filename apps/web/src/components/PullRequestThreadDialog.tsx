import type { GitResolvePullRequestResult } from "@synara/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useDebouncedValue } from "@tanstack/react-pacer";
import { useEffect, useRef, useState } from "react";

import {
  gitPreparePullRequestThreadMutationOptions,
  gitResolvePullRequestQueryOptions,
} from "~/lib/gitReactQuery";
import { cn } from "~/lib/utils";
import { parsePullRequestReference } from "~/pullRequestReference";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Spinner } from "./ui/spinner";

interface PullRequestThreadDialogProps {
  open: boolean;
  cwd: string | null;
  initialReference: string | null;
  onOpenChange: (open: boolean) => void;
  onPrepared: (input: {
    branch: string;
    worktreePath: string | null;
    pullRequest: NonNullable<GitResolvePullRequestResult["pullRequest"]>;
  }) => Promise<void> | void;
}

export function PullRequestThreadDialog({
  open,
  cwd,
  initialReference,
  onOpenChange,
  onPrepared,
}: PullRequestThreadDialogProps) {
  // Mirrors the content's prepare-in-flight state so the close guard can live
  // up here while all form state resets by unmounting below DialogPopup.
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!busy) {
          onOpenChange(nextOpen);
        }
      }}
    >
      <DialogPopup className="max-w-xl">
        <PullRequestThreadDialogContent
          cwd={cwd}
          initialReference={initialReference}
          onOpenChange={onOpenChange}
          onPrepared={onPrepared}
          onBusyChange={setBusy}
        />
      </DialogPopup>
    </Dialog>
  );
}

function PullRequestThreadDialogContent({
  cwd,
  initialReference,
  onOpenChange,
  onPrepared,
  onBusyChange,
}: Omit<PullRequestThreadDialogProps, "open"> & {
  onBusyChange: (busy: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const referenceInputRef = useRef<HTMLInputElement>(null);
  const [reference, setReference] = useState(initialReference ?? "");
  const [referenceDirty, setReferenceDirty] = useState(false);
  const [preparingMode, setPreparingMode] = useState<"local" | "worktree" | null>(null);
  const [debouncedReference, referenceDebouncer] = useDebouncedValue(
    reference,
    { wait: 450 },
    (debouncerState) => ({ isPending: debouncerState.isPending }),
  );

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      referenceInputRef.current?.focus();
      referenceInputRef.current?.select();
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [open]);

  const parsedReference = parsePullRequestReference(reference);
  const parsedDebouncedReference = parsePullRequestReference(debouncedReference);
  const resolvePullRequestQuery = useQuery(
    gitResolvePullRequestQueryOptions({
      cwd,
      reference: parsedDebouncedReference,
    }),
  );
  const cachedPullRequest =
    cwd && parsedReference
      ? (queryClient.getQueryData<GitResolvePullRequestResult>([
          "git",
          "pull-request",
          cwd,
          parsedReference,
        ])?.pullRequest ?? null)
      : null;
  const preparePullRequestThreadMutation = useMutation(
    gitPreparePullRequestThreadMutationOptions({ cwd, queryClient }),
  );

  const liveResolvedPullRequest =
    parsedReference !== null && parsedReference === parsedDebouncedReference
      ? (resolvePullRequestQuery.data?.pullRequest ?? null)
      : null;
  const resolvedPullRequest = liveResolvedPullRequest ?? cachedPullRequest;
  const isResolving =
    parsedReference !== null &&
    resolvedPullRequest === null &&
    (referenceDebouncer.state.isPending ||
      parsedReference !== parsedDebouncedReference ||
      resolvePullRequestQuery.isPending ||
      resolvePullRequestQuery.isFetching);
  let statusTone: string;
  switch (resolvedPullRequest?.state) {
    case "merged":
      statusTone = "text-status-merged";
      break;
    case "closed":
      statusTone = "text-status-neutral";
      break;
    case "open":
      statusTone = "text-status-open";
      break;
    default:
      statusTone = "text-muted-foreground";
  }

  // Promise chain instead of async/try-finally: React Compiler does not yet
  // support try/finally, and it would skip optimizing this whole component.
  const handleConfirm = (mode: "local" | "worktree") => {
    if (!parsedReference) {
      setReferenceDirty(true);
      return;
    }
    if (!parsedReference || !resolvedPullRequest || !cwd) {
      return;
    }
    setPreparingMode(mode);
    onBusyChange(true);
    void preparePullRequestThreadMutation
      .mutateAsync({
        reference: parsedReference,
        mode,
      })
      .then((result) =>
        Promise.resolve(
          onPrepared({
            branch: result.branch,
            worktreePath: result.worktreePath,
            pullRequest: resolvedPullRequest,
          }),
        ).then(() => {
          onOpenChange(false);
        }),
      )
      .catch(() => undefined)
      .finally(() => {
        setPreparingMode(null);
        onBusyChange(false);
      });
  };

  const validationMessage = !referenceDirty
    ? null
    : reference.trim().length === 0
      ? "Paste a GitHub pull request URL or enter 123 / #123."
      : parsedReference === null
        ? "Use a GitHub pull request URL, 123, or #123."
        : null;
  const errorMessage =
    validationMessage ??
    (resolvedPullRequest === null && resolvePullRequestQuery.isError
      ? resolvePullRequestQuery.error instanceof Error
        ? resolvePullRequestQuery.error.message
        : "Failed to resolve pull request."
      : preparePullRequestThreadMutation.error instanceof Error
        ? preparePullRequestThreadMutation.error.message
        : preparePullRequestThreadMutation.error
          ? "Failed to prepare pull request thread."
          : null);

  return (
    <>
      <DialogHeader>
        <DialogTitle>Check out pull request</DialogTitle>
        <DialogDescription>
          Resolve a GitHub pull request, then create the draft thread in the main repo or in a
          dedicated worktree.
        </DialogDescription>
      </DialogHeader>
      <DialogPanel className="space-y-4">
        <label className="grid gap-1.5">
          <span className="text-ui leading-snug font-medium text-foreground">Pull request</span>
          <Input
            ref={referenceInputRef}
            placeholder="https://github.com/owner/repo/pull/42 or #42"
            value={reference}
            onChange={(event) => {
              setReferenceDirty(true);
              setReference(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key !== "Enter") {
                return;
              }
              event.preventDefault();
              if (!isResolving && !preparePullRequestThreadMutation.isPending) {
                void handleConfirm("local");
              }
            }}
          />
        </label>

        {resolvedPullRequest ? (
          <div className="rounded-xl border border-border/70 bg-muted/24 p-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate font-medium text-ui-lg leading-snug">
                  {resolvedPullRequest.title}
                </p>
                <p className="truncate text-muted-foreground text-ui leading-snug">
                  #{resolvedPullRequest.number} · {resolvedPullRequest.headBranch} to{" "}
                  {resolvedPullRequest.baseBranch}
                </p>
              </div>
              <span className={cn("shrink-0 text-ui leading-snug capitalize", statusTone)}>
                {resolvedPullRequest.state}
              </span>
            </div>
          </div>
        ) : null}

        {isResolving ? (
          <div className="flex items-center gap-2 text-muted-foreground text-ui leading-snug">
            <Spinner className="size-3.5" />
            Resolving pull request…
          </div>
        ) : null}

        {errorMessage ? (
          <p role="alert" className="text-destructive text-ui leading-snug">
            {errorMessage}
          </p>
        ) : null}
      </DialogPanel>
      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => onOpenChange(false)}
          disabled={preparePullRequestThreadMutation.isPending}
        >
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => {
            void handleConfirm("local");
          }}
          disabled={
            !cwd ||
            !resolvedPullRequest ||
            isResolving ||
            preparePullRequestThreadMutation.isPending
          }
        >
          {preparingMode === "local" ? "Preparing local…" : "Local"}
        </Button>
        <Button
          type="button"
          size="sm"
          onClick={() => {
            void handleConfirm("worktree");
          }}
          disabled={
            !cwd ||
            !resolvedPullRequest ||
            isResolving ||
            preparePullRequestThreadMutation.isPending
          }
        >
          {preparingMode === "worktree" ? "Preparing worktree…" : "Worktree"}
        </Button>
      </DialogFooter>
    </>
  );
}
