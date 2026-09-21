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
  size?: keyof typeof SIZE_CLASS_NAME;
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
