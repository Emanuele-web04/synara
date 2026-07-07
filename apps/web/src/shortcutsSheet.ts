// FILE: shortcutsSheet.ts
// Purpose: Build the shortcut reference sections shown by the keyboard shortcuts sheet.
// Layer: UI helper
// Depends on: keybinding label resolution, project script command mapping, and platform helpers.

import type { KeybindingCommand, ResolvedKeybindingsConfig } from "@t3tools/contracts";
import { isMacPlatform } from "./lib/utils";
import { shortcutLabelForCommand } from "./keybindings";
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
  label: string;
  description: string;
  shortcutLabel: string;
  labelKey?: string;
  descriptionKey?: string;
  interpolation?: Record<string, string | number>;
}

export interface ShortcutSheetSection {
  id: string;
  title: string;
  description: string;
  tone?: "default" | "muted";
  titleKey?: string;
  descriptionKey?: string;
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
  labelKey: string;
  descriptionKey: string;
  interpolation?: Record<string, string | number>;
}

const AVAILABLE_NOW_DEFINITIONS: readonly ShortcutDefinition[] = [
  {
    command: "sidebar.addProject",
    label: "Add project",
    description: "Open the folder picker to import a local project into the sidebar.",
    labelKey: "shortcuts.sections.addProject",
    descriptionKey: "shortcuts.sections.addProjectDescription",
  },
  {
    command: "sidebar.search",
    label: "Search projects and threads",
    description: "Open the sidebar search palette from anywhere in the app.",
    labelKey: "shortcuts.sections.searchProjects",
    descriptionKey: "shortcuts.sections.searchProjectsDescription",
  },
  {
    command: "sidebar.importThread",
    label: "Import thread",
    description: "Bring an existing conversation into the current workspace.",
    labelKey: "shortcuts.sections.importThread",
    descriptionKey: "shortcuts.sections.importThreadDescription",
  },
  {
    command: "chat.new",
    label: "New thread",
    description: "Start a fresh thread in the current project, or the most recent one.",
    labelKey: "shortcuts.sections.newThread",
    descriptionKey: "shortcuts.sections.newThreadDescription",
  },
  {
    command: "chat.newLatestProject",
    label: "New thread in latest project",
    description: "Jump back into the most recently used project with a new thread.",
    labelKey: "shortcuts.sections.newThreadInLatestProject",
    descriptionKey: "shortcuts.sections.newThreadInLatestProjectDescription",
  },
  {
    command: ["chat.newChat", "chat.newLocal"],
    label: "New chat",
    description: "Open the empty chat landing view.",
    labelKey: "shortcuts.sections.newChat",
    descriptionKey: "shortcuts.sections.newChatDescription",
  },
  {
    command: "chat.newTerminal",
    label: "New terminal thread",
    description: "Create a thread that opens directly into terminal mode.",
    labelKey: "shortcuts.sections.newTerminalThread",
    descriptionKey: "shortcuts.sections.newTerminalThreadDescription",
  },
  {
    command: "chat.newClaude",
    label: "New Claude thread",
    description: "Start a fresh thread with Claude selected.",
    labelKey: "shortcuts.sections.newClaudeThread",
    descriptionKey: "shortcuts.sections.newClaudeThreadDescription",
  },
  {
    command: "chat.newCodex",
    label: "New Codex thread",
    description: "Start a fresh thread with Codex selected.",
    labelKey: "shortcuts.sections.newCodexThread",
    descriptionKey: "shortcuts.sections.newCodexThreadDescription",
  },
  {
    command: "chat.newCursor",
    label: "New Cursor thread",
    description: "Start a fresh thread with Cursor selected.",
    labelKey: "shortcuts.sections.newCursorThread",
    descriptionKey: "shortcuts.sections.newCursorThreadDescription",
  },
  {
    command: "chat.newGemini",
    label: "New Gemini thread",
    description: "Start a fresh thread with Gemini selected.",
    labelKey: "shortcuts.sections.newGeminiThread",
    descriptionKey: "shortcuts.sections.newGeminiThreadDescription",
  },
  {
    command: "chat.split",
    label: "Split chat",
    description: "Open the current conversation in a second pane.",
    labelKey: "shortcuts.sections.splitChat",
    descriptionKey: "shortcuts.sections.sections.splitChatDescription",
  },
  {
    command: "view.recent.previous",
    label: "Previous recent view",
    description: "Cycle backward through recently opened primary views.",
    labelKey: "shortcuts.sections.previousRecentView",
    descriptionKey: "shortcuts.sections.previousRecentViewDescription",
  },
  {
    command: "view.recent.next",
    label: "Next recent view",
    description: "Cycle forward through recently opened primary views.",
    labelKey: "shortcuts.sections.nextRecentView",
    descriptionKey: "shortcuts.sections.nextRecentViewDescription",
  },
  {
    command: "modelPicker.toggle",
    label: "Model picker",
    description: "Open the composer provider and model picker.",
    labelKey: "shortcuts.sections.modelPicker",
    descriptionKey: "shortcuts.sections.modelPickerDescription",
  },
  {
    command: "traitsPicker.toggle",
    label: "Reasoning picker",
    description: "Open the composer reasoning and trait controls.",
    labelKey: "shortcuts.sections.reasoningPicker",
    descriptionKey: "shortcuts.sections.reasoningPickerDescription",
  },
  {
    command: "composer.focus.toggle",
    label: "Focus composer",
    description: "Focus or blur the chat prompt composer.",
    labelKey: "shortcuts.sections.focusComposer",
    descriptionKey: "shortcuts.sections.focusComposerDescription",
  },
  {
    command: "terminal.toggle",
    label: "Toggle terminal",
    description: "Show or hide the terminal surface for the active thread.",
    labelKey: "shortcuts.sections.toggleTerminal",
    descriptionKey: "shortcuts.sections.toggleTerminalDescription",
  },
  {
    command: "diff.toggle",
    label: "Toggle diff",
    description: "Open or close the working tree diff panel.",
    labelKey: "shortcuts.sections.toggleDiff",
    descriptionKey: "shortcuts.sections.toggleDiffDescription",
  },
  {
    command: "browser.toggle",
    label: "Toggle browser",
    description: "Reveal the built-in browser panel for the active thread.",
    labelKey: "shortcuts.sections.toggleBrowser",
    descriptionKey: "shortcuts.sections.toggleBrowserDescription",
  },
  {
    command: "chat.visible.previous",
    label: "Previous visible thread",
    description: "Cycle to the previous thread that is currently visible in the sidebar.",
    labelKey: "shortcuts.sections.previousVisibleThread",
    descriptionKey: "shortcuts.sections.previousVisibleThreadDescription",
  },
  {
    command: "chat.visible.next",
    label: "Next visible thread",
    description: "Cycle to the next thread that is currently visible in the sidebar.",
    labelKey: "shortcuts.sections.nextVisibleThread",
    descriptionKey: "shortcuts.sections.nextVisibleThreadDescription",
  },
  {
    command: "editor.openFavorite",
    label: "Open in favorite editor",
    description: "Send the current thread or workspace target to your preferred editor.",
    labelKey: "shortcuts.sections.openInFavoriteEditor",
    descriptionKey: "shortcuts.sections.openInFavoriteEditorDescription",
  },
] as const;

const THREAD_JUMP_DEFINITIONS: readonly ShortcutDefinition[] = Array.from(
  { length: 9 },
  (_, index) => ({
    command: `thread.jump.${index + 1}` as KeybindingCommand,
    label: `Jump to visible thread {{number}}`,
    description: "Focus a visible thread directly from the sidebar number row.",
    labelKey: `shortcuts.sections.jumpToVisibleThread`,
    interpolation: { number: index + 1 },
    descriptionKey: `shortcuts.sections.jumpToVisibleThreadDescription`,
  }),
);

const WORKSPACE_DEFINITIONS: readonly ShortcutDefinition[] = [
  {
    command: "terminal.workspace.newFullWidth",
    label: "Open full-width terminal workspace",
    description: "Expand the active thread into the workspace terminal layout.",
    labelKey: "shortcuts.sections.openFullWidthTerminalWorkspace",
    descriptionKey: "shortcuts.sections.openFullWidthTerminalWorkspaceDescription",
  },
  {
    command: "terminal.workspace.terminal",
    label: "Focus terminal tab",
    description: "Switch the workspace to the terminal tab.",
    labelKey: "shortcuts.sections.focusTerminalTab",
    descriptionKey: "shortcuts.sections.focusTerminalTabDescription",
  },
  {
    command: "terminal.workspace.chat",
    label: "Focus chat tab",
    description: "Switch the workspace back to the chat tab.",
    labelKey: "shortcuts.sections.focusChatTab",
    descriptionKey: "shortcuts.sections.focusChatTabDescription",
  },
  {
    command: "terminal.workspace.closeActive",
    label: "Close active workspace panel",
    description: "Close the currently focused workspace panel or tab.",
    labelKey: "shortcuts.sections.closeActiveWorkspacePanel",
    descriptionKey: "shortcuts.sections.closeActiveWorkspacePanelDescription",
  },
] as const;

function modSlashLabel(platform: string): string {
  return isMacPlatform(platform) ? "⌘/" : "Ctrl+/";
}

function definitionToEntry(
  definition: ShortcutDefinition,
  keybindings: ResolvedKeybindingsConfig,
  platform: string,
  context: ShortcutSheetContext,
): ShortcutSheetEntry | null {
  const commands = Array.isArray(definition.command) ? definition.command : [definition.command];
  const shortcutLabel = commands.reduce<string | null>((resolved, command) => {
    if (resolved) return resolved;
    return shortcutLabelForCommand(keybindings, command, {
      platform,
      context,
    });
  }, null);
  if (!shortcutLabel) return null;
  return {
    id: commands[0] ?? definition.label,
    label: definition.label,
    description: definition.description,
    labelKey: definition.labelKey,
    descriptionKey: definition.descriptionKey,
    ...(definition.interpolation && { interpolation: definition.interpolation }),
    shortcutLabel,
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
      label: "Show keyboard shortcuts",
      labelKey: "shortcuts.sections.showKeyboardShortcuts",
      description: "Open this sheet from anywhere without leaving your current context.",
      descriptionKey: "shortcuts.sections.showKeyboardShortcutsDescription",
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
    {
      command: "sidebar.toggle",
      label: "Toggle sidebar",
      labelKey: "shortcuts.sections.toggleSidebar",
      description: "Collapse or reveal the sidebar shell.",
      descriptionKey: "shortcuts.sections.toggleSidebarDescription",
    },
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
    titleKey: "shortcuts.sections.availableNow.title",
    description: options.context.terminalWorkspaceOpen
      ? "These reflect the active workspace-terminal context."
      : "These reflect the current chat and sidebar context.",
    descriptionKey: "shortcuts.sections.availableNow.description",
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
      titleKey: options.context.terminalWorkspaceOpen
        ? "shortcuts.sections.outsideWorkspace"
        : "shortcuts.sections.inWorkspace",
      description: options.context.terminalWorkspaceOpen
        ? "Number-row jumps return when the terminal workspace is closed."
        : "These bindings take over when the terminal switches into workspace mode.",
      descriptionKey: options.context.terminalWorkspaceOpen
        ? "shortcuts.sections.outsideWorkspaceDescription"
        : "shortcuts.sections.inWorkspaceDescription",
      tone: "muted",
      entries: alternateEntries,
    });
  }

  const projectScriptEntries = options.projectScripts
    .map((script) => {
      const shortcutLabel = shortcutLabelForCommand(
        options.keybindings,
        commandForProjectScript(script.id),
        options.platform,
      );
      if (!shortcutLabel) return null;
      return {
        id: script.id,
        label: script.runOnWorktreeCreate ? `${script.name} setup script` : script.name,
        description: script.runOnWorktreeCreate
          ? "Run the project setup script directly from the keyboard."
          : "Run this project script without opening the scripts menu.",
        shortcutLabel,
      } satisfies ShortcutSheetEntry;
    })
    .filter((entry): entry is ShortcutSheetEntry => entry !== null);

  if (projectScriptEntries.length > 0) {
    sections.push({
      id: "project-scripts",
      title: "Project scripts",
      titleKey: "shortcuts.sections.projectScripts.title",
      description: "Custom shortcuts defined for the active project's scripts.",
      descriptionKey: "shortcuts.sections.projectScripts.description",
      entries: projectScriptEntries,
    });
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
