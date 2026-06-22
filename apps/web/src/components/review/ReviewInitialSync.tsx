import { CheckIcon, CloudSyncIcon, GitPullRequestIcon, RefreshCwIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Skeleton } from "../ui/skeleton";

export type ReviewInitialSyncStepState = "active" | "pending" | "done";

export interface ReviewInitialSyncStep {
  label: string;
  detail: string;
  state: ReviewInitialSyncStepState;
}

const DEFAULT_STEPS: ReadonlyArray<ReviewInitialSyncStep> = [
  {
    label: "Contacting GitHub",
    detail: "Checking the repository and viewer session.",
    state: "done",
  },
  {
    label: "Syncing pull requests",
    detail: "Loading the first review window with server-side filters.",
    state: "active",
  },
  {
    label: "Preparing facets",
    detail: "Indexing authors, labels, branches, checks, and review state.",
    state: "pending",
  },
];

function SyncStepIcon(props: { state: ReviewInitialSyncStepState }) {
  if (props.state === "done") {
    return <CheckIcon className="size-4 shrink-0 text-success-foreground" aria-hidden="true" />;
  }
  if (props.state === "active") {
    return (
      <RefreshCwIcon
        className="size-4 shrink-0 animate-spin text-info-foreground"
        aria-hidden="true"
      />
    );
  }
  return (
    <GitPullRequestIcon className="size-4 shrink-0 text-muted-foreground/55" aria-hidden="true" />
  );
}

function SyncStep(props: { step: ReviewInitialSyncStep }) {
  return (
    <li className="flex min-w-0 gap-2.5">
      <SyncStepIcon state={props.step.state} />
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium text-[12px] text-foreground">{props.step.label}</div>
        <p className="text-pretty text-[11px] text-muted-foreground/78">{props.step.detail}</p>
      </div>
    </li>
  );
}

export function ReviewInitialSyncPanel(props: {
  title?: string;
  detail?: string;
  steps?: ReadonlyArray<ReviewInitialSyncStep>;
  actionLabel?: string;
  onAction?: () => void;
  actionDisabled?: boolean;
  className?: string;
}) {
  const steps = props.steps ?? DEFAULT_STEPS;
  return (
    <section
      className={cn(
        "flex min-w-0 flex-col gap-4 rounded-[1.35rem] border border-border/60 bg-card/58 p-4 shadow-[0_14px_34px_-30px_var(--foreground)] dark:shadow-none",
        props.className,
      )}
      aria-busy="true"
      aria-label={props.title ?? "Syncing pull requests"}
    >
      <div className="flex min-w-0 items-start gap-3">
        <CloudSyncIcon className="size-4 shrink-0 text-info-foreground" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <h2 className="text-balance font-semibold text-[0.8125rem] text-foreground">
            {props.title ?? "Syncing pull requests"}
          </h2>
          <p className="max-w-[72ch] text-pretty text-[12px] text-muted-foreground/82">
            {props.detail ??
              "Synara is warming the review cache and applying filters on the server before rows appear."}
          </p>
        </div>
        {props.onAction ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-8 shrink-0 rounded-full bg-background/72 px-3 text-[12px] shadow-none"
            onClick={props.onAction}
            disabled={props.actionDisabled}
          >
            <RefreshCwIcon className={cn("size-4", props.actionDisabled && "animate-spin")} />
            {props.actionLabel ?? "Retry"}
          </Button>
        ) : null}
      </div>
      <ol className="grid gap-3 sm:grid-cols-3" role="list">
        {steps.map((step) => (
          <SyncStep key={step.label} step={step} />
        ))}
      </ol>
    </section>
  );
}

export function ReviewSyncRowsSkeleton(props: { rows?: number; compact?: boolean }) {
  return (
    <ul
      className={cn("flex flex-col gap-1.5", props.compact ? "mt-2" : "mt-3")}
      role="list"
      aria-hidden="true"
    >
      {Array.from({ length: props.rows ?? 5 }, (_, index) => (
        <li key={index}>
          <div className="flex min-w-0 flex-col gap-2 rounded-[1.15rem] border border-border/70 bg-card/80 px-3.5 py-3">
            <div className="flex min-w-0 items-center gap-2">
              <Skeleton className="size-4 shrink-0 rounded-full" />
              <Skeleton className="h-3.5 w-3/5" />
              <Skeleton className="ms-auto h-4 w-14 rounded-full" />
            </div>
            <div className="flex min-w-0 items-center gap-2">
              <Skeleton className="h-3 w-24" />
              <Skeleton className="h-3 w-16" />
              <Skeleton className="h-3 w-20" />
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}

export function ReviewSyncStatusStrip(props: {
  label?: string;
  detail?: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex min-w-0 items-center gap-2 rounded-full border border-border/55 bg-card/58 px-3 py-1.5 text-[12px] text-muted-foreground",
        props.className,
      )}
      role="status"
      aria-live="polite"
    >
      <RefreshCwIcon className="size-4 shrink-0 animate-spin text-info-foreground" />
      <span className="shrink-0 font-medium text-foreground">
        {props.label ?? "Updating from GitHub"}
      </span>
      <span className="min-w-0 truncate">
        {props.detail ?? "Showing cached pull requests while the latest review state syncs."}
      </span>
    </div>
  );
}
