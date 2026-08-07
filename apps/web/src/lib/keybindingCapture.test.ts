import { describe, expect, it } from "vitest";

import { keybindingFromKeyboardEvent } from "./keybindingCapture";

describe("keybindingFromKeyboardEvent", () => {
  it("captures a single key", () => {
    expect(
      keybindingFromKeyboardEvent({
        key: "F2",
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
        altKey: false,
      }),
    ).toBe("f2");
  });

  it("normalizes a platform modifier combination", () => {
    expect(
      keybindingFromKeyboardEvent(
        {
          key: "P",
          ctrlKey: false,
          metaKey: true,
          shiftKey: true,
          altKey: false,
        },
        "MacIntel",
      ),
    ).toBe("mod+shift+p");
  });

  it("rejects combinations above the three-key capture limit", () => {
    expect(
      keybindingFromKeyboardEvent({
        key: "P",
        ctrlKey: true,
        metaKey: false,
        shiftKey: true,
        altKey: true,
      }),
    ).toBeNull();
  });

  it("does not commit modifier-only keydowns", () => {
    expect(
      keybindingFromKeyboardEvent({
        key: "Control",
        ctrlKey: true,
        metaKey: false,
        shiftKey: false,
        altKey: false,
      }),
    ).toBeNull();
  });
});
