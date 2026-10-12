// FILE: shortcutsSheet.ts
// Purpose: Build the shortcut reference sections shown by the keyboard shortcuts sheet, and list
//          the commands the Settings shortcut editor can bind.
// Layer: UI helper
// Depends on: keybinding label resolution, project script command mapping, and platform helpers.

import {
  SPACE_JUMP_KEYBINDING_COMMANDS,
  STATIC_KEYBINDING_COMMANDS,
  THREAD_JUMP_KEYBINDING_COMMANDS,
  type KeybindingCommand,
  type ResolvedKeybindingRule,
  type ResolvedKeybindingsConfig,
} from "@synara/contracts";
import { isMacPlatform } from "./lib/utils";
import { formatShortcutLabel, resolveKeybindingForCommand } from "./keybindings";
import { commandForProjectScript } from "./projectScripts";
import type { ProjectScript } from "./types";

export interface ShortcutSheetContext {
  terminalFocus: boolean;
  terminalOpen: boolean;
  terminalWorkspaceOpen: boolean;
  [key: string]: boolean;
}

export interface ShortcutSheetEntry {
  id: string;
  command: KeybindingCommand | null;
  binding: ResolvedKeybindingRule | null;
  label: string;
  description: string;
  shortcutLabel: string;
}

export interface ShortcutSheetSection {
  id: string;
  title: string;
  description: string;
  tone?: "default" | "muted";
  entries: ShortcutSheetEntry[];
}

interface BuildShortcutSheetSectionsOptions {
  keybindings: ResolvedKeybindingsConfig;
  projectScripts: ReadonlyArray<ProjectScript>;
  platform: string;
  context: ShortcutSheetContext;
}

interface ShortcutDefinition {
  command: KeybindingCommand | readonly KeybindingCommand[];
  label: string;
  description: string;
}

const EFFORT_CYCLE_DEFINITION: ShortcutDefinition = {
  command: "model.effort.next",
  label: "Next model effort",
  description: "Cycle the model's available effort levels and briefly show the selected level.",
};

// Space jumps address the switcher's visual tab order, so slot 1 is always Void.
const SPACE_JUMP_DEFINITIONS: readonly ShortcutDefinition[] = Array.from(
  { length: 9 },
  (_, index) => ({
    command: `space.jump.${index + 1}` as KeybindingCommand,
    label: index === 0 ? "Jump to Void" : `Jump to space ${index + 1}`,
    description:
      index === 0
        ? "Switch straight to the Void tab of the space switcher."
        : "Switch straight to this tab of the space switcher.",
  }),
);

const AVAILABLE_NOW_DEFINITIONS: readonly ShortcutDefinition[] = [
  {
    command: "sidebar.addProject",
    label: "Add project",
    description: "Open the Create project dialog to import a local folder.",
  },
  {
    command: "sidebar.search",
    label: "Search projects and threads",
    description: "Open the sidebar search palette from anywhere in the app.",
  },
  {
    command: "sidebar.activity",
    label: "Toggle Activity",
    description: "Show or hide running tasks, completed work, and items that need attention.",
  },
  {
    command: "sidebar.importThread",
    label: "Import thread",
    description: "Bring an existing conversation into the current workspace.",
  },
  {
    command: "space.previous",
    label: "Previous space",
    description: "Switch to the previous project space and restore its last working context.",
  },
  {
    command: "space.next",
    label: "Next space",
    description: "Switch to the next project space and restore its last working context.",
  },
  ...SPACE_JUMP_DEFINITIONS,
  {
    command: "chat.new",
    label: "New thread",
    description: "Start a fresh thread in the current project, or the most recent one.",
  },
  {
    command: "chat.newLatestProject",
    label: "New thread in latest project",
    description: "Jump back into the most recently used project with a new thread.",
  },
  {
    command: ["chat.newChat", "chat.newLocal"],
    label: "New chat",
    description: "Open the empty chat landing view.",
  },
  {
    command: "chat.newTerminal",
    label: "New terminal thread",
    description: "Create a thread that opens directly into terminal mode.",
  },
  {
    command: "chat.newClaude",
    label: "New Claude thread",
    description: "Start a fresh thread with Claude selected.",
  },
  {
    command: "chat.newCodex",
    label: "New Codex thread",
    description: "Start a fresh thread with Codex selected.",
  },
  {
    command: "chat.newCursor",
    label: "New Cursor thread",
    description: "Start a fresh thread with Cursor selected.",
  },
  {
    command: "chat.split",
    label: "Split chat",
    description: "Open the current conversation in a second pane.",
  },
  {
    command: "view.recent.previous",
    label: "Previous recent view",
    description: "Cycle backward through recently opened primary views.",
  },
  {
    command: "view.recent.next",
    label: "Next recent view",
    description: "Cycle forward through recently opened primary views.",
  },
  {
    command: "modelPicker.toggle",
    label: "Model picker",
    description: "Open the composer provider and model picker.",
  },
  {
    command: "model.next",
    label: "Next model",
    description:
      "Cycle to the next model for the active provider (favorites first, then remaining models).",
  },
  {
    command: "model.previous",
    label: "Previous model",
    description:
      "Cycle to the previous model for the active provider (favorites first, then remaining models).",
  },
  EFFORT_CYCLE_DEFINITION,
  {
    command: "traitsPicker.toggle",
    label: "Reasoning picker",
    description: "Open the composer reasoning and trait controls.",
  },
  {
    command: "settings.usage",
    label: "Open usage settings",
    description: "Open Settings → Usage for provider quota and token totals.",
  },
  {
    command: "composer.focus.toggle",
    label: "Focus composer",
    description: "Focus or blur the chat prompt composer.",
  },
  {
    command: "chat.find",
    label: "Find in thread",
    description: "Search the current transcript and jump to each matching message.",
  },
  {
    command: "file.find",
    label: "Find in file",
    description: "Search the open file preview and jump between matching text.",
  },
  {
    command: "search.files",
    label: "Search files",
    description: "Open the workspace file-name search palette.",
  },
  {
    command: "search.content",
    label: "Search snippets",
    description: "Open the workspace content search palette across file snippets.",
  },
  {
    command: "terminal.toggle",
    label: "Toggle terminal",
    description: "Show or hide the terminal surface for the active thread.",
  },
  {
    command: "terminal.new",
    label: "Focus terminal",
    description: "Open or focus the terminal panel for this thread.",
  },
  {
    command: "terminal.close",
    label: "Close terminal",
    description: "Close the terminal session for this thread.",
  },
  {
    command: "diff.toggle",
    label: "Toggle diff",
    description: "Open or close the working tree diff panel.",
  },
  {
    command: "diff.change.next",
    label: "Next change",
    description: "Jump the diff viewport to the next changed file.",
  },
  {
    command: "diff.change.previous",
    label: "Previous change",
    description: "Jump the diff viewport to the previous changed file.",
  },
  {
    command: "sidechat.toggle",
    label: "Toggle side chat",
    description: "Open or hide a side chat beside the main conversation.",
  },
  {
    command: "browser.toggle",
    label: "Toggle browser",
    description: "Reveal the built-in browser panel for the active thread.",
  },
  {
    command: "device.toggle",
    label: "Toggle iOS Simulator",
    description: "Reveal the iOS Simulator panel for the active thread. macOS servers only.",
  },
  {
    command: "thread.copyId",
    label: "Copy thread ID",
    description: "Copy the active thread's ID to the clipboard.",
  },
  {
    command: "thread.archive",
    label: "Archive thread",
    description: "Archive the active chat, with the same confirmation and undo as the thread menu.",
  },
  {
    command: "thread.snooze",
    label: "Snooze thread",
    description: "Open the snooze date and time picker for the active chat.",
  },
  {
    command: "thread.markUnread",
    label: "Mark thread unread",
    description: "Mark the active chat unread and restore its dismissed notification.",
  },
  {
    command: "chat.visible.previous",
    label: "Previous visible thread",
    description: "Cycle to the previous thread that is currently visible in the sidebar.",
  },
  {
    command: "chat.visible.next",
    label: "Next visible thread",
    description: "Cycle to the next thread that is currently visible in the sidebar.",
  },
  {
    command: "threadTab.previous",
    label: "Previous tab",
    description: "Switch to the open thread tab on the left of the active one.",
  },
  {
    command: "threadTab.next",
    label: "Next tab",
    description: "Switch to the open thread tab on the right of the active one.",
  },
  {
    command: "editor.openFavorite",
    label: "Open in favorite editor",
    description: "Send the current thread or workspace target to your preferred editor.",
  },
  {
    command: "editor.file.save",
    label: "Save file",
    description: "Write the focused editor's unsaved changes back to disk.",
  },
  {
    command: "git.commitAndPush",
    label: "Commit and push",
    description: "Commit pending changes and push the active thread's repo.",
  },
] as const;

const THREAD_JUMP_DEFINITIONS: readonly ShortcutDefinition[] = Array.from(
  { length: 9 },
  (_, index) => ({
    command: `thread.jump.${index + 1}` as KeybindingCommand,
    label: `Jump to visible thread ${index + 1}`,
    description: "Focus a visible thread directly from the sidebar number row.",
  }),
);

const WORKSPACE_DEFINITIONS: readonly ShortcutDefinition[] = [
  {
    command: "terminal.workspace.newFullWidth",
    label: "Open full-width terminal workspace",
    description: "Expand the active thread into the workspace terminal layout.",
  },
  {
    command: "terminal.workspace.terminal",
    label: "Focus terminal tab",
    description: "Switch the workspace to the terminal tab.",
  },
  {
    command: "terminal.workspace.chat",
    label: "Focus chat tab",
    description: "Switch the workspace back to the chat tab.",
  },
  {
    command: "terminal.workspace.closeActive",
    label: "Close active workspace panel",
    description: "Close the currently focused workspace panel or tab.",
  },
] as const;

const SIDEBAR_TOGGLE_DEFINITION: ShortcutDefinition = {
  command: "sidebar.toggle",
  label: "Toggle sidebar",
  description: "Collapse or reveal the sidebar shell.",
};

export interface ShortcutEditorDefinition {
  id: string;
  label: string;
  description: string;
  /**
   * Commands the row edits together: one, the aliases of one action, or the nine
   * members of a numbered family in key order.
   */
  commands: readonly KeybindingCommand[];
  /** Set for a numbered family; one single-command definition per number key. */
  members?: readonly ShortcutEditorDefinition[];
}

function singleCommandEditorDefinitions(
  definitions: ReadonlyArray<ShortcutDefinition>,
): ShortcutEditorDefinition[] {
  return definitions.map((definition) => {
    const commands = Array.isArray(definition.command) ? definition.command : [definition.command];
    return {
      id: commands[0] ?? definition.label,
      label: definition.label,
      description: definition.description,
      commands,
    };
  });
}

/**
 * Every built-in command in the order Settings → Keybindings lists it, bound or not.
 * The two 1–9 families come back as one definition each so the editor can show and
 * rebind them as a single shortcut.
 */
export function listShortcutEditorDefinitions(): ShortcutEditorDefinition[] {
  const spaceJumpCommands = new Set<KeybindingCommand>(SPACE_JUMP_KEYBINDING_COMMANDS);
  const definitions: ShortcutEditorDefinition[] = [
    ...singleCommandEditorDefinitions([SIDEBAR_TOGGLE_DEFINITION]),
    ...singleCommandEditorDefinitions(
      AVAILABLE_NOW_DEFINITIONS.filter(
        (definition) =>
          Array.isArray(definition.command) ||
          !spaceJumpCommands.has(definition.command as KeybindingCommand),
      ),
    ),
    ...singleCommandEditorDefinitions(WORKSPACE_DEFINITIONS),
    {
      id: "thread.jump",
      label: "Jump to visible thread 1–9",
      description: "Focus a visible thread directly from the sidebar number row.",
      commands: THREAD_JUMP_KEYBINDING_COMMANDS,
      members: singleCommandEditorDefinitions(THREAD_JUMP_DEFINITIONS),
    },
    {
      id: "space.jump",
      label: "Jump to space 1–9",
      description: "Switch straight to a tab of the space switcher. 1 is always Void.",
      commands: SPACE_JUMP_KEYBINDING_COMMANDS,
      members: singleCommandEditorDefinitions(SPACE_JUMP_DEFINITIONS),
    },
  ];

  const covered = new Set(definitions.flatMap((definition) => definition.commands));
  for (const command of STATIC_KEYBINDING_COMMANDS) {
    if (covered.has(command) || command.startsWith("terminal.split")) continue;
    definitions.push({
      id: command,
      label: command,
      description: "Assign a shortcut to this built-in command.",
      commands: [command],
    });
  }
  return definitions;
}

function modSlashLabel(platform: string): string {
  return isMacPlatform(platform) ? "⌘/" : "Ctrl+/";
}

/** Human-readable sheet label for a keybinding command, e.g. `chat.new` → "New thread". */
export function shortcutSheetCommandLabel(command: KeybindingCommand): string | null {
  for (const definitions of [
    [SIDEBAR_TOGGLE_DEFINITION],
    AVAILABLE_NOW_DEFINITIONS,
    WORKSPACE_DEFINITIONS,
    THREAD_JUMP_DEFINITIONS,
  ]) {
    for (const definition of definitions) {
      const commands = Array.isArray(definition.command)
        ? definition.command
        : [definition.command];
      if (commands.includes(command)) return definition.label;
    }
  }
  return null;
}

function sheetLookupContextForCommand(
  command: KeybindingCommand,
  context: ShortcutSheetContext,
): ShortcutSheetContext {
  // Find commands share mod+F but are scoped to different focused surfaces.
  // Force the relevant focus flag so the sheet can list both bindings together.
  if (command === "file.find") {
    return { ...context, filePreviewFocus: true };
  }
  if (command === "chat.find") {
    return { ...context, filePreviewFocus: false, terminalFocus: false };
  }
  return context;
}

function definitionToEntry(
  definition: ShortcutDefinition,
  keybindings: ResolvedKeybindingsConfig,
  platform: string,
  context: ShortcutSheetContext,
): ShortcutSheetEntry | null {
  const commands = Array.isArray(definition.command) ? definition.command : [definition.command];
  const binding = commands.reduce<ResolvedKeybindingRule | null>(
    (resolved, command) =>
      resolved ??
      resolveKeybindingForCommand(keybindings, command, {
        platform,
        context: sheetLookupContextForCommand(command, context),
      }),
    null,
  );
  if (!binding) return null;
  return {
    id: binding.command,
    command: binding.command,
    binding,
    label: definition.label,
    description: definition.description,
    shortcutLabel: formatShortcutLabel(binding.shortcut, platform),
  };
}

function definitionsToEntries(
  definitions: ReadonlyArray<ShortcutDefinition>,
  keybindings: ResolvedKeybindingsConfig,
  platform: string,
  context: ShortcutSheetContext,
): ShortcutSheetEntry[] {
  return definitions
    .map((definition) => definitionToEntry(definition, keybindings, platform, context))
    .filter((entry): entry is ShortcutSheetEntry => entry !== null);
}

export function buildShortcutSheetSections(
  options: BuildShortcutSheetSectionsOptions,
): ShortcutSheetSection[] {
  const sections: ShortcutSheetSection[] = [];

  const currentEntries: ShortcutSheetEntry[] = [
    {
      id: "shortcuts.show",
      command: null,
      binding: null,
      label: "Show keybindings",
      description: "Open this sheet from anywhere without leaving your current context.",
      shortcutLabel: modSlashLabel(options.platform),
    },
    ...definitionsToEntries(
      AVAILABLE_NOW_DEFINITIONS,
      options.keybindings,
      options.platform,
      options.context,
    ),
  ];

  const sidebarToggle = definitionToEntry(
    SIDEBAR_TOGGLE_DEFINITION,
    options.keybindings,
    options.platform,
    options.context,
  );
  if (sidebarToggle) {
    currentEntries.splice(1, 0, sidebarToggle);
  }

  const currentNavigationEntries = options.context.terminalWorkspaceOpen
    ? definitionsToEntries(
        WORKSPACE_DEFINITIONS,
        options.keybindings,
        options.platform,
        options.context,
      )
    : definitionsToEntries(
        THREAD_JUMP_DEFINITIONS,
        options.keybindings,
        options.platform,
        options.context,
      );

  sections.push({
    id: "available-now",
    title: "Available now",
    description: options.context.terminalWorkspaceOpen
      ? "These reflect the active workspace-terminal context."
      : "These reflect the current chat and sidebar context.",
    entries: [...currentEntries, ...currentNavigationEntries],
  });

  const alternateContext: ShortcutSheetContext = options.context.terminalWorkspaceOpen
    ? { ...options.context, terminalWorkspaceOpen: false }
    : {
        ...options.context,
        terminalOpen: true,
        terminalWorkspaceOpen: true,
      };
  const alternateDefinitions = options.context.terminalWorkspaceOpen
    ? THREAD_JUMP_DEFINITIONS
    : WORKSPACE_DEFINITIONS;
  const alternateEntries = definitionsToEntries(
    alternateDefinitions,
    options.keybindings,
    options.platform,
    alternateContext,
  );
  if (alternateEntries.length > 0) {
    sections.push({
      id: "alternate-context",
      title: options.context.terminalWorkspaceOpen ? "Outside workspace mode" : "In workspace mode",
      description: options.context.terminalWorkspaceOpen
        ? "Number-row jumps return when the terminal workspace is closed."
        : "These bindings take over when the terminal switches into workspace mode.",
      tone: "muted",
      entries: alternateEntries,
    });
  }

  const projectScriptEntries = options.projectScripts
    .map<ShortcutSheetEntry | null>((script) => {
      const command = commandForProjectScript(script.id);
      const binding = resolveKeybindingForCommand(options.keybindings, command, {
        platform: options.platform,
      });
      if (!binding) return null;
      return {
        id: script.id,
        command,
        binding,
        label: script.runOnWorktreeCreate ? `${script.name} setup script` : script.name,
        description: script.runOnWorktreeCreate
          ? "Run the project setup script directly from the keyboard."
          : "Run this project script without opening the scripts menu.",
        shortcutLabel: formatShortcutLabel(binding.shortcut, options.platform),
      };
    })
    .filter((entry): entry is ShortcutSheetEntry => entry !== null);

  if (projectScriptEntries.length > 0) {
    sections.push({
      id: "project-scripts",
      title: "Project scripts",
      description: "Custom shortcuts defined for the active project's scripts.",
      entries: projectScriptEntries,
    });
  }

  if (!currentEntries.some((entry) => entry.command === EFFORT_CYCLE_DEFINITION.command)) {
    const composerEntries = definitionsToEntries(
      [EFFORT_CYCLE_DEFINITION],
      options.keybindings,
      options.platform,
      { ...options.context, composerFocus: true, terminalFocus: false },
    );
    if (composerEntries.length > 0) {
      sections.push({
        id: "composer-context",
        title: "In composer",
        description: "Available while the prompt composer or its effort picker has focus.",
        tone: "muted",
        entries: composerEntries,
      });
    }
  }

  return sections;
}

// Match a single entry against a free-text query on the human-readable label, the
// description, and the rendered shortcut label, so a user can search by action name
// ("terminal"), intent ("split"), or even the key combo itself ("⌘N" / "ctrl+n").
function shortcutSheetEntryMatchesQuery(entry: ShortcutSheetEntry, needle: string): boolean {
  return (
    entry.label.toLowerCase().includes(needle) ||
    entry.description.toLowerCase().includes(needle) ||
    entry.shortcutLabel.toLowerCase().includes(needle)
  );
}

// Filter each section's entries against a free-text query, dropping sections that end up
// empty. Shared by the keyboard-shortcuts dialog (Mod+/) and the settings reference panel
// so the two surfaces search identically.
export function filterShortcutSheetSections(
  sections: ShortcutSheetSection[],
  query: string,
): ShortcutSheetSection[] {
  const trimmed = query.trim().toLowerCase();
  if (trimmed.length === 0) return sections;
  return sections
    .map((section) => ({
      ...section,
      entries: section.entries.filter((entry) => shortcutSheetEntryMatchesQuery(entry, trimmed)),
    }))
    .filter((section) => section.entries.length > 0);
}
