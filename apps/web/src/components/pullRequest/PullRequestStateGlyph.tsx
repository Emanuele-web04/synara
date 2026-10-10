// FILE: PullRequestStateGlyph.tsx
// Purpose: State glyphs for GitHub items: a pull request (open/draft/closed/merged/conflicts),
//          an issue (open/closed/not planned), and the inbox item glyph that picks between them.
//          Shared by the list rows, the item header, and the dock tab chip. Icon and color come
//          from pullRequestStatePresentation, the same mapping the sidebar thread badge and
//          kanban chip use, so every surface renders a given state identically.
// Layer: Pull request presentation
// Exports: PullRequestStateGlyph, IssueStateGlyph, GitHubItemStateGlyph, pullRequestStateLabel

import type {
  GitHubInboxItem,
  GitHubIssueState,
  GitHubIssueStateReason,
  GitPullRequestMergeability,
  PullRequestState,
} from "@synara/contracts";

import { cn } from "~/lib/utils";
import {
  ISSUE_STATE_PRESENTATION_ICONS,
  PR_STATE_PRESENTATION_ICONS,
  resolveIssueStatePresentation,
  resolvePrStatePresentation,
} from "./pullRequestStatePresentation";

const SIZE_CLASS_NAME = {
  sm: "size-4",
  md: "size-[1.125rem]",
} as const;

type GlyphSize = keyof typeof SIZE_CLASS_NAME;

/** Short visible state word for a pull request ("Draft", "Merged"), as badges and tooltips say it. */
export function pullRequestStateLabel(
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

// draft always shows as draft; conflicts show the conflict glyph — precedence lives in resolvePrStatePresentation so every surface agrees
export function PullRequestStateGlyph({
  state,
  isDraft,
  mergeability,
  size: sizeProp,
  className,
}: {
  state: PullRequestState;
  isDraft: boolean;
  mergeability?: GitPullRequestMergeability | undefined;
  size?: GlyphSize;
  className?: string;
}) {
  const size = sizeProp ?? "sm";
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

export function IssueStateGlyph({
  state,
  stateReason,
  size: sizeProp,
  className,
}: {
  state: GitHubIssueState;
  stateReason: GitHubIssueStateReason | null;
  size?: GlyphSize;
  className?: string;
}) {
  const size = sizeProp ?? "sm";
  const presentation = resolveIssueStatePresentation({ state, stateReason });
  const Icon = ISSUE_STATE_PRESENTATION_ICONS[presentation.iconKind];
  return (
    <span
      className={cn("flex shrink-0 items-center justify-center", SIZE_CLASS_NAME[size], className)}
      title={presentation.shortLabel}
      role="img"
      aria-label={presentation.label}
    >
      <Icon className={cn("size-full", presentation.colorClass)} aria-hidden="true" />
    </span>
  );
}

/** The state glyph of an inbox row, whichever kind it is. */
export function GitHubItemStateGlyph({
  item,
  size,
  className,
}: {
  item: GitHubInboxItem;
  size?: GlyphSize;
  className?: string;
}) {
  return item.kind === "pullRequest" ? (
    <PullRequestStateGlyph
      state={item.state}
      isDraft={item.isDraft}
      mergeability={item.mergeability}
      {...(size ? { size } : {})}
      {...(className ? { className } : {})}
    />
  ) : (
    <IssueStateGlyph
      state={item.state}
      stateReason={item.stateReason}
      {...(size ? { size } : {})}
      {...(className ? { className } : {})}
    />
  );
}
