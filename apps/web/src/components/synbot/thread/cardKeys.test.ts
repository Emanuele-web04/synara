import type { KeyboardEvent } from "react";
import { describe, expect, it, vi } from "vitest";

import { letterIndex, letterKeyHandler } from "./cardKeys";

const plain = { metaKey: false, ctrlKey: false, altKey: false, shiftKey: false };

/** A keydown as React hands it to the card container's onKeyDown. */
function keydown(key: string, extra: Partial<typeof plain> = {}) {
  const preventDefault = vi.fn();
  const event = {
    key,
    ...plain,
    ...extra,
    target: null,
    defaultPrevented: false,
    nativeEvent: { isComposing: false },
    preventDefault,
  } as unknown as KeyboardEvent<HTMLElement>;
  return { event, preventDefault };
}

describe("letterIndex", () => {
  it("reads A, B, C… as 0, 1, 2…, in either case", () => {
    expect(letterIndex({ key: "a", ...plain })).toBe(0);
    expect(letterIndex({ key: "C", ...plain })).toBe(2);
  });

  it("ignores modified keys, composition and non-letters", () => {
    expect(letterIndex({ key: "a", ...plain, metaKey: true })).toBe(-1);
    expect(letterIndex({ key: "a", ...plain, shiftKey: true })).toBe(-1);
    expect(letterIndex({ key: "a", ...plain, isComposing: true })).toBe(-1);
    expect(letterIndex({ key: "1", ...plain })).toBe(-1);
    expect(letterIndex({ key: "Enter", ...plain })).toBe(-1);
  });
});

describe("letterKeyHandler", () => {
  it("answers the card the key was pressed in, within its answers", () => {
    const pick = vi.fn();
    const onKeyDown = letterKeyHandler(2, pick);
    const b = keydown("b");
    onKeyDown(b.event);
    expect(pick).toHaveBeenCalledWith(1);
    expect(b.preventDefault).toHaveBeenCalled();

    const c = keydown("c");
    onKeyDown(c.event);
    expect(pick).toHaveBeenCalledTimes(1);
    expect(c.preventDefault).not.toHaveBeenCalled();
  });

  it("takes nothing while no answer is open or with a modifier held", () => {
    const pick = vi.fn();
    letterKeyHandler(0, pick)(keydown("a").event);
    letterKeyHandler(3, pick)(keydown("a", { ctrlKey: true }).event);
    expect(pick).not.toHaveBeenCalled();
  });
});
