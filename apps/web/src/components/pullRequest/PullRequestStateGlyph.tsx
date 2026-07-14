// FILE: PullRequestStateGlyph.tsx
// Purpose: Single glyph + tone mapping for a pull request's state (open/closed/merged/draft),
//          shared by the list rows and the detail panel header so every surface agrees on what
//          "open" or "merged" looks like. Merged swaps to the merge-commit icon (matching the
//          sidebar's PR badge convention); everything else keeps the pull-request fork icon and
//          only recolors it. Draft additionally gets a dashed ring, echoing GitHub's dotted
//          "not ready for review" treatment.
// Layer: Pull request presentation
// Exports: PullRequestStateGlyph, pullRequestStateLabel

import type { PullRequestState } from "@synara/contracts";

import { GitMergedSimpleIcon, GitPullRequestIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";

const TONE_CLASS_NAME: Record<PullRequestState, string> = {
  open: "text-emerald-600 dark:text-emerald-400",
  merged: "text-violet-600 dark:text-violet-400",
  closed: "text-red-600 dark:text-red-400",
};

const SIZE_CLASS_NAME = {
  sm: "size-4",
  md: "size-[1.125rem]",
} as const;

export function pullRequestStateLabel(state: PullRequestState, isDraft: boolean): string {
  if (isDraft && state === "open") return "Draft";
  if (state === "open") return "Open";
  if (state === "merged") return "Merged";
  return "Closed";
}

export function PullRequestStateGlyph({
  state,
  isDraft,
  size = "sm",
  className,
}: {
  state: PullRequestState;
  isDraft: boolean;
  size?: keyof typeof SIZE_CLASS_NAME;
  className?: string;
}) {
  const sizeClassName = SIZE_CLASS_NAME[size];
  const draft = isDraft && state === "open";

  if (draft) {
    return (
      <span
        className={cn(
          "flex shrink-0 items-center justify-center rounded-full border border-dashed border-muted-foreground/50 text-muted-foreground/70",
          sizeClassName,
          className,
        )}
        title="Draft"
      >
        <span className="size-1.5 rounded-full bg-current" />
      </span>
    );
  }

  const Icon = state === "merged" ? GitMergedSimpleIcon : GitPullRequestIcon;
  return (
    <span
      className={cn("flex shrink-0 items-center justify-center", sizeClassName, className)}
      title={pullRequestStateLabel(state, isDraft)}
    >
      <Icon className={cn("size-full", TONE_CLASS_NAME[state])} aria-hidden="true" />
    </span>
  );
}
