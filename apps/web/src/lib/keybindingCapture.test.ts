import { describe, expect, it } from "vitest";

import {
  keybindingFromKeyboardEvent,
  keybindingValueFromShortcut,
  shortcutFromKeyboardEvent,
} from "./keybindingCapture";

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

  it("rejects unsupported named keys that merely begin with f", () => {
    expect(
      keybindingFromKeyboardEvent({
        key: "Fn",
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
        altKey: false,
      }),
    ).toBeNull();
  });
});

describe("keybindingValueFromShortcut", () => {
  it("serializes a resolved shortcut back to config syntax", () => {
    expect(
      keybindingValueFromShortcut({
        key: "escape",
        modKey: true,
        metaKey: false,
        ctrlKey: false,
        shiftKey: true,
        altKey: false,
      }),
    ).toBe("mod+shift+esc");
  });
});

it("captures Option+Space even when macOS reports a non-breaking space", () => {
  expect(
    keybindingFromKeyboardEvent(
      {
        key: "\u00a0",
        code: "Space",
        altKey: true,
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
      },
      "MacIntel",
    ),
  ).toBe("alt+space");
});

describe("shortcutFromKeyboardEvent", () => {
  const released = { ctrlKey: false, metaKey: false, shiftKey: false, altKey: false };

  it("names the platform's primary modifier mod", () => {
    const pressed = { ...released, key: "k", code: "KeyK" };

    expect(shortcutFromKeyboardEvent({ ...pressed, metaKey: true }, "MacIntel")).toMatchObject({
      key: "k",
      modKey: true,
      metaKey: false,
    });
    expect(shortcutFromKeyboardEvent({ ...pressed, ctrlKey: true }, "MacIntel")).toMatchObject({
      modKey: false,
      ctrlKey: true,
    });
    expect(shortcutFromKeyboardEvent({ ...pressed, ctrlKey: true }, "Win32")).toMatchObject({
      modKey: true,
      ctrlKey: false,
    });
  });

  it("records the key the user pressed when a modifier changes the character", () => {
    // Option on macOS turns S into "ß" and Space into a non-breaking space.
    expect(
      shortcutFromKeyboardEvent({ ...released, key: "ß", code: "KeyS", altKey: true }, "MacIntel"),
    ).toMatchObject({ key: "s", altKey: true });
    expect(
      shortcutFromKeyboardEvent(
        { ...released, key: "\u00a0", code: "Space", altKey: true },
        "MacIntel",
      ),
    ).toMatchObject({ key: " ", altKey: true });
    expect(
      shortcutFromKeyboardEvent(
        { ...released, key: "!", code: "Digit1", metaKey: true, shiftKey: true },
        "MacIntel",
      ),
    ).toMatchObject({ key: "1", modKey: true, shiftKey: true });
  });

  it("keeps the letter the layout prints over the physical key", () => {
    // AZERTY: the key labelled A sits where QWERTY has Q.
    expect(
      shortcutFromKeyboardEvent({ ...released, key: "a", code: "KeyQ", metaKey: true }, "MacIntel"),
    ).toMatchObject({ key: "a" });
  });

  it("waits for a key while only modifiers are down, and skips keys it cannot name", () => {
    expect(shortcutFromKeyboardEvent({ ...released, key: "Meta", metaKey: true })).toBeNull();
    expect(shortcutFromKeyboardEvent({ ...released, key: "Dead", altKey: true })).toBeNull();
  });

  it("round-trips through the config syntax", () => {
    const shortcut = shortcutFromKeyboardEvent(
      { ...released, key: "Escape", code: "Escape", metaKey: true, altKey: true },
      "MacIntel",
    );

    expect(shortcut && keybindingValueFromShortcut(shortcut)).toBe("mod+alt+esc");
  });
});
