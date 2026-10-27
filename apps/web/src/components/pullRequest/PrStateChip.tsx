// FILE: PrStateChip.tsx
// Purpose: Compact PR chip (state icon + #number, hover title) shared by the
//          kanban card meta row and the sidebar Activity rows.
// Layer: UI component (pure)
// Exports: PrStateChip

import type { OrchestrationThreadPullRequest } from "@synara/contracts";
import type { MouseEvent } from "react";

import { cn } from "~/lib/utils";
import {
  PR_STATE_PRESENTATION_ICONS,
  PR_STATE_LABEL_KEYS,
  resolvePrStatePresentation,
} from "./pullRequestStatePresentation";
import { PR_FINE_TEXT_CLASS_NAME } from "./pullRequestText";
import { useTranslation } from "~/i18n";

export function PrStateChip({
  pr,
  className,
  onOpen,
}: {
  pr: OrchestrationThreadPullRequest;
  className?: string;
  /** Makes the chip a link-like target. It is a span (not a button/anchor) because hosts
   *  render it inside their row button, where nested interactive elements are invalid. */
  onOpen?: (event: MouseEvent<HTMLElement>) => void;
}) {
  const { t } = useTranslation();

  const presentation = resolvePrStatePresentation(pr);
  const PrIcon = PR_STATE_PRESENTATION_ICONS[presentation.iconKind];
  return (
    <span
      title={t("workspace:symbol4", {
        value0: pr.number,
        value1: t(PR_STATE_LABEL_KEYS[presentation.label]),
        value2: pr.title,
      })}
      onClick={onOpen}
      // Middle-click follows browser link semantics: open on GitHub.
      onAuxClick={onOpen}
      className={cn(
        // The PR type scale, not a pixel: this chip is the same fine print as every other PR
        // surface, so it tracks the user's font-size setting with them.
        PR_FINE_TEXT_CLASS_NAME,
        "flex shrink-0 items-center gap-0.5",
        presentation.colorClass,
        onOpen && "cursor-pointer hover:underline",
        className,
      )}
    >
      <PrIcon className="size-3 shrink-0" aria-hidden />#{pr.number}
    </span>
  );
}
