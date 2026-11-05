import { describe, expect, it } from "vitest";

import {
  bubbleTextColor,
  deriveBubbleRowLayout,
  sameBubbleRowLayout,
  type BubbleLayoutRow,
} from "./timelineBubbles.logic";

const message = (id: string, role: string, createdAt: string): BubbleLayoutRow => ({
  id,
  kind: "message",
  message: { role, createdAt },
});

describe("deriveBubbleRowLayout", () => {
  it("separates the start, an hour's gap and a new day; groups by side within five minutes", () => {
    const rows = [
      message("u1", "user", "2026-11-05T10:00:00"),
      message("a1", "assistant", "2026-11-05T10:00:30"),
      message("a2", "assistant", "2026-11-05T10:01:00"),
      message("a3", "assistant", "2026-11-05T10:07:00"),
      message("u2", "user", "2026-11-05T11:30:00"),
      message("u3", "user", "2026-11-06T00:05:00"),
    ];
    const layout = deriveBubbleRowLayout(rows);
    expect(rows.map((row) => layout.get(row.id))).toEqual([
      { separatorAt: "2026-11-05T10:00:00", groupStart: true },
      { separatorAt: null, groupStart: true },
      { separatorAt: null, groupStart: false },
      { separatorAt: null, groupStart: true },
      { separatorAt: "2026-11-05T11:30:00", groupStart: true },
      { separatorAt: "2026-11-06T00:05:00", groupStart: true },
    ]);
  });

  it("starts a new run after a card or status row", () => {
    const rows: BubbleLayoutRow[] = [
      message("a1", "assistant", "2026-11-05T10:00:00"),
      { id: "w1", kind: "work" },
      message("a2", "assistant", "2026-11-05T10:00:10"),
    ];
    const layout = deriveBubbleRowLayout(rows);
    expect(layout.get("a2")).toEqual({ separatorAt: null, groupStart: true });
    expect(layout.has("w1")).toBe(false);
  });

  it("compares layouts by content", () => {
    const rows = [message("u1", "user", "2026-11-05T10:00:00")];
    expect(sameBubbleRowLayout(deriveBubbleRowLayout(rows), deriveBubbleRowLayout(rows))).toBe(
      true,
    );
    expect(
      sameBubbleRowLayout(
        deriveBubbleRowLayout(rows),
        deriveBubbleRowLayout([...rows, message("a1", "assistant", "2026-11-05T10:00:01")]),
      ),
    ).toBe(false);
  });
});

describe("bubbleTextColor", () => {
  it("uses white on dark tints and near black on light ones", () => {
    expect(bubbleTextColor("#5b5bd6")).toBe("#ffffff");
    expect(bubbleTextColor("#f5d90a")).toBe("#111111");
  });
});
