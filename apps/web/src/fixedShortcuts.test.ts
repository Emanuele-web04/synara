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
  it.each([true, false])("matches terminal search only with terminalFocus=%s", (terminalFocus) => {
    expect(
      matchesFixedShortcut(event({ key: "f", ctrlKey: true }), "terminal.search", "Win32", {
        terminalFocus,
      }),
    ).toBe(terminalFocus);
  });
});
