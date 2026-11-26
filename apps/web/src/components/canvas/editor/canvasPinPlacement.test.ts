import { describe, expect, it } from "vitest";
import { PIN_BADGE_GAP, pinShiftClearOfBadge, type ScreenBox } from "./canvasPinPlacement";

const box = (left: number, top: number, width: number, height: number): ScreenBox => ({
  left,
  top,
  right: left + width,
  bottom: top + height,
});

// A 100 × 16 badge under a selection, and 26px pins.
const badge = box(200, 300, 100, 16);
const pin = (left: number, top: number) => box(left, top, 26, 26);
const moved = (from: ScreenBox, shift: { x: number; y: number }) => ({
  left: from.left + shift.x,
  top: from.top + shift.y,
  right: from.right + shift.x,
  bottom: from.bottom + shift.y,
});
const overlaps = (a: ScreenBox, b: ScreenBox) =>
  a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

describe("pinShiftClearOfBadge", () => {
  it("leaves a pin that is clear of the badge where it is", () => {
    expect(pinShiftClearOfBadge(pin(100, 290), badge)).toEqual({ x: 0, y: 0 });
    expect(pinShiftClearOfBadge(pin(320, 290), badge)).toEqual({ x: 0, y: 0 });
    expect(pinShiftClearOfBadge(pin(240, 240), badge)).toEqual({ x: 0, y: 0 });
    expect(pinShiftClearOfBadge(pin(240, 330), badge)).toEqual({ x: 0, y: 0 });
  });

  it("moves a pin over the badge's right end out to the right", () => {
    // The seeded case: the pin's left edge sits 14px inside the badge.
    const start = pin(286, 296);
    const shift = pinShiftClearOfBadge(start, badge);
    expect(shift).toEqual({ x: 300 + PIN_BADGE_GAP - 286, y: 0 });
    expect(overlaps(moved(start, shift), badge)).toBe(false);
  });

  it("moves a pin over the badge's left end out to the left", () => {
    const start = pin(185, 296);
    const shift = pinShiftClearOfBadge(start, badge);
    expect(shift).toEqual({ x: 200 - PIN_BADGE_GAP - 211, y: 0 });
    expect(overlaps(moved(start, shift), badge)).toBe(false);
  });

  it("moves a pin that only dips into the badge's bottom down, never up onto the selection", () => {
    const start = pin(237, 312);
    const shift = pinShiftClearOfBadge(start, badge);
    expect(shift).toEqual({ x: 0, y: 316 + PIN_BADGE_GAP - 312 });
    // A pin resting on the badge's top edge also goes down or sideways, not up.
    const above = pinShiftClearOfBadge(pin(237, 280), badge);
    expect(above.y).toBeGreaterThanOrEqual(0);
  });

  it("keeps the gap: a pin touching the badge still steps aside", () => {
    const touching = pin(300, 296);
    expect(pinShiftClearOfBadge(touching, badge)).toEqual({ x: PIN_BADGE_GAP, y: 0 });
    expect(pinShiftClearOfBadge(pin(300 + PIN_BADGE_GAP, 296), badge)).toEqual({ x: 0, y: 0 });
  });

  it("breaks a tie left, then right, then down", () => {
    // Centred on a 26px-wide badge: left and right are equally far, and down is farther.
    const narrow = box(100, 100, 26, 16);
    const centred = pin(100, 80);
    expect(pinShiftClearOfBadge(centred, narrow)).toEqual({ x: -(26 + PIN_BADGE_GAP), y: 0 });
  });

  it("gives the same answer every time", () => {
    const start = pin(250, 299);
    expect(pinShiftClearOfBadge(start, badge)).toEqual(pinShiftClearOfBadge(start, badge));
  });
});
