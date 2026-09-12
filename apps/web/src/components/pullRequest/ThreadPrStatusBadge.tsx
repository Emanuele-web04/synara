// FILE: ThreadPrStatusBadge.tsx
// Purpose: Renders the compact, clickable PR state icon shown before classic sidebar rows.
// Layer: Pull request presentation
// Exports: ThreadPrStatusBadge

import type { OrchestrationThreadPullRequest } from "@synara/contracts";
import type { MouseEvent } from "react";

import { cn } from "~/lib/utils";
import { SidebarGlyph } from "../sidebarGlyphs";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  PR_STATE_PRESENTATION_ICONS,
  resolvePrStatePresentation,
} from "./pullRequestStatePresentation";

type ThreadPrStatusBadgePullRequest = Pick<
  OrchestrationThreadPullRequest,
  "number" | "title" | "url" | "state" | "isDraft" | "mergeability"
>;

export function ThreadPrStatusBadge({
  pr,
  onOpen,
  className,
}: {
  pr: ThreadPrStatusBadgePullRequest;
  onOpen: (event: MouseEvent<HTMLElement>, prUrl: string) => void;
  className?: string;
}) {
  const presentation = resolvePrStatePresentation(pr);
  const PrIcon = PR_STATE_PRESENTATION_ICONS[presentation.iconKind];
  const tooltip = `#${pr.number} ${presentation.label}: ${pr.title}`;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={tooltip}
            className={cn(
              "inline-flex size-4 shrink-0 cursor-pointer items-center justify-center rounded-sm outline-hidden transition-colors focus-visible:ring-1 focus-visible:ring-ring",
              presentation.colorClass,
              className,
            )}
            onClick={(event) => onOpen(event, pr.url)}
          >
            <SidebarGlyph icon={PrIcon} variant="meta" className="size-3.5" />
          </button>
        }
      />
      <TooltipPopup side="top">{tooltip}</TooltipPopup>
    </Tooltip>
  );
}
