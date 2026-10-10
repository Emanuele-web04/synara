// FILE: usePullRequestPaneStateIcon.tsx
// Purpose: Dock-tab glyph for a pull request pane that tracks the PR's live state. Mirrors the
//          detail query cache (never fetches — the detail panel owns fetching) so the chip
//          icon flips to draft/merged/closed the moment the panel's data does. Used by the chat
//          thread dock host.
// Layer: Pull request presentation
// Exports: usePullRequestPaneStateIcon

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
