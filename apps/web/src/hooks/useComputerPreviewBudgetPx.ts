// FILE: useComputerPreviewBudgetPx.ts
// Purpose: Track the computer preview rail's width budget from the chat column's width,
//          re-rendering only when the budget itself changes.
// Layer: Web hook
// Exports: useComputerPreviewBudgetPx

import { useLayoutEffect, useState } from "react";

import {
  computerPreviewBudgetPx,
  computerPreviewCardCaps,
  type ComputerPreviewCardSize,
} from "~/components/chat/ComputerPreviewPopover.logic";

/** Column width assumed until the column is measured. */
const UNMEASURED_COLUMN_WIDTH_PX = 1600;

/**
 * The preview rail budget for a chat column. The column's width changes on every frame of a
 * sidebar slide or window resize; keeping that width in state re-rendered the whole chat on
 * each frame and stalled the slide. Only the derived budget is state, and it settles at the
 * card's cap, so a wide column does not re-render while it resizes.
 */
export function useComputerPreviewBudgetPx(input: {
  column: HTMLElement | null;
  environmentInsetPx: number;
  size: ComputerPreviewCardSize;
}): number {
  const { column, environmentInsetPx, size } = input;
  const [budgetPx, setBudgetPx] = useState(() =>
    computerPreviewBudgetPx({
      mainContentWidthPx: UNMEASURED_COLUMN_WIDTH_PX,
      environmentInsetPx,
      caps: computerPreviewCardCaps(size),
    }),
  );

  // A layout effect, so a changed inset or card size is applied before the frame paints.
  useLayoutEffect(() => {
    if (!column) return;
    const caps = computerPreviewCardCaps(size);
    const update = () => {
      const next = computerPreviewBudgetPx({
        mainContentWidthPx: column.clientWidth,
        environmentInsetPx,
        caps,
      });
      setBudgetPx((previous) => (previous === next ? previous : next));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(column);
    return () => observer.disconnect();
  }, [column, environmentInsetPx, size]);

  return budgetPx;
}
