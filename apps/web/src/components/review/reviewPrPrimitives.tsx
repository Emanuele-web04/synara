import type { ReviewCheckState, ReviewReviewerState } from "@t3tools/contracts";

import { CircleAlertIcon, CircleCheckIcon, LoaderCircleIcon, XIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { type ReviewPillDescriptor } from "./reviewPrimitives";

export function reviewerStatePill(state: ReviewReviewerState): ReviewPillDescriptor {
  switch (state) {
    case "APPROVED":
      return { label: "Approved", tone: "success" };
    case "CHANGES_REQUESTED":
      return { label: "Changes requested", tone: "warning" };
    case "COMMENTED":
      return { label: "Commented", tone: "muted" };
    case "DISMISSED":
      return { label: "Dismissed", tone: "muted" };
    case "PENDING":
      return { label: "Pending", tone: "muted" };
    case "REVIEW_REQUIRED":
      return { label: "Requested", tone: "info" };
  }
}

const CHECK_STATE_LABEL: Record<ReviewCheckState, string> = {
  success: "Passed",
  failure: "Failed",
  pending: "In progress",
  skipped: "Skipped",
  neutral: "Neutral",
  cancelled: "Cancelled",
};

export function checkStateLabel(state: ReviewCheckState): string {
  return CHECK_STATE_LABEL[state];
}

export function CheckStateIcon(props: { state: ReviewCheckState; className?: string }) {
  const size = cn("size-3.5 shrink-0", props.className);
  switch (props.state) {
    case "success":
      return <CircleCheckIcon className={cn(size, "text-success-foreground")} aria-hidden="true" />;
    case "failure":
      return <CircleAlertIcon className={cn(size, "text-destructive")} aria-hidden="true" />;
    case "pending":
      return (
        <LoaderCircleIcon
          className={cn(size, "animate-spin text-warning-foreground")}
          aria-hidden="true"
        />
      );
    case "cancelled":
      return <XIcon className={cn(size, "text-muted-foreground")} aria-hidden="true" />;
    case "skipped":
    case "neutral":
      return (
        <span
          className={cn("inline-block size-1.5 shrink-0 rounded-full bg-muted-foreground/50")}
          aria-hidden="true"
        />
      );
  }
}

// Coarse PR-list check rollup (passing/failing/pending) as a single state icon.
export function ChecksStatusIcon(props: {
  status: "passing" | "failing" | "pending" | "none";
  className?: string;
}) {
  const size = cn("size-3.5 shrink-0", props.className);
  switch (props.status) {
    case "passing":
      return (
        <CircleCheckIcon
          className={cn(size, "text-success-foreground")}
          aria-label="Checks passing"
        />
      );
    case "failing":
      return (
        <CircleAlertIcon className={cn(size, "text-destructive")} aria-label="Checks failing" />
      );
    case "pending":
      return (
        <LoaderCircleIcon
          className={cn(size, "animate-spin text-warning-foreground")}
          aria-label="Checks running"
        />
      );
    case "none":
      return null;
  }
}

// GitHub labels carry their own per-item hex color (real data, not the app
// palette); render them tinted from that color so they read in both themes.
export function LabelPill(props: { name: string; color: string; className?: string }) {
  const hex = props.color.startsWith("#") ? props.color : `#${props.color || "808080"}`;
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 font-medium text-[10px] leading-none",
        props.className,
      )}
      style={{
        borderColor: `color-mix(in srgb, ${hex} 36%, transparent)`,
        backgroundColor: `color-mix(in srgb, ${hex} 14%, transparent)`,
        color: "var(--foreground)",
      }}
      title={props.name}
    >
      {props.name}
    </span>
  );
}

export function ReviewAvatar(props: {
  login: string;
  avatarUrl?: string | undefined;
  className?: string;
  presentation?: "decorative" | "informative";
}) {
  const initial = props.login.trim().charAt(0).toUpperCase() || "?";
  const decorative = props.presentation === "decorative";
  if (props.avatarUrl && props.avatarUrl.length > 0) {
    return (
      <img
        src={props.avatarUrl}
        alt={decorative ? "" : props.login}
        aria-hidden={decorative ? true : undefined}
        className={cn("size-4 shrink-0 rounded-full border border-border/60", props.className)}
        loading="lazy"
      />
    );
  }
  return (
    <span
      role={decorative ? undefined : "img"}
      aria-label={decorative ? undefined : props.login}
      className={cn(
        "inline-flex size-4 shrink-0 items-center justify-center rounded-full bg-muted font-medium text-[9px] text-foreground/80",
        props.className,
      )}
      aria-hidden={decorative ? true : undefined}
    >
      {initial}
    </span>
  );
}
