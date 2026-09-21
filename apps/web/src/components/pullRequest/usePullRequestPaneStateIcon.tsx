import type { PullRequestDetailInput } from "@synara/contracts";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";

import { CHAT_SURFACE_CHIP_GLYPH_CLASS_NAME } from "~/components/chat/chatHeaderControls";
import { pullRequestDetailQueryOptions } from "~/lib/pullRequestReactQuery";
import { PullRequestStateGlyph } from "./PullRequestStateGlyph";

export function usePullRequestPaneStateIcon(
  input: PullRequestDetailInput | null,
): ReactNode | undefined {
  const detailQuery = useQuery({
    ...pullRequestDetailQueryOptions(input),
    enabled: false,
  });
  const detail = input ? detailQuery.data : undefined;
  if (!detail) return undefined;
  // this glyph's color IS the state — renders at the same strength as the list's state glyphs, not a muted tab icon
  return (
    <PullRequestStateGlyph
      state={detail.state}
      isDraft={detail.isDraft}
      mergeability={detail.mergeability}
      className={CHAT_SURFACE_CHIP_GLYPH_CLASS_NAME}
    />
  );
}
