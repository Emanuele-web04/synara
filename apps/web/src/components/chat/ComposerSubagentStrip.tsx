// FILE: ComposerSubagentStrip.tsx
// Purpose: Compact subagent rows stacked above the composer input (status dot,
// nickname, role/model, live status); clicking a row switches to that subagent's
// thread. Wraps the shared stacked-header frame like the active task list.
// Layer: Chat composer UI
// Exports: ComposerSubagentStrip

import type { ThreadId } from "@synara/contracts";
import { pluralize } from "@synara/shared/text";
import { memo } from "react";
import { PiArrowsInSimple, PiArrowsOutSimple } from "react-icons/pi";

import { BotIcon, LoaderIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { DisclosureRegion } from "../ui/DisclosureRegion";
import type { ComposerSubagentStripItem } from "./ComposerSubagentStrip.logic";
import {
  ComposerStackedPanelHeaderRow,
  ComposerStackedPanelRowLabel,
  ComposerStackedPanelRowMain,
} from "./ComposerStackedPanelContent";
import { ComposerStackedPanel } from "./ComposerStackedPanel";
import {
  COMPOSER_STACKED_PANEL_BODY_PADDING_CLASS_NAME,
  COMPOSER_STACKED_PANEL_ICON_BUTTON_CLASS_NAME,
  COMPOSER_STACKED_PANEL_ICON_CLASS_NAME,
} from "./composerStackedPanelStyles";

interface ComposerSubagentStripProps {
  items: ReadonlyArray<ComposerSubagentStripItem>;
  compact: boolean;
  onCompactChange: (compact: boolean) => void;
  onOpenThread: (threadId: ThreadId) => void;
  attachedToPrevious?: boolean;
}

function subagentStatusToneClassName(statusKind: ComposerSubagentStripItem["statusKind"]): string {
  switch (statusKind) {
    case "running":
      return "text-sky-300/85";
    case "completed":
      return "text-emerald-300/75";
    case "failed":
      return "text-rose-300/85";
    case "stopped":
      return "text-amber-300/80";
    case "queued":
      return "text-violet-300/80";
    default:
      return "text-muted-foreground/55";
  }
}

export const ComposerSubagentStrip = memo(function ComposerSubagentStrip({
  items,
  compact,
  onCompactChange,
  onOpenThread,
  attachedToPrevious = false,
}: ComposerSubagentStripProps) {
  const runningCount = items.filter((item) => item.isActive).length;

  return (
    <ComposerStackedPanel
      passthroughSideMargins
      attachedToPrevious={attachedToPrevious}
      data-testid="composer-subagent-strip"
    >
      <ComposerStackedPanelHeaderRow>
        <ComposerStackedPanelRowMain>
          {compact && runningCount > 0 ? (
            <LoaderIcon className={cn(COMPOSER_STACKED_PANEL_ICON_CLASS_NAME, "animate-spin")} />
          ) : (
            <BotIcon className={COMPOSER_STACKED_PANEL_ICON_CLASS_NAME} />
          )}
          <ComposerStackedPanelRowLabel tone="meta">
            {runningCount > 0
              ? `${runningCount} of ${items.length} ${pluralize(items.length, "subagent")} running`
              : `${items.length} ${pluralize(items.length, "subagent")}`}
          </ComposerStackedPanelRowLabel>
        </ComposerStackedPanelRowMain>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className={cn("shrink-0", COMPOSER_STACKED_PANEL_ICON_BUTTON_CLASS_NAME)}
          onClick={() => onCompactChange(!compact)}
          aria-label={compact ? "Expand subagent strip" : "Collapse subagent strip"}
          title={compact ? "Expand subagent strip" : "Collapse subagent strip"}
        >
          {compact ? (
            <PiArrowsOutSimple className="size-3" />
          ) : (
            <PiArrowsInSimple className="size-3" />
          )}
        </Button>
      </ComposerStackedPanelHeaderRow>

      <DisclosureRegion open={!compact}>
        <div className={cn("space-y-0", COMPOSER_STACKED_PANEL_BODY_PADDING_CLASS_NAME)}>
          {items.map((item) => (
            <button
              key={item.key}
              type="button"
              data-testid="composer-subagent-row"
              className="flex w-full min-w-0 items-center gap-2 rounded-md px-1 py-1 text-left transition-colors hover:bg-[var(--color-background-button-secondary-hover)]"
              title={item.fullLabel}
              onClick={() => onOpenThread(item.threadId)}
            >
              <span
                className={cn(
                  "size-1.5 shrink-0 rounded-full",
                  item.isActive ? "bg-sky-300/95" : "bg-muted-foreground/22",
                )}
              />
              <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-foreground/85">
                <span style={{ color: item.accentColor }}>{item.primaryLabel}</span>
                {item.role ? (
                  <span className="ml-1 text-[11px] font-normal text-muted-foreground/55">
                    ({item.role})
                  </span>
                ) : null}
                {item.modelLabel ? (
                  <span className="ml-1.5 text-[11px] font-normal text-muted-foreground/45">
                    {item.modelLabel}
                  </span>
                ) : null}
              </span>
              {item.statusLabel ? (
                <span
                  className={cn(
                    "shrink-0 text-[11px]",
                    subagentStatusToneClassName(item.statusKind),
                  )}
                >
                  {item.statusLabel}
                </span>
              ) : null}
            </button>
          ))}
        </div>
      </DisclosureRegion>
    </ComposerStackedPanel>
  );
});
