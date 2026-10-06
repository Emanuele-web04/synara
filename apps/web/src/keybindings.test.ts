import { assert, describe, it } from "vitest";

import {
  type KeybindingCommand,
  type KeybindingShortcut,
  type KeybindingWhenNode,
  type ResolvedKeybindingsConfig,
} from "@synara/contracts";
import {
  formatKeybindingWhenExpression,
  formatShortcutLabel,
  isEditorFileSaveShortcut,
  isKeyboardShortcutsHelpShortcut,
  isTerminalClearShortcut,
  resolveShortcutCommand,
  resolveKeybindingForCommand,
  shouldShowThreadJumpHints,
  shortcutLabelForCommand,
  spaceJumpIndexFromCommand,
  splitShortcutLabel,
  suspendShortcutDispatch,
  terminalNavigationShortcutData,
  threadJumpCommandForIndex,
  threadJumpIndexFromCommand,
  type ShortcutEventLike,
} from "./keybindings";

function event(overrides: Partial<ShortcutEventLike> = {}): ShortcutEventLike {
  return {
    key: "j",
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...overrides,
  };
}

describe("editable keybinding resolution", () => {
  it("preserves the effective platform condition as editable text", () => {
    const binding = resolveKeybindingForCommand([], "chat.new", {
      platform: "MacIntel",
      context: { terminalFocus: false, terminalOpen: false },
    });

    assert.isNotNull(binding);
    assert.equal(formatKeybindingWhenExpression(binding?.whenAst), "(!(terminalFocus) || isMac)");
  });
});

describe("active thread action shortcuts", () => {
  for (const [key, command] of [
    ["a", "thread.archive"],
    ["s", "thread.snooze"],
    ["u", "thread.markUnread"],
  ] as const) {
    it(`resolves ${command} on both platforms and yields to non-Mac terminals`, () => {
      for (const platform of ["MacIntel", "Win32", "Linux"]) {
        const press = event({
          key,
          metaKey: platform === "MacIntel",
          ctrlKey: platform !== "MacIntel",
          altKey: true,
          shiftKey: true,
        });
        assert.equal(resolveShortcutCommand(press, [], { platform }), command);
        assert.equal(
          resolveShortcutCommand(press, [], { platform, context: { terminalFocus: true } }),
          platform === "MacIntel" ? command : null,
        );
      }
    });
  }
});

describe("layout-aware matching", () => {
  const rules = (...entries: Array<[KeybindingCommand, string]>): ResolvedKeybindingsConfig =>
    entries.map(([command, key]) => ({
      command,
      shortcut: {
        key,
        modKey: true,
        metaKey: false,
        ctrlKey: false,
        altKey: false,
        shiftKey: true,
      },
    }));
  const options = { platform: "MacIntel", context: { terminalFocus: false, terminalOpen: false } };

  it("matches a typed letter only as that letter, not also as its physical key", () => {
    // AZERTY: the key in QWERTY's Q position types "a".
    const press = event({ key: "a", code: "KeyQ", metaKey: true, shiftKey: true });
    const bindings = rules(["chat.new", "q"], ["terminal.toggle", "a"]);

    assert.equal(resolveShortcutCommand(press, bindings, options), "terminal.toggle");
    assert.isNull(resolveShortcutCommand(press, rules(["chat.new", "q"]), options));
  });

  it("falls back to the physical key when the layout types something else", () => {
    // Option on macOS and Shift on the number row change the character, not the key.
    const optionS = event({ key: "ß", code: "KeyS", metaKey: true, shiftKey: true });
    const shiftOne = event({ key: "!", code: "Digit1", metaKey: true, shiftKey: true });

    assert.equal(resolveShortcutCommand(optionS, rules(["chat.new", "s"]), options), "chat.new");
    assert.equal(resolveShortcutCommand(shiftOne, rules(["chat.new", "1"]), options), "chat.new");
  });
});

describe("splitShortcutLabel", () => {
  it("keeps the plus key as a key of its own", () => {
    assert.deepEqual(splitShortcutLabel("Ctrl++"), ["Ctrl", "+"]);
    assert.deepEqual(splitShortcutLabel("Ctrl+Shift++"), ["Ctrl", "Shift", "+"]);
    assert.deepEqual(splitShortcutLabel("⌘+"), ["⌘", "+"]);
    assert.deepEqual(splitShortcutLabel("+"), ["+"]);
  });

  it("splits ordinary labels as before", () => {
    assert.deepEqual(splitShortcutLabel("Ctrl+Shift+K"), ["Ctrl", "Shift", "K"]);
    assert.deepEqual(splitShortcutLabel("⇧⌘Right"), ["⇧", "⌘", "Right"]);
  });
});

describe("isKeyboardShortcutsHelpShortcut", () => {
  it("does not mistake the physical minus keys for shortcuts help on Windows", () => {
    assert.isFalse(
      isKeyboardShortcutsHelpShortcut(event({ ctrlKey: true, key: "/", code: "Minus" }), "Win32"),
    );
    assert.isFalse(
      isKeyboardShortcutsHelpShortcut(
        event({ ctrlKey: true, key: "/", code: "NumpadSubtract" }),
        "Win32",
      ),
    );
    assert.isFalse(
      isKeyboardShortcutsHelpShortcut(event({ ctrlKey: true, key: "-", code: "Slash" }), "Win32"),
    );
  });

  it("ignores key-up, auto-repeat, and modified slash events", () => {
    const platform = "Win32";
    assert.isFalse(
      isKeyboardShortcutsHelpShortcut(
        event({ type: "keyup", ctrlKey: true, key: "/", code: "Slash" }),
        platform,
      ),
    );
    assert.isFalse(
      isKeyboardShortcutsHelpShortcut(
        event({ repeat: true, ctrlKey: true, key: "/", code: "Slash" }),
        platform,
      ),
    );
    assert.isFalse(
      isKeyboardShortcutsHelpShortcut(
        event({ ctrlKey: true, shiftKey: true, key: "/", code: "Slash" }),
        platform,
      ),
    );
    assert.isFalse(
      isKeyboardShortcutsHelpShortcut(
        event({ ctrlKey: true, altKey: true, key: "/", code: "Slash" }),
        platform,
      ),
    );
  });
});

function modShortcut(
  key: string,
  overrides: Partial<Omit<KeybindingShortcut, "key">> = {},
): KeybindingShortcut {
  return {
    key,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    modKey: true,
    ...overrides,
  };
}

function ctrlShortcut(
  key: string,
  overrides: Partial<Omit<KeybindingShortcut, "key">> = {},
): KeybindingShortcut {
  return {
    key,
    metaKey: false,
    ctrlKey: true,
    shiftKey: false,
    altKey: false,
    modKey: false,
    ...overrides,
  };
}

function whenIdentifier(name: string): KeybindingWhenNode {
  return { type: "identifier", name };
}

function whenNot(node: KeybindingWhenNode): KeybindingWhenNode {
  return { type: "not", node };
}

function whenAnd(left: KeybindingWhenNode, right: KeybindingWhenNode): KeybindingWhenNode {
  return { type: "and", left, right };
}

function whenOr(left: KeybindingWhenNode, right: KeybindingWhenNode): KeybindingWhenNode {
  return { type: "or", left, right };
}

// Mirrors the production `whenModChordAllowed` guard: app-level mod chords fire outside the
// terminal everywhere, and also from the terminal on macOS (where Cmd-chords never reach
// the shell). `isMac` is derived from the platform inside resolveContext.
const whenModChordAllowed = whenOr(
  whenNot(whenIdentifier("terminalFocus")),
  whenIdentifier("isMac"),
);

interface TestBinding {
  shortcut: KeybindingShortcut;
  command: KeybindingCommand;
  whenAst?: KeybindingWhenNode;
}

function compile(bindings: TestBinding[]): ResolvedKeybindingsConfig {
  return bindings.map((binding) => ({
    command: binding.command,
    shortcut: binding.shortcut,
    ...(binding.whenAst ? { whenAst: binding.whenAst } : {}),
  }));
}

// Mirror the server defaults here so frontend shortcut resolution stays aligned.
const DEFAULT_BINDINGS = compile([
  {
    shortcut: modShortcut("b"),
    command: "sidebar.toggle",
    whenAst: whenNot(whenIdentifier("terminalFocus")),
  },
  // Mirror server defaults: Cmd+K everywhere; Ctrl+K only off macOS.
  { shortcut: modShortcut("k", { metaKey: true, modKey: false }), command: "sidebar.search" },
  {
    shortcut: ctrlShortcut("k"),
    command: "sidebar.search",
    whenAst: whenNot(whenIdentifier("isMac")),
  },
  {
    shortcut: modShortcut("u", { altKey: true }),
    command: "sidebar.activity",
    whenAst: whenModChordAllowed,
  },
  { shortcut: modShortcut("j"), command: "terminal.toggle" },
  {
    shortcut: modShortcut("d"),
    command: "terminal.workspace.terminal",
    whenAst: whenIdentifier("terminalFocus"),
  },
  {
    shortcut: modShortcut("t"),
    command: "terminal.new",
    whenAst: whenIdentifier("terminalFocus"),
  },
  {
    shortcut: modShortcut("w"),
    command: "terminal.close",
    whenAst: whenIdentifier("terminalFocus"),
  },
  {
    shortcut: modShortcut("j", { shiftKey: true }),
    command: "terminal.workspace.newFullWidth",
  },
  {
    shortcut: modShortcut("w"),
    command: "terminal.workspace.closeActive",
    whenAst: whenIdentifier("terminalWorkspaceOpen"),
  },
  {
    shortcut: ctrlShortcut("1"),
    command: "terminal.workspace.terminal",
    whenAst: whenIdentifier("terminalWorkspaceOpen"),
  },
  {
    shortcut: ctrlShortcut("2"),
    command: "terminal.workspace.chat",
    whenAst: whenIdentifier("terminalWorkspaceOpen"),
  },
  {
    shortcut: modShortcut("d"),
    command: "diff.toggle",
    whenAst: whenNot(whenIdentifier("terminalFocus")),
  },
  {
    shortcut: modShortcut("b", { shiftKey: true }),
    command: "browser.toggle",
    whenAst: whenNot(whenIdentifier("terminalFocus")),
  },
  {
    shortcut: modShortcut("m", { shiftKey: true }),
    command: "modelPicker.toggle",
    whenAst: whenNot(whenIdentifier("terminalFocus")),
  },
  {
    shortcut: modShortcut("]", { altKey: true, modKey: false }),
    command: "model.next",
    whenAst: whenNot(whenIdentifier("terminalFocus")),
  },
  {
    shortcut: modShortcut("[", { altKey: true, modKey: false }),
    command: "model.previous",
    whenAst: whenNot(whenIdentifier("terminalFocus")),
  },
  {
    shortcut: modShortcut("tab", { shiftKey: true, modKey: false }),
    command: "model.effort.next",
    whenAst: whenIdentifier("composerFocus"),
  },
  {
    shortcut: modShortcut("e", { shiftKey: true }),
    command: "traitsPicker.toggle",
    whenAst: whenNot(whenIdentifier("terminalFocus")),
  },
  {
    shortcut: modShortcut("l", { metaKey: true, modKey: false }),
    command: "composer.focus.toggle",
    whenAst: whenNot(whenIdentifier("terminalFocus")),
  },
  {
    shortcut: modShortcut("f"),
    command: "chat.find",
    whenAst: whenNot(whenIdentifier("terminalFocus")),
  },
  {
    shortcut: modShortcut("u", { shiftKey: true }),
    command: "settings.usage",
    whenAst: whenNot(whenIdentifier("terminalFocus")),
  },
  {
    shortcut: modShortcut("o", { shiftKey: true }),
    command: "sidebar.addProject",
    whenAst: whenNot(whenIdentifier("terminalFocus")),
  },
  {
    shortcut: modShortcut("i"),
    command: "sidebar.importThread",
    whenAst: whenNot(whenIdentifier("terminalFocus")),
  },
  {
    shortcut: modShortcut("n"),
    command: "chat.new",
    whenAst: whenModChordAllowed,
  },
  {
    shortcut: modShortcut("n", { shiftKey: true }),
    command: "chat.newLatestProject",
    whenAst: whenModChordAllowed,
  },
  {
    shortcut: modShortcut("n", { altKey: true }),
    command: "chat.newChat",
    whenAst: whenModChordAllowed,
  },
  {
    shortcut: modShortcut("t", { shiftKey: true }),
    command: "chat.newTerminal",
    whenAst: whenModChordAllowed,
  },
  {
    shortcut: modShortcut("c", { altKey: true }),
    command: "chat.newClaude",
    whenAst: whenModChordAllowed,
  },
  {
    shortcut: modShortcut("x", { altKey: true }),
    command: "chat.newCodex",
    whenAst: whenModChordAllowed,
  },
  {
    shortcut: modShortcut("r", { altKey: true }),
    command: "chat.newCursor",
    whenAst: whenModChordAllowed,
  },
  {
    shortcut: ctrlShortcut("tab"),
    command: "view.recent.next",
  },
  {
    shortcut: ctrlShortcut("tab", { shiftKey: true }),
    command: "view.recent.previous",
  },
  ...Array.from({ length: 9 }, (_, index) => ({
    shortcut: modShortcut(String(index + 1), { altKey: true }),
    command: `space.jump.${index + 1}` as KeybindingCommand,
    whenAst: whenModChordAllowed,
  })),
  ...Array.from({ length: 9 }, (_, index) => ({
    shortcut: modShortcut(String(index + 1)),
    command: `thread.jump.${index + 1}` as KeybindingCommand,
    whenAst: whenOr(
      whenAnd(
        whenNot(whenIdentifier("terminalFocus")),
        whenNot(whenIdentifier("terminalWorkspaceOpen")),
      ),
      whenIdentifier("isMac"),
    ),
  })),
  {
    shortcut: modShortcut("c", { shiftKey: true }),
    command: "thread.copyId",
    whenAst: whenModChordAllowed,
  },
  {
    shortcut: modShortcut("]", { shiftKey: true }),
    command: "chat.visible.next",
    whenAst: whenNot(whenIdentifier("terminalFocus")),
  },
  {
    shortcut: modShortcut("[", { shiftKey: true }),
    command: "chat.visible.previous",
    whenAst: whenNot(whenIdentifier("terminalFocus")),
  },
  { shortcut: modShortcut("o"), command: "editor.openFavorite" },
  {
    shortcut: modShortcut("s"),
    command: "editor.file.save",
    whenAst: whenNot(whenIdentifier("terminalFocus")),
  },
]);

describe("terminal shortcuts", () => {
  it("ignores retired split shortcuts so they cannot consume shell keys", () => {
    const keybindings = compile([{ shortcut: modShortcut("d"), command: "terminal.split" }]);
    assert.equal(
      resolveShortcutCommand(event({ key: "d", ctrlKey: true }), keybindings, {
        platform: "Win32",
        context: { terminalOpen: true, terminalFocus: true },
      }),
      null,
    );
  });

  it("supports when expressions", () => {
    const keybindings = compile([
      {
        shortcut: modShortcut("\\"),
        command: "terminal.workspace.terminal",
        whenAst: whenAnd(whenIdentifier("terminalOpen"), whenNot(whenIdentifier("terminalFocus"))),
      },
      {
        shortcut: modShortcut("n", { shiftKey: true }),
        command: "terminal.new",
        whenAst: whenAnd(whenIdentifier("terminalOpen"), whenNot(whenIdentifier("terminalFocus"))),
      },
      { shortcut: modShortcut("j"), command: "terminal.toggle" },
    ]);
    assert.equal(
      resolveShortcutCommand(event({ key: "\\", ctrlKey: true }), keybindings, {
        platform: "Win32",
        context: { terminalOpen: true, terminalFocus: false },
      }),
      "terminal.workspace.terminal",
    );
    assert.notEqual(
      resolveShortcutCommand(event({ key: "\\", ctrlKey: true }), keybindings, {
        platform: "Win32",
        context: { terminalOpen: false, terminalFocus: false },
      }),
      "terminal.workspace.terminal",
    );
    assert.equal(
      resolveShortcutCommand(event({ key: "n", ctrlKey: true, shiftKey: true }), keybindings, {
        platform: "Win32",
        context: { terminalOpen: true, terminalFocus: false },
      }),
      "terminal.new",
    );
  });

  it("matches physical digit shortcuts even when event.key is layout-shifted", () => {
    assert.strictEqual(
      resolveShortcutCommand(
        event({
          code: "Digit1",
          key: "&",
          ctrlKey: true,
        }),
        DEFAULT_BINDINGS,
        {
          platform: "Win32",
          context: { terminalWorkspaceOpen: true },
        },
      ),
      "terminal.workspace.terminal",
    );
  });

  it("matches physical bracket shortcuts even when event.key differs from the printed symbol", () => {
    const keybindings = compile([
      {
        shortcut: modShortcut("[", { shiftKey: true }),
        command: "chat.visible.previous",
        whenAst: whenNot(whenIdentifier("terminalFocus")),
      },
    ]);

    assert.strictEqual(
      resolveShortcutCommand(
        event({
          code: "BracketLeft",
          key: "^",
          ctrlKey: true,
          shiftKey: true,
        }),
        keybindings,
        {
          platform: "Win32",
          context: { terminalFocus: false },
        },
      ),
      "chat.visible.previous",
    );
  });

  it("supports when boolean literals", () => {
    const keybindings = compile([
      { shortcut: modShortcut("n"), command: "terminal.new", whenAst: whenIdentifier("true") },
      { shortcut: modShortcut("m"), command: "terminal.new", whenAst: whenIdentifier("false") },
    ]);

    assert.equal(
      resolveShortcutCommand(event({ key: "n", ctrlKey: true }), keybindings, {
        platform: "Linux",
      }),
      "terminal.new",
    );
    assert.notEqual(
      resolveShortcutCommand(event({ key: "m", ctrlKey: true }), keybindings, {
        platform: "Linux",
      }),
      "terminal.new",
    );
  });
});

describe("composer focus shortcuts", () => {
  it("does not treat Ctrl+L as the composer focus shortcut on non-macOS", () => {
    assert.isNull(
      resolveShortcutCommand(event({ key: "l", ctrlKey: true }), DEFAULT_BINDINGS, {
        platform: "Linux",
        context: { terminalFocus: false },
      }),
    );
  });
});

describe("recent view shortcuts", () => {
  it("resolves Ctrl+Tab while a terminal has focus", () => {
    assert.strictEqual(
      resolveShortcutCommand(event({ key: "Tab", ctrlKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
        context: { terminalFocus: true },
      }),
      "view.recent.next",
    );
    assert.strictEqual(
      resolveShortcutCommand(
        event({ key: "Tab", ctrlKey: true, shiftKey: true }),
        DEFAULT_BINDINGS,
        {
          platform: "MacIntel",
          context: { terminalFocus: true },
        },
      ),
      "view.recent.previous",
    );
  });
});

describe("thread jump shortcuts", () => {
  it("maps thread jump indices to commands and back", () => {
    assert.strictEqual(threadJumpCommandForIndex(0), "thread.jump.1");
    assert.strictEqual(threadJumpCommandForIndex(8), "thread.jump.9");
    assert.isNull(threadJumpCommandForIndex(9));
    assert.strictEqual(threadJumpIndexFromCommand("thread.jump.4"), 3);
    assert.isNull(threadJumpIndexFromCommand("chat.new"));
  });

  it("shows thread jump hints only while a numbered jump modifier combo is active", () => {
    assert.isTrue(
      shouldShowThreadJumpHints(event({ key: "Meta", metaKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
        context: { terminalWorkspaceOpen: false },
      }),
    );
    assert.isTrue(
      shouldShowThreadJumpHints(event({ key: "Control", ctrlKey: true }), DEFAULT_BINDINGS, {
        platform: "Linux",
        context: { terminalWorkspaceOpen: false },
      }),
    );
    assert.isTrue(
      shouldShowThreadJumpHints(event({ key: "Meta", metaKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
        context: { terminalWorkspaceOpen: true },
      }),
    );
  });
});

describe("copy thread id shortcut", () => {
  it("fires from a focused terminal on macOS but yields Ctrl+Shift+C to the shell elsewhere", () => {
    assert.strictEqual(
      resolveShortcutCommand(event({ key: "c", metaKey: true, shiftKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
        context: { terminalFocus: true },
      }),
      "thread.copyId",
    );
    assert.isNull(
      resolveShortcutCommand(event({ key: "c", ctrlKey: true, shiftKey: true }), DEFAULT_BINDINGS, {
        platform: "Linux",
        context: { terminalFocus: true },
      }),
    );
  });
});

describe("space jump shortcuts", () => {
  it("maps space jump commands to strip indices", () => {
    assert.strictEqual(spaceJumpIndexFromCommand("space.jump.1"), 0);
    assert.strictEqual(spaceJumpIndexFromCommand("space.jump.9"), 8);
    assert.isNull(spaceJumpIndexFromCommand("thread.jump.1"));
  });

  it("resolves space jumps from the built-in fallbacks when no config is present", () => {
    assert.strictEqual(
      resolveShortcutCommand(event({ code: "Digit1", key: "1", metaKey: true, altKey: true }), [], {
        platform: "MacIntel",
        context: { terminalFocus: false },
      }),
      "space.jump.1",
    );
  });

  it("fires from a focused terminal on macOS but yields to it elsewhere", () => {
    assert.strictEqual(
      resolveShortcutCommand(
        event({ code: "Digit3", key: "3", metaKey: true, altKey: true }),
        DEFAULT_BINDINGS,
        { platform: "MacIntel", context: { terminalFocus: true } },
      ),
      "space.jump.3",
    );
    assert.isNull(
      resolveShortcutCommand(
        event({ code: "Digit3", key: "3", ctrlKey: true, altKey: true }),
        DEFAULT_BINDINGS,
        { platform: "Linux", context: { terminalFocus: true } },
      ),
    );
  });
});

describe("thread tab shortcuts", () => {
  const resolve = (
    overrides: Partial<ShortcutEventLike>,
    platform: string,
    terminalFocus = false,
  ) => resolveShortcutCommand(event(overrides), [], { platform, context: { terminalFocus } });

  it("uses Cmd+Ctrl+Arrow on macOS, including from a focused terminal", () => {
    const right = { key: "ArrowRight", metaKey: true, ctrlKey: true };
    assert.strictEqual(resolve(right, "MacIntel"), "threadTab.next");
    assert.strictEqual(resolve(right, "MacIntel", true), "threadTab.next");
    assert.strictEqual(
      resolve({ key: "ArrowLeft", metaKey: true, ctrlKey: true }, "MacIntel"),
      "threadTab.previous",
    );
    // Cmd+Shift+Arrow stays text selection in the composer.
    assert.isNull(resolve({ key: "ArrowRight", metaKey: true, shiftKey: true }, "MacIntel"));
  });

  it("uses Ctrl+PageUp/PageDown elsewhere and yields them to a focused terminal", () => {
    assert.strictEqual(resolve({ key: "PageDown", ctrlKey: true }, "Linux"), "threadTab.next");
    assert.strictEqual(resolve({ key: "PageUp", ctrlKey: true }, "Win32"), "threadTab.previous");
    assert.isNull(resolve({ key: "PageDown", ctrlKey: true }, "Linux", true));
    // Ctrl+Alt+Arrow switches desktop workspaces on Linux.
    assert.isNull(resolve({ key: "ArrowRight", ctrlKey: true, altKey: true }, "Linux"));
  });
});

describe("workspace terminal tab shortcuts", () => {
  it("resolves the active workspace close shortcut only while the terminal workspace is open", () => {
    assert.strictEqual(
      resolveShortcutCommand(event({ key: "w", metaKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
        context: { terminalWorkspaceOpen: true, terminalFocus: true },
      }),
      "terminal.workspace.closeActive",
    );
    assert.isNull(
      resolveShortcutCommand(event({ key: "w", metaKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
        context: { terminalWorkspaceOpen: false, terminalFocus: false },
      }),
    );
  });

  it("keeps Ctrl for workspace tabs and Cmd for thread jumps on macOS", () => {
    assert.strictEqual(
      resolveShortcutCommand(event({ key: "1", ctrlKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
        context: { terminalWorkspaceOpen: true, terminalFocus: true },
      }),
      "terminal.workspace.terminal",
    );
    assert.strictEqual(
      resolveShortcutCommand(event({ key: "2", metaKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
        context: { terminalWorkspaceOpen: true, terminalFocus: true },
      }),
      "thread.jump.2",
    );
    assert.strictEqual(
      resolveShortcutCommand(event({ key: "2", ctrlKey: true }), DEFAULT_BINDINGS, {
        platform: "Linux",
        context: { terminalWorkspaceOpen: true },
      }),
      "terminal.workspace.chat",
    );
  });

  it("falls back to workspace defaults when the runtime config is missing them", () => {
    const legacyBindings = DEFAULT_BINDINGS.filter(
      (binding) =>
        binding.command !== "terminal.workspace.newFullWidth" &&
        binding.command !== "terminal.workspace.closeActive" &&
        binding.command !== "terminal.workspace.terminal" &&
        binding.command !== "terminal.workspace.chat",
    );

    assert.strictEqual(
      resolveShortcutCommand(event({ key: "j", metaKey: true, shiftKey: true }), legacyBindings, {
        platform: "MacIntel",
      }),
      "terminal.workspace.newFullWidth",
    );
    assert.strictEqual(
      resolveShortcutCommand(event({ key: "w", metaKey: true }), legacyBindings, {
        platform: "MacIntel",
        context: { terminalWorkspaceOpen: true },
      }),
      "terminal.workspace.closeActive",
    );
    assert.strictEqual(
      resolveShortcutCommand(event({ key: "1", ctrlKey: true }), legacyBindings, {
        platform: "MacIntel",
        context: { terminalWorkspaceOpen: true },
      }),
      "terminal.workspace.terminal",
    );
    assert.strictEqual(
      shortcutLabelForCommand(legacyBindings, "terminal.workspace.chat", "Linux"),
      "Ctrl+2",
    );
  });
});

describe("shortcutLabelForCommand", () => {
  it("returns the most recent binding label", () => {
    const bindings = compile([
      {
        shortcut: modShortcut("\\"),
        command: "terminal.workspace.terminal",
        whenAst: whenIdentifier("terminalFocus"),
      },
      {
        shortcut: modShortcut("\\", { shiftKey: true }),
        command: "terminal.workspace.terminal",
        whenAst: whenNot(whenIdentifier("terminalFocus")),
      },
    ]);
    assert.strictEqual(
      shortcutLabelForCommand(bindings, "terminal.workspace.terminal", "Linux"),
      "Ctrl+Shift+\\",
    );
  });
});

describe("chat/editor shortcuts", () => {
  it("resolves visible chat cycle shortcuts", () => {
    assert.strictEqual(
      resolveShortcutCommand(event({ key: "]", metaKey: true, shiftKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
        context: { terminalFocus: false },
      }),
      "chat.visible.next",
    );
    assert.strictEqual(
      resolveShortcutCommand(event({ key: "[", metaKey: true, shiftKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
        context: { terminalFocus: false },
      }),
      "chat.visible.previous",
    );
    assert.strictEqual(
      resolveShortcutCommand(event({ key: "}", metaKey: true, shiftKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
        context: { terminalFocus: false },
      }),
      "chat.visible.next",
    );
    assert.strictEqual(
      resolveShortcutCommand(event({ key: "{", metaKey: true, shiftKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
        context: { terminalFocus: false },
      }),
      "chat.visible.previous",
    );
    assert.isNull(
      resolveShortcutCommand(event({ key: "]", metaKey: true, shiftKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
        context: { terminalFocus: true },
      }),
    );
  });

  it("matches editor.file.save shortcut outside terminal focus", () => {
    assert.isTrue(
      isEditorFileSaveShortcut(event({ key: "s", metaKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
        context: { terminalFocus: false },
      }),
    );
    assert.isTrue(
      isEditorFileSaveShortcut(event({ key: "s", ctrlKey: true }), DEFAULT_BINDINGS, {
        platform: "Linux",
        context: { terminalFocus: false },
      }),
    );
    assert.isFalse(
      isEditorFileSaveShortcut(event({ key: "s", metaKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
        context: { terminalFocus: true },
      }),
    );
  });
});

describe("cross-command precedence", () => {
  it("uses when + order so a later focused rule overrides a global rule", () => {
    const keybindings = compile([
      { shortcut: modShortcut("n"), command: "chat.new" },
      {
        shortcut: modShortcut("n"),
        command: "terminal.new",
        whenAst: whenIdentifier("terminalFocus"),
      },
    ]);

    assert.equal(
      resolveShortcutCommand(event({ key: "n", metaKey: true }), keybindings, {
        platform: "MacIntel",
        context: { terminalFocus: true },
      }),
      "terminal.new",
    );
    assert.equal(
      resolveShortcutCommand(event({ key: "n", metaKey: true }), keybindings, {
        platform: "MacIntel",
        context: { terminalFocus: false },
      }),
      "chat.new",
    );
  });

  it("still lets a later global rule win when both rules match", () => {
    const keybindings = compile([
      {
        shortcut: modShortcut("n"),
        command: "terminal.new",
        whenAst: whenIdentifier("terminalFocus"),
      },
      { shortcut: modShortcut("n"), command: "chat.new" },
    ]);

    assert.equal(
      resolveShortcutCommand(event({ key: "n", ctrlKey: true }), keybindings, {
        platform: "Linux",
        context: { terminalFocus: true },
      }),
      "chat.new",
    );
  });
});

describe("resolveShortcutCommand", () => {
  it.each(["MacIntel", "Win32", "Linux"])(
    "cycles effort with Shift+Tab only in the composer on %s",
    (platform) => {
      const shortcutEvent = event({ key: "Tab", shiftKey: true });
      assert.strictEqual(
        resolveShortcutCommand(shortcutEvent, [], {
          platform,
          context: { composerFocus: true },
        }),
        "model.effort.next",
      );
      assert.isNull(
        resolveShortcutCommand(shortcutEvent, [], {
          platform,
          context: { composerFocus: false },
        }),
      );
      assert.isNull(
        resolveShortcutCommand(event({ key: "Tab" }), [], {
          platform,
          context: { composerFocus: true },
        }),
      );
      assert.strictEqual(
        resolveShortcutCommand(event({ key: "Tab", ctrlKey: true, shiftKey: true }), [], {
          platform,
          context: { composerFocus: true },
        }),
        "view.recent.previous",
      );
    },
  );

  it("lets a configured effort shortcut replace the Shift+Tab fallback", () => {
    const keybindings = compile([
      {
        command: "model.effort.next",
        shortcut: modShortcut("e", { altKey: true, modKey: false }),
        whenAst: whenIdentifier("composerFocus"),
      },
    ]);
    const options = { platform: "MacIntel", context: { composerFocus: true } };
    assert.strictEqual(
      resolveShortcutCommand(event({ key: "e", altKey: true }), keybindings, options),
      "model.effort.next",
    );
    assert.isNull(
      resolveShortcutCommand(event({ key: "Tab", shiftKey: true }), keybindings, options),
    );
  });

  it("resolves model cycle commands outside terminal focus", () => {
    assert.strictEqual(
      resolveShortcutCommand(event({ key: "]", altKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
        context: { terminalFocus: false },
      }),
      "model.next",
    );
    assert.strictEqual(
      resolveShortcutCommand(event({ key: "[", altKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
        context: { terminalFocus: false },
      }),
      "model.previous",
    );
    assert.strictEqual(
      resolveShortcutCommand(
        event({ key: "‘", code: "BracketRight", altKey: true }),
        DEFAULT_BINDINGS,
        {
          platform: "MacIntel",
          context: { terminalFocus: false },
        },
      ),
      "model.next",
    );
    assert.strictEqual(
      resolveShortcutCommand(event({ key: "]", altKey: true }), DEFAULT_BINDINGS, {
        platform: "MacIntel",
        context: { terminalFocus: true },
      }),
      null,
    );
  });

  it("returns dynamic script commands", () => {
    const keybindings = compile([{ shortcut: modShortcut("r"), command: "script.setup.run" }]);

    assert.strictEqual(
      resolveShortcutCommand(event({ key: "r", ctrlKey: true }), keybindings, {
        platform: "Linux",
      }),
      "script.setup.run",
    );
  });

  it("resolves the sidechat default by physical key and respects customization and terminal focus", () => {
    const optionS = event({ key: "ß", code: "KeyS", metaKey: true, altKey: true });
    assert.strictEqual(
      resolveShortcutCommand(optionS, [], {
        platform: "MacIntel",
        context: { terminalFocus: true },
      }),
      "sidechat.toggle",
    );
    assert.isNull(
      resolveShortcutCommand(event({ key: "s", ctrlKey: true, altKey: true }), [], {
        platform: "Linux",
        context: { terminalFocus: true },
      }),
    );
    const custom = compile([{ shortcut: modShortcut("y"), command: "sidechat.toggle" }]);
    assert.isNull(resolveShortcutCommand(optionS, custom, { platform: "MacIntel" }));
    assert.strictEqual(
      resolveShortcutCommand(event({ key: "y", metaKey: true }), custom, {
        platform: "MacIntel",
      }),
      "sidechat.toggle",
    );
  });

  it("falls back to creation defaults with the macOS terminal-focus escape hatch", () => {
    const legacyBindings = DEFAULT_BINDINGS.filter(
      (binding) => binding.command !== "chat.new" && binding.command !== "chat.newTerminal",
    );
    const macTerminal = { platform: "MacIntel", context: { terminalFocus: true } } as const;
    const linuxTerminal = { platform: "Linux", context: { terminalFocus: true } } as const;

    assert.strictEqual(
      resolveShortcutCommand(event({ key: "n", metaKey: true }), legacyBindings, macTerminal),
      "chat.new",
    );
    assert.strictEqual(
      resolveShortcutCommand(
        event({ key: "t", metaKey: true, shiftKey: true }),
        legacyBindings,
        macTerminal,
      ),
      "chat.newTerminal",
    );
    assert.isNull(
      resolveShortcutCommand(event({ key: "n", ctrlKey: true }), legacyBindings, linuxTerminal),
    );
  });
});

describe("formatShortcutLabel", () => {
  it("formats labels for plus key", () => {
    assert.strictEqual(formatShortcutLabel(modShortcut("+"), "MacIntel"), "⌘+");
    assert.strictEqual(formatShortcutLabel(modShortcut("+"), "Linux"), "Ctrl++");
  });
});

describe("isTerminalClearShortcut", () => {
  it("matches Ctrl+L", () => {
    assert.isTrue(isTerminalClearShortcut(event({ key: "l", ctrlKey: true })));
  });

  it("does not match Cmd+K (reserved for sidebar search)", () => {
    assert.isFalse(isTerminalClearShortcut(event({ key: "k", metaKey: true })));
  });

  it("ignores non-keydown events", () => {
    assert.isFalse(isTerminalClearShortcut(event({ type: "keyup", key: "l", ctrlKey: true })));
  });
});

describe("terminalNavigationShortcutData", () => {
  it("maps Option+Arrow on macOS to word movement", () => {
    assert.strictEqual(
      terminalNavigationShortcutData(event({ key: "ArrowLeft", altKey: true }), "MacIntel"),
      "\u001bb",
    );
    assert.strictEqual(
      terminalNavigationShortcutData(event({ key: "ArrowRight", altKey: true }), "MacIntel"),
      "\u001bf",
    );
  });

  it("maps Cmd+Arrow on macOS to line movement", () => {
    assert.strictEqual(
      terminalNavigationShortcutData(event({ key: "ArrowLeft", metaKey: true }), "MacIntel"),
      "\u0001",
    );
    assert.strictEqual(
      terminalNavigationShortcutData(event({ key: "ArrowRight", metaKey: true }), "MacIntel"),
      "\u0005",
    );
  });

  it("maps Ctrl+Arrow on non-macOS to word movement", () => {
    assert.strictEqual(
      terminalNavigationShortcutData(event({ key: "ArrowLeft", ctrlKey: true }), "Win32"),
      "\u001bb",
    );
    assert.strictEqual(
      terminalNavigationShortcutData(event({ key: "ArrowRight", ctrlKey: true }), "Linux"),
      "\u001bf",
    );
  });

  it("rejects unsupported combinations", () => {
    assert.isNull(
      terminalNavigationShortcutData(
        event({ key: "ArrowLeft", shiftKey: true, altKey: true }),
        "MacIntel",
      ),
    );
    assert.isNull(
      terminalNavigationShortcutData(event({ key: "ArrowLeft", metaKey: true }), "Linux"),
    );
    assert.isNull(terminalNavigationShortcutData(event({ key: "a", altKey: true }), "MacIntel"));
  });

  it("ignores non-keydown events", () => {
    assert.isNull(
      terminalNavigationShortcutData(
        event({ type: "keyup", key: "ArrowLeft", altKey: true }),
        "MacIntel",
      ),
    );
  });
});

describe("plus key parsing", () => {
  it("matches the plus key shortcut", () => {
    const plusBindings = compile([{ shortcut: modShortcut("+"), command: "terminal.toggle" }]);
    assert.equal(
      resolveShortcutCommand(event({ key: "+", metaKey: true }), plusBindings, {
        platform: "MacIntel",
      }),
      "terminal.toggle",
    );
    assert.equal(
      resolveShortcutCommand(event({ key: "+", ctrlKey: true }), plusBindings, {
        platform: "Linux",
      }),
      "terminal.toggle",
    );
  });
});

describe("unassigned commands", () => {
  // What the server sends for a command whose shortcut the user removed.
  const unassignedNewThread = compile([
    { shortcut: modShortcut("unassigned", { modKey: false }), command: "chat.new" },
  ]);

  it("does not bring the shipped shortcut back through the fallback table", () => {
    const options = {
      platform: "MacIntel",
      context: { terminalFocus: false, terminalOpen: false },
    };

    assert.equal(
      resolveShortcutCommand(event({ key: "n", metaKey: true }), [], options),
      "chat.new",
    );
    assert.isNull(
      resolveShortcutCommand(event({ key: "n", metaKey: true }), unassignedNewThread, options),
    );
  });

  it("has no shortcut to show", () => {
    assert.isNull(shortcutLabelForCommand(unassignedNewThread, "chat.new", "MacIntel"));
    assert.isNull(
      resolveKeybindingForCommand(unassignedNewThread, "chat.new", { platform: "MacIntel" }),
    );
  });
});

describe("option-modified keys", () => {
  it("matches Option+Space by its physical key on macOS", () => {
    const bindings = compile([
      { shortcut: modShortcut(" ", { modKey: false, altKey: true }), command: "terminal.toggle" },
    ]);

    assert.equal(
      resolveShortcutCommand(event({ key: "\u00a0", code: "Space", altKey: true }), bindings, {
        platform: "MacIntel",
      }),
      "terminal.toggle",
    );
  });
});

describe("suspendShortcutDispatch", () => {
  it("stops every shortcut from resolving until each holder resumes", () => {
    const pressed = event({ key: "j", metaKey: true });
    const options = { platform: "MacIntel" };
    const resumeFirst = suspendShortcutDispatch();
    const resumeSecond = suspendShortcutDispatch();

    assert.isNull(resolveShortcutCommand(pressed, DEFAULT_BINDINGS, options));
    assert.isFalse(
      isKeyboardShortcutsHelpShortcut(
        event({ metaKey: true, key: "/", code: "Slash" }),
        "MacIntel",
      ),
    );

    resumeFirst();
    // Resuming twice must not release the other holder's suspension.
    resumeFirst();
    assert.isNull(resolveShortcutCommand(pressed, DEFAULT_BINDINGS, options));

    resumeSecond();
    assert.equal(resolveShortcutCommand(pressed, DEFAULT_BINDINGS, options), "terminal.toggle");
  });
});
