import { describe, expect, it } from "vitest";

import { matchesFixedShortcut } from "./fixedShortcuts";
import type { ShortcutEventLike } from "./keybindings";

function event(overrides: Partial<ShortcutEventLike> = {}): ShortcutEventLike {
  return {
    key: "p",
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...overrides,
  };
}

describe("fixed shortcut context guards", () => {
  it("keeps workspace search out of a focused non-Mac terminal", () => {
    const context = { terminalFocus: true };

    expect(matchesFixedShortcut(event({ ctrlKey: true }), "search.files", "Win32", context)).toBe(
      false,
    );
    expect(
      matchesFixedShortcut(
        event({ key: "f", ctrlKey: true, shiftKey: true }),
        "search.content",
        "Win32",
        context,
      ),
    ).toBe(false);
  });

  it("still opens workspace search outside terminal focus", () => {
    const context = { terminalFocus: false };

    expect(matchesFixedShortcut(event({ ctrlKey: true }), "search.files", "Win32", context)).toBe(
      true,
    );
    expect(
      matchesFixedShortcut(
        event({ key: "f", ctrlKey: true, shiftKey: true }),
        "search.content",
        "Win32",
        context,
      ),
    ).toBe(true);
  });

  it("keeps terminal search available to the terminal surface", () => {
    expect(
      matchesFixedShortcut(event({ key: "f", ctrlKey: true }), "terminal.search", "Win32", {
        terminalFocus: true,
      }),
    ).toBe(true);
  });
});
