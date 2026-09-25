// FILE: ChatPaneDropOverlay.test.tsx
// Purpose: Cover pure drop-zone helpers (hit-test and drag-payload guard) used by the overlay.
// Layer: UI helpers test
// Targets: getDropZoneFromPointer, isThreadDragPayloadAllowed.

import { describe, expect, it } from "vitest";
import { ThreadId } from "@synara/contracts";

import { getDropZoneFromPointer, isThreadDragPayloadAllowed } from "./ChatPaneDropOverlay";

const RECT = { left: 0, top: 0, width: 100, height: 100 };
const THREAD_A = ThreadId.makeUnsafe("thread-a");
const THREAD_B = ThreadId.makeUnsafe("thread-b");

describe("getDropZoneFromPointer", () => {
  it("uses wide-pane regions that make left/right reliable", () => {
    const wideRect = { left: 0, top: 0, width: 300, height: 100 };

    expect(getDropZoneFromPointer(wideRect, 20, 5)).toBe("left");
    expect(getDropZoneFromPointer(wideRect, 280, 95)).toBe("right");
    expect(getDropZoneFromPointer(wideRect, 150, 10)).toBe("top");
    expect(getDropZoneFromPointer(wideRect, 150, 90)).toBe("bottom");
  });

  it("uses tall-pane regions that make top/bottom reliable", () => {
    const tallRect = { left: 0, top: 0, width: 100, height: 300 };

    expect(getDropZoneFromPointer(tallRect, 5, 20)).toBe("top");
    expect(getDropZoneFromPointer(tallRect, 95, 280)).toBe("bottom");
    expect(getDropZoneFromPointer(tallRect, 10, 150)).toBe("left");
    expect(getDropZoneFromPointer(tallRect, 90, 150)).toBe("right");
  });

  it("chooses the nearest allowed edge when some directions are disabled", () => {
    const onlyVertical = (zone: "top" | "bottom" | "left" | "right") =>
      zone === "top" || zone === "bottom";
    const onlyHorizontal = (zone: "top" | "bottom" | "left" | "right") =>
      zone === "left" || zone === "right";

    expect(getDropZoneFromPointer(RECT, 5, 55, onlyVertical)).toBe("bottom");
    expect(getDropZoneFromPointer(RECT, 60, 5, onlyHorizontal)).toBe("right");
  });

  it("returns null when every direction is disabled", () => {
    expect(getDropZoneFromPointer(RECT, 50, 50, () => false)).toBeNull();
  });

  it("returns null for points outside the rectangle", () => {
    expect(getDropZoneFromPointer(RECT, -5, 50)).toBeNull();
    expect(getDropZoneFromPointer(RECT, 50, 200)).toBeNull();
  });

  it("returns null for degenerate rectangles", () => {
    expect(getDropZoneFromPointer({ left: 0, top: 0, width: 0, height: 0 }, 0, 0)).toBeNull();
  });
});

describe("isThreadDragPayloadAllowed", () => {
  it("rejects drops only for already mounted threads", () => {
    expect(
      isThreadDragPayloadAllowed(
        { threadId: THREAD_A },
        { excludedThreadIds: new Set([THREAD_A]) },
      ),
    ).toBe(false);
    expect(
      isThreadDragPayloadAllowed(
        { threadId: THREAD_B },
        { excludedThreadIds: new Set([THREAD_A]) },
      ),
    ).toBe(true);
  });
});
