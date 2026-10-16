// FILE: useTimelineRowHeightHints.browser.tsx
// Purpose: Regressions for the size reports LegendList sends the transcript row-height hints.
// Layer: Web browser tests
// Depends on: useTimelineRowHeightHints and a real React/browser runtime.

import type { LegendListRef } from "@legendapp/list/react";
import { MessageId } from "@synara/contracts";
import { describe, expect, it } from "vitest";
import { renderHook } from "vitest-browser-react";

import type { MessagesTimelineRow } from "./MessagesTimeline.logic";
import { useTimelineRowHeightHints } from "./useTimelineRowHeightHints";

function messageRow(id: string): MessagesTimelineRow {
  return {
    kind: "message",
    id,
    createdAt: "2026-10-14T12:00:00.000Z",
    message: {
      id: MessageId.makeUnsafe(id),
      role: "assistant",
      text: "Done.",
      createdAt: "2026-10-14T12:00:00.000Z",
      streaming: false,
    },
    durationStart: "2026-10-14T12:00:00.000Z",
    showAssistantCopyButton: true,
    assistantCopyStreaming: false,
  };
}

describe("useTimelineRowHeightHints", () => {
  it("ignores size reports for a row that already left the list data", async () => {
    const canRememberRow = (row: MessagesTimelineRow) => row.kind === "message";
    const listRef = { current: null as LegendListRef | null };
    const { result } = await renderHook(() =>
      useTimelineRowHeightHints(listRef, 13, "stale-row-reports", canRememberRow),
    );
    const removed = messageRow("removed");
    const shifted = messageRow("shifted");

    result.current.onItemSizeChanged({ itemKey: removed.id, itemData: shifted, size: 321 });
    expect(result.current.getEstimatedItemSize(removed)).not.toBe(321);

    result.current.onItemSizeChanged({ itemKey: removed.id, itemData: removed, size: 222 });
    expect(result.current.getEstimatedItemSize(removed)).toBe(222);

    // A measurement after the row left `data` arrives with no row, or with the row now at
    // its old index; neither may throw or replace the row's remembered height.
    expect(() =>
      result.current.onItemSizeChanged({ itemKey: removed.id, itemData: undefined, size: 0 }),
    ).not.toThrow();
    result.current.onItemSizeChanged({ itemKey: removed.id, itemData: shifted, size: 999 });
    expect(result.current.getEstimatedItemSize(removed)).toBe(222);
  });
});
