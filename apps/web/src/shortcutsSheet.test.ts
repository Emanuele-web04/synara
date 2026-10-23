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
  it("lists active thread actions in the reference and shortcut editor", () => {
    const entries = buildShortcutSheetSections({
      keybindings: [],
      projectScripts: [],
      platform: "MacIntel",
      context: { terminalFocus: false, terminalOpen: false, terminalWorkspaceOpen: false },
    }).flatMap((section) => section.entries);
    for (const [command, label, shortcutLabel] of [
      ["thread.archive", "Archive thread", "⌥⇧⌘A"],
      ["thread.snooze", "Snooze thread", "⌥⇧⌘S"],
      ["thread.markUnread", "Mark thread unread", "⌥⇧⌘U"],
      ["chat.attention.next", "Next chat needing attention", "⌥⌘A"],
    ] as const) {
      expect(entries.find((entry) => entry.command === command)).toMatchObject({
        label,
        shortcutLabel,
      });
      expect(
        listShortcutEditorDefinitions().find((entry) => entry.commands.includes(command)),
      ).toMatchObject({ label });
    }
  });

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
        (entry) => entry.id === "search.files" && entry.shortcutLabel === "⌘P",
      ),
    ).toBe(true);
    expect(
      sections[0]?.entries.some(
        (entry) => entry.id === "search.content" && entry.shortcutLabel === "⇧⌘F",
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

  it("groups the shipped code editor shortcuts in their own section", () => {
    const sections = buildShortcutSheetSections({
      keybindings: [],
      projectScripts: [],
      platform: "MacIntel",
      context: { terminalFocus: false, terminalOpen: false, terminalWorkspaceOpen: false },
    });

    const editorSection = sections.find((section) => section.id === "code-editor");
    expect(editorSection?.title).toBe("Code editor");
    // Go to symbol, Go to line and Show problems ship unassigned, so they are not listed until bound.
    expect(
      editorSection?.entries.map((entry) => [entry.command, entry.label, entry.shortcutLabel]),
    ).toEqual([
      ["editor.commands", "Editor commands", "F1"],
      ["editor.rename", "Rename symbol", "F2"],
      ["editor.goToDefinition", "Go to definition", "F12"],
      ["editor.findReferences", "Find references", "⇧F12"],
      ["editor.quickFix", "Quick fix", "⌘."],
      ["editor.debug.start", "Start or continue debugging", "F5"],
      ["editor.debug.stop", "Stop debugging", "⇧F5"],
      ["editor.debug.toggleBreakpoint", "Toggle breakpoint", "F9"],
      ["editor.debug.stepOver", "Step over", "F10"],
      ["editor.debug.stepInto", "Step into", "F11"],
      ["editor.debug.stepOut", "Step out", "⇧F11"],
    ]);
    expect(
      sections
        .filter((section) => section.id !== "code-editor")
        .flatMap((section) => section.entries)
        .some((entry) => editorSection?.entries.some((editor) => editor.id === entry.id)),
    ).toBe(false);
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

  it("lists every active built-in command exactly once", () => {
    const listed = listShortcutEditorDefinitions().flatMap((definition) => definition.commands);

    expect(listed.toSorted()).toEqual(
      STATIC_KEYBINDING_COMMANDS.filter(
        (command) => !command.startsWith("terminal.split"),
      ).toSorted(),
    );
    expect(listed.some((command) => command.startsWith("terminal.split"))).toBe(false);
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
