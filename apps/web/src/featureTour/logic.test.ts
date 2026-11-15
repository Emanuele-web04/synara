import { describe, expect, it } from "vitest";

import { placeTourCard, resolveTourSteps } from "./logic";

const steps = [{ anchor: "activity" }, { anchor: "tasks" }, { anchor: "inbox" }] as const;
const card = { width: 340, height: 300 };
const viewport = { width: 1280, height: 800 };

describe("resolveTourSteps", () => {
  it("skips steps whose control is not on screen", () => {
    const resolved = resolveTourSteps(steps, (anchor) => anchor !== "tasks");
    expect(resolved.map(({ step, anchored }) => [step.anchor, anchored])).toEqual([
      ["activity", true],
      ["inbox", true],
    ]);
  });

  it("keeps every step, centered, when no control is on screen", () => {
    const resolved = resolveTourSteps(steps, () => false);
    expect(resolved.map(({ anchored }) => anchored)).toEqual([false, false, false]);
  });
});

describe("placeTourCard", () => {
  it("hangs the card to the right of a rail button and points the caret at it", () => {
    const placement = placeTourCard({
      anchor: { left: 8, top: 200, width: 36, height: 36 },
      card,
      viewport,
    });
    expect(placement).toEqual({ left: 58, top: 180, side: "right", caret: 38 });
  });

  it("keeps the card inside the viewport for an anchor near the bottom", () => {
    const placement = placeTourCard({
      anchor: { left: 8, top: 760, width: 36, height: 36 },
      card,
      viewport,
    });
    expect(placement.side).toBe("right");
    expect(placement.top).toBe(viewport.height - 12 - card.height);
    // The caret still points at the anchor, clear of the rounded corner.
    expect(placement.caret).toBe(card.height - 22);
  });

  it("falls back below, then centered, when the window is too narrow", () => {
    const narrow = { width: 360, height: 800 };
    const below = placeTourCard({
      anchor: { left: 300, top: 40, width: 30, height: 30 },
      card: { width: 336, height: 300 },
      viewport: narrow,
    });
    expect(below).toMatchObject({ side: "bottom", left: 12, top: 84 });

    const centered = placeTourCard({
      anchor: { left: 300, top: 400, width: 30, height: 30 },
      card: { width: 336, height: 420 },
      viewport: narrow,
    });
    expect(centered.side).toBe("center");
  });

  it("centers the card when the step has no anchor", () => {
    expect(placeTourCard({ anchor: null, card, viewport })).toEqual({
      left: 470,
      top: 250,
      side: "center",
      caret: null,
    });
  });
});
