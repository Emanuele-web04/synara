import { describe, expect, it } from "vitest";

import { STATIC_KEYBINDING_COMMANDS } from "@synara/contracts";

import { buildShortcutSheetSections, listShortcutEditorDefinitions } from "./shortcutsSheet";
import type { ProjectScript } from "./types";

const PROJECT_SCRIPTS: ProjectScript[] = [
  {
    id: "lint",
    name: "Lint",
    command: "bun lint",
    icon: "lint",
    runOnWorktreeCreate: false,
  },
];

describe("buildShortcutSheetSections", () => {
  it("exposes the composer effort shortcut for discovery and customization", () => {
    const sections = buildShortcutSheetSections({
      keybindings: [],
      projectScripts: [],
      platform: "MacIntel",
      context: {
        terminalFocus: false,
        terminalOpen: false,
        terminalWorkspaceOpen: false,
      },
    });

    expect(sections[0]?.entries.some((entry) => entry.command === "model.effort.next")).toBe(false);
    const composerSection = sections.find((section) => section.id === "composer-context");
    expect(
      composerSection?.entries.find((entry) => entry.command === "model.effort.next"),
    ).toMatchObject({
      label: "Next model effort",
      shortcutLabel: "⇧Tab",
    });
    expect(
      listShortcutEditorDefinitions().find((entry) => entry.commands.includes("model.effort.next")),
    ).toMatchObject({
      label: "Next model effort",
    });
  });

  it("shows a global custom effort shortcut only once", () => {
    const sections = buildShortcutSheetSections({
      keybindings: [
        {
          command: "model.effort.next",
          shortcut: {
            key: "e",
            metaKey: false,
            ctrlKey: false,
            shiftKey: false,
            altKey: true,
            modKey: false,
          },
        },
      ],
      projectScripts: [],
      platform: "MacIntel",
      context: {
        terminalFocus: false,
        terminalOpen: false,
        terminalWorkspaceOpen: false,
      },
    });

    expect(
      sections
        .flatMap((section) => section.entries)
        .filter((entry) => entry.command === "model.effort.next"),
    ).toHaveLength(1);
  });

  it("includes the help shortcut and current thread jumps outside workspace mode", () => {
    const sections = buildShortcutSheetSections({
      keybindings: [
        {
          command: "script.lint.run",
          shortcut: {
            key: "r",
            modKey: true,
            metaKey: false,
            ctrlKey: false,
            shiftKey: false,
            altKey: false,
          },
        },
      ],
      projectScripts: PROJECT_SCRIPTS,
      platform: "MacIntel",
      context: {
        terminalFocus: false,
        terminalOpen: false,
        terminalWorkspaceOpen: false,
      },
    });

    expect(sections[0]?.entries.some((entry) => entry.id === "shortcuts.show")).toBe(true);
    expect(
      sections[0]?.entries.some(
        (entry) => entry.id === "thread.jump.1" && entry.shortcutLabel === "⌘1",
      ),
    ).toBe(true);
    expect(
      sections[0]?.entries.some(
        (entry) => entry.id === "composer.focus.toggle" && entry.shortcutLabel === "⌘L",
      ),
    ).toBe(true);
    expect(
      sections[0]?.entries.some(
        (entry) => entry.id === "chat.find" && entry.shortcutLabel === "⌘F",
      ),
    ).toBe(true);
    expect(
      sections[0]?.entries.some(
        (entry) => entry.id === "sidebar.activity" && entry.shortcutLabel === "⌥⌘U",
      ),
    ).toBe(true);
    expect(
      sections[0]?.entries.some(
        (entry) => entry.id === "editor.file.save" && entry.label === "Save file",
      ),
    ).toBe(true);
    expect(sections[1]?.title).toBe("In workspace mode");
    expect(sections[2]?.entries[0]?.shortcutLabel).toBe("⌘R");
  });

  it("separates macOS workspace tabs from thread jumps while the workspace is open", () => {
    const sections = buildShortcutSheetSections({
      keybindings: [],
      projectScripts: [],
      platform: "MacIntel",
      context: {
        terminalFocus: false,
        terminalOpen: true,
        terminalWorkspaceOpen: true,
      },
    });

    expect(
      sections[0]?.entries.some(
        (entry) => entry.id === "terminal.workspace.terminal" && entry.shortcutLabel === "⌃1",
      ),
    ).toBe(true);
    expect(sections[1]?.title).toBe("Outside workspace mode");
    expect(
      sections[1]?.entries.some(
        (entry) => entry.id === "thread.jump.1" && entry.shortcutLabel === "⌘1",
      ),
    ).toBe(true);
  });

  it("falls back to the legacy new-chat alias when needed", () => {
    const sections = buildShortcutSheetSections({
      keybindings: [
        {
          command: "chat.newLocal",
          shortcut: {
            key: "n",
            modKey: true,
            metaKey: false,
            ctrlKey: false,
            shiftKey: false,
            altKey: true,
          },
        },
      ],
      projectScripts: [],
      platform: "MacIntel",
      context: {
        terminalFocus: false,
        terminalOpen: false,
        terminalWorkspaceOpen: false,
      },
    });

    expect(
      sections[0]?.entries.some(
        (entry) => entry.label === "New chat" && entry.shortcutLabel === "⌥⌘N",
      ),
    ).toBe(true);
  });

  it("lists the sidebar toggle regardless of platform", () => {
    const sections = buildShortcutSheetSections({
      keybindings: [
        {
          command: "sidebar.toggle",
          shortcut: {
            key: "b",
            modKey: true,
            metaKey: false,
            ctrlKey: false,
            shiftKey: false,
            altKey: false,
          },
        },
      ],
      projectScripts: [],
      platform: "Linux",
      context: {
        terminalFocus: false,
        terminalOpen: false,
        terminalWorkspaceOpen: false,
      },
    });

    expect(sections[0]?.entries.some((entry) => entry.id === "sidebar.toggle")).toBe(true);
  });
});

describe("listShortcutEditorDefinitions", () => {
  it("shows a friendly label instead of the raw command id for every built-in command", () => {
    const unlabeledCommands = listShortcutEditorDefinitions()
      .filter(
        (definition) =>
          definition.label === definition.commands[0] ||
          definition.description === "Assign a shortcut to this built-in command.",
      )
      .flatMap((definition) => definition.commands);

    expect(unlabeledCommands).toEqual([]);
  });

  it("lists every built-in command exactly once", () => {
    const listed = listShortcutEditorDefinitions().flatMap((definition) => definition.commands);

    expect(listed.toSorted()).toEqual([...STATIC_KEYBINDING_COMMANDS].toSorted());
  });

  it("gives each numbered family one member per number key", () => {
    const families = listShortcutEditorDefinitions().filter((definition) => definition.members);

    expect(families.map((family) => family.id)).toEqual(["thread.jump", "space.jump"]);
    for (const family of families) {
      expect(family.members?.map((member) => member.commands)).toEqual(
        family.commands.map((command) => [command]),
      );
    }
  });
});
