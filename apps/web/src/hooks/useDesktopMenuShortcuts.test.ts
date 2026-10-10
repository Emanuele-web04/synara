import { describe, expect, it } from "vitest";

import {
  type KeybindingCommand,
  type KeybindingShortcut,
  type KeybindingWhenNode,
  type ResolvedKeybindingRule,
  UNASSIGNED_KEYBINDING_KEY,
} from "@synara/contracts";

import { resolveDesktopMenuShortcuts } from "./useDesktopMenuShortcuts";
import { resolveShortcutCommand } from "~/keybindings";

const MAC = "MacIntel";
const terminalFocus: KeybindingWhenNode = { type: "identifier", name: "terminalFocus" };
const notTerminalFocus: KeybindingWhenNode = { type: "not", node: terminalFocus };

function mod(key: string, overrides: Partial<KeybindingShortcut> = {}): KeybindingShortcut {
  return {
    key,
    modKey: true,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...overrides,
  };
}

function rule(
  command: KeybindingCommand,
  shortcut: KeybindingShortcut,
  whenAst?: KeybindingWhenNode,
): ResolvedKeybindingRule {
  return whenAst ? { command, shortcut, whenAst } : { command, shortcut };
}

const DEFAULT_MENU_RULES = [
  rule("sidebar.toggle", mod("b"), notTerminalFocus),
  rule("terminal.new", mod("t"), terminalFocus),
  rule("browser.toggle", mod("b", { shiftKey: true }), notTerminalFocus),
];

describe("resolveDesktopMenuShortcuts", () => {
  it("keeps conditional defaults out of the global native menu", () => {
    expect(resolveDesktopMenuShortcuts(DEFAULT_MENU_RULES, MAC)).toEqual({
      "terminal.new": null,
      "sidebar.toggle": null,
      "browser.toggle": null,
    });
  });

  it("follows a rebinding", () => {
    const keybindings = [...DEFAULT_MENU_RULES, rule("sidebar.toggle", mod("j"))];

    expect(resolveDesktopMenuShortcuts(keybindings, MAC)["sidebar.toggle"]).toEqual(mod("j"));
  });

  it("reports null for an unassigned command instead of restoring its default", () => {
    const keybindings = [
      rule("sidebar.toggle", mod(UNASSIGNED_KEYBINDING_KEY, { modKey: false })),
      rule("terminal.new", mod("t"), terminalFocus),
      rule("browser.toggle", mod("b", { shiftKey: true }), notTerminalFocus),
    ];

    expect(resolveDesktopMenuShortcuts(keybindings, MAC)["sidebar.toggle"]).toBeNull();
  });

  it("reports null when a later rule takes the command's chord", () => {
    const keybindings = [...DEFAULT_MENU_RULES, rule("chat.new", mod("b"), notTerminalFocus)];

    expect(resolveDesktopMenuShortcuts(keybindings, MAC)["sidebar.toggle"]).toBeNull();
  });

  it("copies only the shortcut fields the bridge accepts", () => {
    const keybindings = [
      rule("browser.toggle", { ...mod("o"), extra: true } as KeybindingShortcut),
    ];

    expect(resolveDesktopMenuShortcuts(keybindings, MAC)["browser.toggle"]).toEqual(mod("o"));
  });
  it.each(["Win32", "Linux x86_64", MAC])(
    "leaves a shared conditional chord to contextual dispatch on %s",
    (platform) => {
      const keybindings = [
        rule("chat.new", mod("n"), notTerminalFocus),
        rule("terminal.new", mod("n"), terminalFocus),
      ];
      const event = {
        key: "n",
        metaKey: platform === MAC,
        ctrlKey: platform !== MAC,
        shiftKey: false,
        altKey: false,
      };
      expect(
        resolveShortcutCommand(event, keybindings, {
          platform,
          context: { terminalFocus: false },
        }),
      ).toBe("chat.new");
      expect(
        resolveShortcutCommand(event, keybindings, {
          platform,
          context: { terminalFocus: true },
        }),
      ).toBe("terminal.new");
      expect(resolveDesktopMenuShortcuts(keybindings, platform)["terminal.new"]).toBeNull();
    },
  );
  it("does not promote a shared chord whose winning command changes with focus", () => {
    const keybindings = [
      rule("sidebar.toggle", mod("n")),
      rule("chat.new", mod("n"), terminalFocus),
    ];
    const event = { key: "n", ctrlKey: true, metaKey: false, shiftKey: false, altKey: false };
    expect(
      resolveShortcutCommand(event, keybindings, {
        platform: "Win32",
        context: { terminalFocus: true },
      }),
    ).toBe("chat.new");
    expect(resolveDesktopMenuShortcuts(keybindings, "Win32")["sidebar.toggle"]).toBeNull();
  });
});
