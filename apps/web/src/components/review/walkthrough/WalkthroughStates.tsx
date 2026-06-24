import type { ReactElement, ReactNode } from "react";

import { rpcErrorMessage } from "~/lib/rpcErrorMessage";
import { GitPullRequestIcon, Loader2Icon, RefreshCwIcon, SparklesIcon } from "~/lib/icons";
import { Button } from "../../ui/button";
import { EmptyState } from "../reviewPrimitives";

export function WalkthroughLoading(props: { title: string; detail?: string }): ReactElement {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 text-center animate-in fade-in duration-200 ease-out motion-reduce:animate-none"
    >
      <Loader2Icon className="size-4 animate-spin text-muted-foreground motion-reduce:animate-none" />
      <p className="text-[13px] font-medium text-foreground">{props.title}</p>
      {props.detail ? (
        <p className="max-w-xs text-pretty text-[12px] text-muted-foreground">{props.detail}</p>
      ) : null}
    </div>
  );
}

function WalkthroughMessage(props: {
  icon: ReactElement;
  title: string;
  children: ReactNode;
}): ReactElement {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center animate-in fade-in duration-200 ease-out motion-reduce:animate-none">
      <EmptyState icon={props.icon} title={props.title}>
        {props.children}
      </EmptyState>
    </div>
  );
}

function WalkthroughRetry(props: {
  icon: ReactElement;
  title: string;
  message: string;
  idleLabel: string;
  busyLabel: string;
  busy: boolean;
  onRetry: () => void;
}): ReactElement {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center animate-in fade-in duration-200 ease-out motion-reduce:animate-none">
      <EmptyState
        icon={props.icon}
        title={props.title}
        action={
          <Button size="sm" variant="outline" disabled={props.busy} onClick={props.onRetry}>
            {props.busy ? (
              <Loader2Icon className="size-3.5 animate-spin motion-reduce:animate-none" />
            ) : (
              <RefreshCwIcon className="size-3.5" />
            )}
            {props.busy ? props.busyLabel : props.idleLabel}
          </Button>
        }
      >
        {props.message}
      </EmptyState>
    </div>
  );
}

export function renderWalkthroughStatus(args: {
  changesetError: unknown;
  changesetLoading: boolean;
  queryLoading: boolean;
  queryError: unknown;
  isError: boolean;
  headMoved: boolean;
  movedWarning: string | null;
  isEmpty: boolean;
  isFetching: boolean;
  onRetry: () => void;
}): ReactElement | null {
  if (args.changesetError) {
    return (
      <WalkthroughMessage icon={<GitPullRequestIcon />} title="Walkthrough unavailable">
        {rpcErrorMessage(args.changesetError) ??
          "Could not load the changeset for this walkthrough."}
      </WalkthroughMessage>
    );
  }

  if (args.changesetLoading) {
    return <WalkthroughLoading title="Loading changes" />;
  }

  if (args.queryLoading) {
    return (
      <WalkthroughLoading
        title="Generating walkthrough"
        detail="Reading the diff to break it into chapters"
      />
    );
  }

  if (args.isError) {
    return (
      <WalkthroughRetry
        icon={<SparklesIcon />}
        title="Generation failed"
        message={
          rpcErrorMessage(args.queryError) ??
          "Could not generate the walkthrough. Try again, or reopen this review."
        }
        idleLabel="Try again"
        busyLabel="Retrying"
        busy={args.isFetching}
        onRetry={args.onRetry}
      />
    );
  }

  if (args.headMoved) {
    return (
      <WalkthroughRetry
        icon={<GitPullRequestIcon />}
        title="Changes moved"
        message={
          args.movedWarning ??
          "The diff moved since this walkthrough was generated. Regenerate it to continue."
        }
        idleLabel="Regenerate"
        busyLabel="Regenerating"
        busy={args.isFetching}
        onRetry={args.onRetry}
      />
    );
  }

  if (args.isEmpty) {
    return (
      <WalkthroughMessage icon={<SparklesIcon />} title="No chapters">
        This change was too small to split into chapters.
      </WalkthroughMessage>
    );
  }

  return null;
}
