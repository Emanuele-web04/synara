// FILE: useTimelineRowHeightHints.ts
// Purpose: Feed the transcript virtualizer per-row size hints and remember the
//          heights it measures, so unrendered history is laid out close to its
//          real size without carrying mutable presentation across thread mounts.
// Layer: React hooks (chat timeline)
// Exports: useTimelineRowHeightHints

import type { LegendListRef } from "@legendapp/list/react";
import { useCallback, useLayoutEffect, useMemo, useRef, type RefObject } from "react";

import {
  DEFAULT_TIMELINE_ROW_WIDTH_PX,
  createTimelineRowHeightEstimator,
  rememberTimelineRowHeight,
} from "./timelineRowHeight.logic";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic";

// The root owns these typography variables, so their signature is available before rows mount.
function readTimelineFontKey(): string {
  if (typeof document === "undefined" || typeof getComputedStyle === "undefined") return "";
  const style = getComputedStyle(document.documentElement);
  return JSON.stringify([
    style.getPropertyValue("--font-ui-family"),
    style.getPropertyValue("--font-display-family"),
    style.getPropertyValue("--app-font-size-ui"),
  ]);
}

export function useTimelineRowHeightHints(
  listRef: RefObject<LegendListRef | null>,
  chatFontSizePx: number,
  namespace: string | undefined,
  canRememberRow: (row: MessagesTimelineRow) => boolean,
) {
  const rowWidthPxRef = useRef(DEFAULT_TIMELINE_ROW_WIDTH_PX);
  const rowWidthMeasuredRef = useRef(false);
  const initialFontKey = useMemo(readTimelineFontKey, [namespace, chatFontSizePx]);
  const fontKeyRef = useRef(initialFontKey);

  // Reads one rendered row. Callers run right after layout (resize callbacks and the
  // list's own measurement pass), so this does not force an extra layout.
  const measureRowWidth = useCallback(() => {
    const node: unknown = listRef.current?.getScrollableNode?.();
    if (!(node instanceof HTMLElement)) return;
    const width =
      node.querySelector<HTMLElement>("[data-timeline-row-kind]")?.getBoundingClientRect().width ??
      0;
    if (width > 0) {
      rowWidthPxRef.current = width;
      rowWidthMeasuredRef.current = true;
      fontKeyRef.current = readTimelineFontKey();
    }
  }, [listRef]);

  useLayoutEffect(() => {
    const node: unknown = listRef.current?.getScrollableNode?.();
    if (!(node instanceof HTMLElement) || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measureRowWidth);
    observer.observe(node);
    return () => observer.disconnect();
  }, [listRef, measureRowWidth]);

  const getEstimatedItemSize = useMemo(
    () =>
      createTimelineRowHeightEstimator(
        () => ({
          rowWidthPx: rowWidthPxRef.current,
          chatFontSizePx,
          fontKey: fontKeyRef.current,
        }),
        { namespace, canRememberRow },
      ),
    [chatFontSizePx, namespace, canRememberRow],
  );

  const onItemSizeChanged = useCallback(
    ({
      itemKey,
      itemData,
      size,
    }: {
      itemKey: string;
      itemData: MessagesTimelineRow;
      size: number;
    }) => {
      if (!rowWidthMeasuredRef.current) measureRowWidth();
      fontKeyRef.current = readTimelineFontKey();
      rememberTimelineRowHeight(
        itemKey,
        { rowWidthPx: rowWidthPxRef.current, chatFontSizePx, fontKey: fontKeyRef.current },
        size,
        { namespace, row: itemData, allowed: canRememberRow(itemData) },
      );
    },
    [chatFontSizePx, measureRowWidth, namespace, canRememberRow],
  );

  return { getEstimatedItemSize, onItemSizeChanged };
}
