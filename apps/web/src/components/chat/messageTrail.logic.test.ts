import { MessageId } from "@synara/contracts";
import { describe, expect, it } from "vitest";
import type { TimelineEntry } from "../../session-logic";
import {
  clampTooltipTop,
  computeFocusedIndex,
  computeGaussianWeights,
  computeTrailGeometry,
  createActiveTrailStore,
  deriveMessageTrailItems,
  resolveActiveTrailMessageId,
  resolveActiveTrailSnapshot,
  type MessageTrailAnchor,
  type TrailGeometry,
} from "./messageTrail.logic";

function messageEntry(
  id: string,
  role: "user" | "assistant" | "system",
  text: string,
  attachmentCount = 0,
): TimelineEntry {
  return {
    id,
    kind: "message",
    createdAt: "2026-01-01T00:00:00Z",
    message: {
      id: MessageId.makeUnsafe(id),
      role,
      text,
      streaming: false,
      turnId: null,
      createdAt: "2026-01-01T00:00:00Z",
      ...(attachmentCount > 0
        ? { attachments: Array.from({ length: attachmentCount }, () => ({}) as never) }
        : {}),
    },
  } as TimelineEntry;
}

function workEntry(id: string): TimelineEntry {
  return {
    id,
    kind: "work",
    createdAt: "2026-01-01T00:00:00Z",
    entry: {} as never,
  } as TimelineEntry;
}

function anchor(id: string, rowIndex: number): MessageTrailAnchor {
  return { id: MessageId.makeUnsafe(id), rowIndex };
}

describe("deriveMessageTrailItems", () => {
  it("keeps only user messages, in order, with sequential ordinals", () => {
    const items = deriveMessageTrailItems([
      messageEntry("u1", "user", "first"),
      messageEntry("a1", "assistant", "reply"),
      workEntry("w1"),
      messageEntry("u2", "user", "second"),
      messageEntry("s1", "system", "system note"),
    ]);

    expect(items.map((item) => item.id)).toEqual([
      MessageId.makeUnsafe("u1"),
      MessageId.makeUnsafe("u2"),
    ]);
    expect(items.map((item) => item.ordinal)).toEqual([1, 2]);
  });

  it("collapses whitespace and caps very long previews", () => {
    const [single] = deriveMessageTrailItems([
      messageEntry("u1", "user", "  hello\n\n   world\t! "),
    ]);
    expect(single?.preview).toBe("hello world !");

    const long = "x".repeat(400);
    const [capped] = deriveMessageTrailItems([messageEntry("u2", "user", long)]);
    expect(capped?.preview.endsWith("…")).toBe(true);
    expect(capped?.preview.length).toBeLessThanOrEqual(281);
  });

  it("ignores a trailing empty assistant row so the last real reply stays the end-of-turn text", () => {
    const [item] = deriveMessageTrailItems([
      messageEntry("u1", "user", "ask"),
      messageEntry("a1", "assistant", "preamble"),
      messageEntry("a2", "assistant", "real final reply"),
      messageEntry("a3", "assistant", "   "),
    ]);
    expect(item?.responsePreview).toBe("real final reply");
  });

  it("returns the same items reference for the same entries array", () => {
    const entries = [messageEntry("u1", "user", "ask"), messageEntry("a1", "assistant", "reply")];

    expect(deriveMessageTrailItems(entries)).toBe(deriveMessageTrailItems(entries));
  });

  it("reflects a mid-list message replacement despite the per-message preview cache", () => {
    const unchangedUser = messageEntry("u1", "user", "  first   question ");
    const before = deriveMessageTrailItems([
      unchangedUser,
      messageEntry("a1", "assistant", "old reply"),
      messageEntry("u2", "user", "second question"),
    ]);
    // New entries array with the middle message replaced by a new object — the
    // store never mutates messages in place, so a text change means a new object.
    const after = deriveMessageTrailItems([
      unchangedUser,
      messageEntry("a1", "assistant", "  corrected   reply "),
      messageEntry("u2", "user", "second question"),
    ]);

    expect(before.map((item) => item.responsePreview)).toEqual(["old reply", ""]);
    expect(after.map((item) => item.responsePreview)).toEqual(["corrected reply", ""]);
    expect(after.map((item) => item.preview)).toEqual(["first question", "second question"]);
  });
});

describe("resolveActiveTrailMessageId", () => {
  const anchors = [anchor("u1", 0), anchor("u2", 4), anchor("u3", 9)];

  it("returns the last anchor at or above the topmost visible row", () => {
    expect(resolveActiveTrailMessageId(anchors, 0)).toBe(MessageId.makeUnsafe("u1"));
    expect(resolveActiveTrailMessageId(anchors, 3)).toBe(MessageId.makeUnsafe("u1"));
    expect(resolveActiveTrailMessageId(anchors, 4)).toBe(MessageId.makeUnsafe("u2"));
    expect(resolveActiveTrailMessageId(anchors, 12)).toBe(MessageId.makeUnsafe("u3"));
  });

  it("falls back to the first anchor when the viewport sits above it", () => {
    expect(resolveActiveTrailMessageId([anchor("u1", 2), anchor("u2", 5)], 0)).toBe(
      MessageId.makeUnsafe("u1"),
    );
  });
});

describe("resolveActiveTrailSnapshot", () => {
  const anchors = [anchor("u1", 0), anchor("u2", 4), anchor("u3", 9), anchor("u4", 14)];

  it("returns the current anchor plus every sent message visible in the viewport", () => {
    expect(resolveActiveTrailSnapshot(anchors, 3, 10)).toEqual({
      currentId: MessageId.makeUnsafe("u1"),
      visibleIds: [MessageId.makeUnsafe("u2"), MessageId.makeUnsafe("u3")],
    });
  });

  it("keeps the current anchor even when no sent-message row is directly visible", () => {
    expect(resolveActiveTrailSnapshot(anchors, 5, 8)).toEqual({
      currentId: MessageId.makeUnsafe("u2"),
      visibleIds: [],
    });
  });

  it("tracks visible sent messages as the viewport moves up and down", () => {
    expect([
      resolveActiveTrailSnapshot(anchors, 0, 4).visibleIds,
      resolveActiveTrailSnapshot(anchors, 4, 14).visibleIds,
      resolveActiveTrailSnapshot(anchors, 0, 4).visibleIds,
    ]).toEqual([
      [MessageId.makeUnsafe("u1"), MessageId.makeUnsafe("u2")],
      [MessageId.makeUnsafe("u2"), MessageId.makeUnsafe("u3"), MessageId.makeUnsafe("u4")],
      [MessageId.makeUnsafe("u1"), MessageId.makeUnsafe("u2")],
    ]);
  });
});

describe("createActiveTrailStore", () => {
  it("notifies subscribers only when the value actually changes", () => {
    const store = createActiveTrailStore();
    let notifications = 0;
    const unsubscribe = store.subscribe(() => {
      notifications += 1;
    });

    expect(store.get()).toEqual({ currentId: null, visibleIds: [] });

    store.set({
      currentId: MessageId.makeUnsafe("u1"),
      visibleIds: [MessageId.makeUnsafe("u1"), MessageId.makeUnsafe("u2")],
    });
    store.set({
      currentId: MessageId.makeUnsafe("u1"),
      visibleIds: [MessageId.makeUnsafe("u1"), MessageId.makeUnsafe("u2")],
    }); // duplicate snapshot — no notification
    expect(store.get()).toEqual({
      currentId: MessageId.makeUnsafe("u1"),
      visibleIds: [MessageId.makeUnsafe("u1"), MessageId.makeUnsafe("u2")],
    });
    expect(notifications).toBe(1);

    store.set({
      currentId: MessageId.makeUnsafe("u1"),
      visibleIds: [MessageId.makeUnsafe("u2")],
    });
    expect(notifications).toBe(2);

    store.set(null);
    expect(store.get()).toEqual({ currentId: null, visibleIds: [] });
    expect(notifications).toBe(3);

    unsubscribe();
    store.set({ currentId: MessageId.makeUnsafe("u3"), visibleIds: [] });
    expect(notifications).toBe(3);
    expect(store.get()).toEqual({ currentId: MessageId.makeUnsafe("u3"), visibleIds: [] });
  });
});

const allFinite = (values: readonly number[]) => values.every((v) => Number.isFinite(v));

describe("computeTrailGeometry", () => {
  it("keeps the spacing fixed for many messages and grows the content height", () => {
    const spacing = 10;
    const padding = 12;
    const count = 200;
    const geom = computeTrailGeometry({ count, spacingPx: spacing, paddingPx: padding })!;
    expect(geom.spacing).toBe(spacing); // never compressed to fit
    expect(geom.centerYs[0]).toBe(padding);
    expect(geom.centerYs[count - 1]).toBe(padding + (count - 1) * spacing);
    expect(geom.contentHeight).toBe(2 * padding + (count - 1) * spacing);
    expect(allFinite(geom.centerYs)).toBe(true);
  });
});

describe("computeGaussianWeights", () => {
  const centerYs = [0, 10, 20, 30, 40];

  it("peaks at exactly 1 under the pointer and stays within [0,1]", () => {
    const weights = computeGaussianWeights(centerYs, 20, 7);
    expect(weights[2]).toBe(1);
    expect(weights.every((w) => w >= 0 && w <= 1)).toBe(true);
  });
});

describe("computeFocusedIndex", () => {
  const geom: TrailGeometry = {
    startY: 100,
    spacing: 10,
    centerYs: [100, 110, 120, 130, 140],
    contentHeight: 264,
  };

  it("returns 0 for a single/degenerate rail", () => {
    expect(
      computeFocusedIndex(999, { startY: 50, spacing: 0, centerYs: [50], contentHeight: 100 }),
    ).toBe(0);
  });

  it("maps pointer position to the nearest tick", () => {
    expect(computeFocusedIndex(100, geom)).toBe(0);
    expect(computeFocusedIndex(124, geom)).toBe(2);
    expect(computeFocusedIndex(140, geom)).toBe(4);
  });

  it("clamps out-of-range pointers to the first/last tick (never negative or N)", () => {
    expect(computeFocusedIndex(-500, geom)).toBe(0);
    expect(computeFocusedIndex(99999, geom)).toBe(4);
  });

  it("is finite-safe for a NaN pointer", () => {
    expect(computeFocusedIndex(Number.NaN, geom)).toBe(0);
  });
});

describe("clampTooltipTop", () => {
  it("keeps the tooltip on-screen near the edges and untouched in the middle", () => {
    expect(clampTooltipTop(10, 56, 500, 4)).toBe(32);
    expect(clampTooltipTop(490, 56, 500, 4)).toBe(468);
    expect(clampTooltipTop(250, 56, 500, 4)).toBe(250);
  });
});
