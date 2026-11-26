// FILE: PrStateChip.tsx
// Purpose: Compact PR markers in the state's color: the chip (state icon + #number, hover title)
//          shared by the kanban card meta row, the project overview, and the sidebar Activity
//          rows, and the count chip (state icon + number of PRs) that lists a thread's PRs.
// Layer: UI component (pure)
// Exports: PrStateChip, PrStateCountChip

import type { OrchestrationThreadPullRequest } from "@synara/contracts";
import type { MouseEvent, SyntheticEvent } from "react";

import { cn } from "~/lib/utils";
import { ComposerPickerMenuPopup } from "../chat/ComposerPickerMenuPopup";
import { Menu, MenuItem, MenuTrigger } from "../ui/menu";
import {
  PR_STATE_PRESENTATION_ICONS,
  PR_STATE_LABEL_KEYS,
  resolvePrStatePresentation,
} from "./pullRequestStatePresentation";
import { PR_FINE_TEXT_CLASS_NAME } from "./pullRequestText";
import { useTranslation } from "~/i18n";

const stopRowGesture = (event: SyntheticEvent) => event.stopPropagation();

// The PR type scale, not a pixel: the chip is the same fine print as every other PR surface,
// so it tracks the user's font-size setting with them.
const CHIP_CLASS_NAME = cn(PR_FINE_TEXT_CLASS_NAME, "flex shrink-0 items-center gap-0.5");

// A button chip's target reaches past its glyphs (padding the negative margin cancels), so the
// chip keeps its place in the line.
const CHIP_BUTTON_CLASS_NAME = cn(
  "-mx-1 min-h-5 cursor-pointer rounded-sm px-1 hover:underline",
  "outline-hidden focus-visible:ring-1 focus-visible:ring-ring",
);

export function PrStateChip({
  pr,
  className,
  onOpen,
}: {
  pr: OrchestrationThreadPullRequest;
  className?: string;
  /**
   * Makes the chip a button of its own, for a row that opens something else on press: its
   * presses, double-clicks and touch taps never reach the row. Middle-click arrives here too.
   */
  onOpen?: (event: MouseEvent<HTMLElement>) => void;
}) {
  const { t } = useTranslation();

  const presentation = resolvePrStatePresentation(pr);
  const PrIcon = PR_STATE_PRESENTATION_ICONS[presentation.iconKind];
  const title = t("workspace:symbol4", {
    value0: pr.number,
    value1: t(PR_STATE_LABEL_KEYS[presentation.label]),
    value2: pr.title,
  });
  const content = (
    <>
      <PrIcon className="size-3 shrink-0" aria-hidden />#{pr.number}
    </>
  );
  if (!onOpen) {
    return (
      <span title={title} className={cn(CHIP_CLASS_NAME, presentation.colorClass, className)}>
        {content}
      </span>
    );
  }
  const open = (event: MouseEvent<HTMLElement>) => {
    event.stopPropagation();
    onOpen(event);
  };
  return (
    <button
      type="button"
      title={title}
      aria-label={t("git:openPullRequestNumber", { number: pr.number })}
      data-slot="pull-request-chip"
      onClick={open}
      // Middle-click follows browser link semantics: the host opens it on GitHub.
      onAuxClick={open}
      onDoubleClick={stopRowGesture}
      onPointerUp={stopRowGesture}
      className={cn(CHIP_CLASS_NAME, presentation.colorClass, CHIP_BUTTON_CLASS_NAME, className)}
    >
      {content}
    </button>
  );
}

/**
 * A thread's several PRs as one chip: the first PR's state icon and color, then how many there
 * are. It opens a menu listing each PR (state icon, #number, title), so no press opens one at
 * random.
 */
export function PrStateCountChip({
  pullRequests,
  className,
  onOpen,
}: {
  /** The first decides the icon and color. */
  pullRequests: readonly [OrchestrationThreadPullRequest, ...OrchestrationThreadPullRequest[]];
  className?: string;
  onOpen: (event: MouseEvent<HTMLElement>, pr: OrchestrationThreadPullRequest) => void;
}) {
  const { t } = useTranslation();

  const presentation = resolvePrStatePresentation(pullRequests[0]);
  const PrIcon = PR_STATE_PRESENTATION_ICONS[presentation.iconKind];
  const label = t("git:pullRequestCount", { count: pullRequests.length });
  return (
    <Menu>
      <MenuTrigger
        render={
          <button
            type="button"
            title={label}
            aria-label={label}
            data-slot="pull-request-count-chip"
            onDoubleClick={stopRowGesture}
            onPointerUp={stopRowGesture}
            className={cn(
              CHIP_CLASS_NAME,
              presentation.colorClass,
              CHIP_BUTTON_CLASS_NAME,
              className,
            )}
          />
        }
      >
        <PrIcon className="size-3 shrink-0" aria-hidden />
        {pullRequests.length}
      </MenuTrigger>
      {/* The menu is portaled but still inside the row in React's tree, so its gestures must
          not reach the row's rename and context-menu handlers. */}
      <ComposerPickerMenuPopup
        align="end"
        side="bottom"
        className="max-w-80 min-w-56"
        onDoubleClick={stopRowGesture}
        onPointerUp={stopRowGesture}
        onContextMenu={stopRowGesture}
      >
        {pullRequests.map((pr) => {
          const itemPresentation = resolvePrStatePresentation(pr);
          const ItemIcon = PR_STATE_PRESENTATION_ICONS[itemPresentation.iconKind];
          return (
            <MenuItem
              key={pr.url}
              className="min-h-7 gap-2 py-1 sm:text-ui leading-snug"
              title={t("workspace:symbol4", {
                value0: pr.number,
                value1: t(PR_STATE_LABEL_KEYS[itemPresentation.label]),
                value2: pr.title,
              })}
              onClick={(event) => onOpen(event, pr)}
            >
              <ItemIcon
                className={cn("size-3.5 shrink-0", itemPresentation.colorClass)}
                aria-hidden
              />
              <span className="min-w-0 truncate">
                {t("git:symbol", { value0: pr.number, value1: pr.title })}
              </span>
            </MenuItem>
          );
        })}
      </ComposerPickerMenuPopup>
    </Menu>
  );
}
