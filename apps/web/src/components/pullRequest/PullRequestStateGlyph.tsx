// FILE: PullRequestStateGlyph.tsx
// Purpose: State glyph for a pull request (open/draft/closed/merged), shared by the list rows,
//          the detail panel header, and the dock tab chip. Icon and color both come from
//          resolvePrStatePresentation — the same mapping the sidebar thread badge and kanban
//          chip use — so every surface renders a given PR state identically.
// Layer: Pull request presentation
// Exports: PullRequestStateGlyph

import type { GitPullRequestMergeability, PullRequestState } from "@synara/contracts";

import { cn } from "~/lib/utils";
import {
  PR_STATE_PRESENTATION_ICONS,
  resolvePrStatePresentation,
} from "./pullRequestStatePresentation";

const SIZE_CLASS_NAME = {
  sm: "size-4",
  md: "size-[1.125rem]",
} as const;

function pullRequestStateLabel(
  state: PullRequestState,
  isDraft: boolean,
  mergeability: GitPullRequestMergeability | undefined,
): string {
  if (isDraft && state === "open") return "Draft";
  if (state === "open" && mergeability === "conflicting") return "Has conflicts";
  if (state === "open") return "Open";
  if (state === "merged") return "Merged";
  return "Closed";
}

// Draft always shows as draft (a draft isn't heading for a merge); an open non-draft PR
// with conflicts shows the conflict glyph — precedence lives in resolvePrStatePresentation
// so the thread badge, kanban chip, and every PR surface agree.
export function PullRequestStateGlyph({
  state,
  isDraft,
  mergeability,
  size = "sm",
  className,
}: {
  state: PullRequestState;
  isDraft: boolean;
  mergeability?: GitPullRequestMergeability | undefined;
  size?: keyof typeof SIZE_CLASS_NAME;
  className?: string;
}) {
  const presentation = resolvePrStatePresentation({ state, isDraft, mergeability });
  const Icon = PR_STATE_PRESENTATION_ICONS[presentation.iconKind];
  return (
    <span
      className={cn("flex shrink-0 items-center justify-center", SIZE_CLASS_NAME[size], className)}
      title={pullRequestStateLabel(state, isDraft, mergeability)}
      role="img"
      aria-label={presentation.label}
    >
      <Icon className={cn("size-full", presentation.colorClass)} aria-hidden="true" />
    </span>
  );
}
