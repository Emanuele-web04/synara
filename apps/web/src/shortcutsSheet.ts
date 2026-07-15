// FILE: shortcutsSheet.ts
// Purpose: Build the shortcut reference sections shown by the keyboard shortcuts sheet.
// Layer: UI helper
// Depends on: keybinding label resolution, project script command mapping, and platform helpers.

import type { KeybindingCommand, ResolvedKeybindingsConfig } from "@synara/contracts";
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

const SHORTCUT_TEXT_ZH: Readonly<Record<string, string>> = {
  "Add project": "添加项目",
  "Open the folder picker to import a local project into the sidebar.":
    "打开文件夹选择器，将本地项目导入侧边栏。",
  "Search projects and threads": "搜索项目和对话",
  "Open the sidebar search palette from anywhere in the app.": "在应用任意位置打开侧边栏搜索面板。",
  "Import thread": "导入对话",
  "Bring an existing conversation into the current workspace.": "将已有对话带入当前工作区。",
  "New thread": "新建对话",
  "Start a fresh thread in the current project, or the most recent one.":
    "在当前项目或最近使用的项目中新建对话。",
  "New thread in latest project": "在最近项目中新建对话",
  "Jump back into the most recently used project with a new thread.":
    "回到最近使用的项目并新建对话。",
  "New chat": "新建对话",
  "Open the empty chat landing view.": "打开空白对话首页。",
  "New terminal thread": "新建终端对话",
  "Create a thread that opens directly into terminal mode.": "创建直接进入终端模式的对话。",
  "New Claude thread": "新建 Claude 对话",
  "New Codex thread": "新建 Codex 对话",
  "New Cursor thread": "新建 Cursor 对话",
  "New Gemini thread": "新建 Gemini 对话",
  "Start a fresh thread with Claude selected.": "新建对话并选择 Claude。",
  "Start a fresh thread with Codex selected.": "新建对话并选择 Codex。",
  "Start a fresh thread with Cursor selected.": "新建对话并选择 Cursor。",
  "Start a fresh thread with Gemini selected.": "新建对话并选择 Gemini。",
  "Split chat": "拆分对话",
  "Open the current conversation in a second pane.": "在第二个面板中打开当前对话。",
  "Previous recent view": "上一个最近视图",
  "Next recent view": "下一个最近视图",
  "Cycle backward through recently opened primary views.": "向后切换最近打开的主视图。",
  "Cycle forward through recently opened primary views.": "向前切换最近打开的主视图。",
  "Model picker": "模型选择器",
  "Open the composer provider and model picker.": "打开输入框的提供商和模型选择器。",
  "Next model": "下一个模型",
  "Previous model": "上一个模型",
  "Cycle to the next model for the active provider (favorites first, then remaining models).":
    "切换到当前提供商的下一个模型（先收藏，再显示其余模型）。",
  "Cycle to the previous model for the active provider (favorites first, then remaining models).":
    "切换到当前提供商的上一个模型（先收藏，再显示其余模型）。",
  "Reasoning picker": "推理选择器",
  "Open the composer reasoning and trait controls.": "打开输入框的推理和特征控制项。",
  "Focus composer": "聚焦输入框",
  "Focus or blur the chat prompt composer.": "聚焦或取消聚焦对话输入框。",
  "Toggle terminal": "切换终端",
  "Show or hide the terminal surface for the active thread.": "显示或隐藏当前对话的终端界面。",
  "Toggle diff": "切换差异",
  "Open or close the working tree diff panel.": "打开或关闭工作树差异面板。",
  "Toggle browser": "切换浏览器",
  "Reveal the built-in browser panel for the active thread.": "显示当前对话的内置浏览器面板。",
  "Previous visible thread": "上一个可见对话",
  "Next visible thread": "下一个可见对话",
  "Cycle to the previous thread that is currently visible in the sidebar.":
    "切换到侧边栏中上一个可见对话。",
  "Cycle to the next thread that is currently visible in the sidebar.":
    "切换到侧边栏中下一个可见对话。",
  "Open in favorite editor": "在首选编辑器中打开",
  "Send the current thread or workspace target to your preferred editor.":
    "将当前对话或工作区目标发送到首选编辑器。",
  "Focus a visible thread directly from the sidebar number row.":
    "使用数字键直接聚焦侧边栏中的可见对话。",
  "Open full-width terminal workspace": "打开全宽终端工作区",
  "Expand the active thread into the workspace terminal layout.":
    "将当前对话展开为工作区终端布局。",
  "Focus terminal tab": "聚焦终端标签",
  "Switch the workspace to the terminal tab.": "将工作区切换到终端标签。",
  "Focus chat tab": "聚焦对话标签",
  "Switch the workspace back to the chat tab.": "将工作区切换回对话标签。",
  "Close active workspace panel": "关闭当前工作区面板",
  "Close the currently focused workspace panel or tab.": "关闭当前聚焦的工作区面板或标签。",
  "Show keyboard shortcuts": "显示键盘快捷键",
  "Open this sheet from anywhere without leaving your current context.":
    "在任何位置打开此面板，无需离开当前上下文。",
  "Toggle sidebar": "切换侧边栏",
  "Collapse or reveal the sidebar shell.": "收起或展开侧边栏。",
};

function localizeShortcutText(value: string): string {
  const jumpMatch = /^Jump to visible thread (\d+)$/.exec(value);
  if (jumpMatch) return `跳转到可见对话 ${jumpMatch[1]}`;
  return SHORTCUT_TEXT_ZH[value] ?? value;
}

const AVAILABLE_NOW_DEFINITIONS: readonly ShortcutDefinition[] = [
  {
    command: "sidebar.addProject",
    label: "Add project",
    description: "Open the folder picker to import a local project into the sidebar.",
  },
  {
    command: "sidebar.search",
    label: "Search projects and threads",
    description: "Open the sidebar search palette from anywhere in the app.",
  },
  {
    command: "sidebar.importThread",
    label: "Import thread",
    description: "Bring an existing conversation into the current workspace.",
  },
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
    command: "chat.newGemini",
    label: "New Gemini thread",
    description: "Start a fresh thread with Gemini selected.",
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
  {
    command: "traitsPicker.toggle",
    label: "Reasoning picker",
    description: "Open the composer reasoning and trait controls.",
  },
  {
    command: "composer.focus.toggle",
    label: "Focus composer",
    description: "Focus or blur the chat prompt composer.",
  },
  {
    command: "terminal.toggle",
    label: "Toggle terminal",
    description: "Show or hide the terminal surface for the active thread.",
  },
  {
    command: "diff.toggle",
    label: "Toggle diff",
    description: "Open or close the working tree diff panel.",
  },
  {
    command: "browser.toggle",
    label: "Toggle browser",
    description: "Reveal the built-in browser panel for the active thread.",
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
    command: "editor.openFavorite",
    label: "Open in favorite editor",
    description: "Send the current thread or workspace target to your preferred editor.",
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
    label: localizeShortcutText(definition.label),
    description: localizeShortcutText(definition.description),
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
    {
      command: "sidebar.toggle",
      label: "Toggle sidebar",
      description: "Collapse or reveal the sidebar shell.",
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
    title: "当前可用",
    description: options.context.terminalWorkspaceOpen
      ? "以下快捷键适用于当前工作区终端环境。"
      : "以下快捷键适用于当前对话和侧边栏环境。",
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
      title: options.context.terminalWorkspaceOpen ? "工作区模式之外" : "工作区模式中",
      description: options.context.terminalWorkspaceOpen
        ? "关闭终端工作区后，数字键跳转会恢复。"
        : "终端切换到工作区模式后，将使用以下快捷键。",
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
        label: script.runOnWorktreeCreate ? `${script.name} 设置脚本` : script.name,
        description: script.runOnWorktreeCreate
          ? "直接通过键盘运行项目设置脚本。"
          : "无需打开脚本菜单即可运行此项目脚本。",
        shortcutLabel,
      } satisfies ShortcutSheetEntry;
    })
    .filter((entry): entry is ShortcutSheetEntry => entry !== null);

  if (projectScriptEntries.length > 0) {
    sections.push({
      id: "project-scripts",
      title: "项目脚本",
      description: "为当前项目脚本定义的自定义快捷键。",
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
