/**
 * SidebarSearchPalette - Command-style palette for sidebar actions, threads, and projects.
 *
 * Keeps the sidebar search UX aligned with the shared command primitives so
 * keyboard navigation and shortcut labels behave like the rest of the app.
 */
import {
  BugReportIcon,
  CheckIcon,
  DeviceLaptopIcon,
  FolderAddIcon,
  FolderOpenFrontIcon,
  ImportThreadIcon,
  MoonIcon,
  NewThreadIcon,
  SettingsIcon,
  SidechatIcon,
  SunIcon,
  UsageGaugeIcon,
} from "~/lib/icons";
import { type FilesystemBrowseResult, type ProviderKind } from "@synara/contracts";
import { isGenericChatThreadTitle } from "@synara/shared/chatThreads";
import { Autocomplete as AutocompletePrimitive } from "@base-ui/react/autocomplete";
import { LuArrowLeft, LuCornerLeftUp } from "react-icons/lu";
import { type ComponentType, useEffect, useState, type KeyboardEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { FolderClosed } from "./FolderClosed";
import { ProviderIcon as SharedProviderIcon } from "./ProviderIcon";
import { readNativeApi } from "~/nativeApi";
import { cn, getNavigatorPlatform, isMacPlatform } from "~/lib/utils";
import { Kbd, KbdGroup } from "./ui/kbd";
import {
  appendBrowsePathSegment,
  canNavigateUp,
  getBrowseDirectoryPath,
  getBrowseLeafPathSegment,
  getBrowseParentPath,
  hasTrailingPathSeparator,
  isExplicitRelativeProjectPath,
  isFilesystemBrowseQuery,
  isUnsupportedWindowsProjectPath,
  normalizeProjectPathForDispatch,
} from "~/lib/projectPaths";

import {
  type SidebarSearchAction,
  type SidebarSearchProject,
  type SidebarSearchTheme,
  type SidebarSearchThread,
  matchSidebarSearchActions,
  matchSidebarSearchProjects,
  matchSidebarSearchThemes,
  matchSidebarSearchThreads,
} from "./SidebarSearchPalette.logic";
import { useTheme } from "../hooks/useTheme";
import { getAvailableCodeThemes, getCodeThemeSeed } from "../theme/theme.logic";
import {
  Command,
  CommandDialog,
  CommandDialogPopup,
  CommandGroup,
  CommandGroupLabel,
  CommandItem,
  CommandList,
  CommandStatus,
} from "./ui/command";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

// Palette skin — shared with the ⌘P workspace palette so both surfaces read as one
// menu: 44px bare input, settings-scale type, 30px squircle rows, single keycap pills.
const PALETTE_INPUT_CLASS =
  "font-system-ui h-11 w-full min-w-0 bg-transparent px-3.5 text-[length:var(--app-font-size-ui-lg,13px)] text-foreground outline-none placeholder:text-muted-foreground/70";
const PALETTE_GROUP_LABEL_CLASS =
  "flex items-center justify-between px-2.5 pt-2 pb-1 font-normal text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground/70";
const PALETTE_ITEM_CLASS =
  "palette-row min-h-[30px] cursor-pointer items-center gap-3 rounded-[20px] px-2.5 py-0 text-foreground data-highlighted:bg-zinc-500/8 data-highlighted:text-foreground sm:min-h-[30px] dark:data-highlighted:bg-zinc-400/10";
const PALETTE_ICON_CLASS = "size-3.5 shrink-0 text-muted-foreground";
const PALETTE_TEXT_CLASS = "min-w-0 flex-1 truncate text-[length:var(--app-font-size-ui,12px)]";
const PALETTE_META_CLASS =
  "max-w-[45%] shrink-0 truncate text-[length:var(--app-font-size-ui-meta,10px)] text-muted-foreground/70";
const PALETTE_KBD_CLASS =
  "h-[17px] min-w-0 rounded-md px-1.5 text-[length:var(--app-font-size-ui-xs,10px)] text-muted-foreground/80";
const PALETTE_STATUS_CLASS =
  "px-4 pt-1 pb-3 text-[length:var(--app-font-size-ui,12px)] text-muted-foreground/79";

// Actions that live under the "Settings" heading when the palette is idle.
const SETTINGS_ACTION_IDS: ReadonlySet<string> = new Set([
  "settings",
  "usage-settings",
  "feedback",
]);

export type SidebarSearchPaletteMode = "search" | "import";

interface SidebarSearchPaletteProps {
  open: boolean;
  mode: SidebarSearchPaletteMode;
  onModeChange: (mode: SidebarSearchPaletteMode) => void;
  onOpenChange: (open: boolean) => void;
  actions: readonly SidebarSearchAction[];
  projects: readonly SidebarSearchProject[];
  threads: readonly SidebarSearchThread[];
  onCreateChat: () => void;
  onCreateThread: () => void;
  onAddProjectPath: (path: string, options?: { createIfMissing?: boolean }) => Promise<void>;
  homeDir: string | null;
  onOpenSettings: () => void;
  onOpenFeedback: () => void;
  onOpenUsageSettings: () => void;
  onOpenProject: (projectId: string) => void;
  onOpenThread: (threadId: string) => void;
  importProviders: readonly ImportProviderKind[];
  onImportThread: (provider: ImportProviderKind, externalId: string) => Promise<void>;
}

export type ImportProviderKind = Extract<
  ProviderKind,
  "codex" | "claudeAgent" | "cursor" | "opencode"
>;

function actionHandler(
  actionId: string,
  props: Pick<
    SidebarSearchPaletteProps,
    "onCreateChat" | "onCreateThread" | "onOpenFeedback" | "onOpenSettings" | "onOpenUsageSettings"
  >,
): (() => void) | null {
  switch (actionId) {
    case "new-chat":
      return props.onCreateChat;
    case "new-thread":
      return props.onCreateThread;
    case "settings":
      return props.onOpenSettings;
    case "feedback":
      return props.onOpenFeedback;
    case "usage-settings":
      return props.onOpenUsageSettings;
    default:
      return null;
  }
}

type IconComponent = ComponentType<{ className?: string }>;

const ACTION_ICONS: Record<string, IconComponent> = {
  "new-chat": SidechatIcon,
  "new-thread": NewThreadIcon,
  "add-project": FolderAddIcon,
  "import-thread": ImportThreadIcon,
  feedback: BugReportIcon,
  settings: SettingsIcon,
  "usage-settings": UsageGaugeIcon,
};

const BROWSE_STALE_TIME_MS = 10_000;

const EMPTY_BROWSE_ENTRIES: FilesystemBrowseResult["entries"] = [];

function expandHomeInPath(value: string, homeDir: string | null): string {
  if (!homeDir) return value;
  if (value === "~") return homeDir;
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return `${homeDir}${value.slice(1)}`;
  }
  return value;
}

type ThemeCommandItem = {
  description: string;
  id: string;
  isActive: boolean;
  label: string;
  mode: "system" | "light" | "dark";
};

function queryTokens(query: string): string[] {
  return query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((token) => token.length > 0);
}

function hasTokenEqual(query: string, token: string): boolean {
  return queryTokens(query).includes(token);
}

function createThemeCommandItem(
  mode: ThemeCommandItem["mode"],
  activeMode: ThemeCommandItem["mode"],
): ThemeCommandItem {
  if (mode === "system") {
    return {
      id: "theme-command:system",
      label: "Switch to system theme",
      description: "Match your OS appearance setting.",
      mode,
      isActive: activeMode === mode,
    };
  }

  return {
    id: `theme-command:${mode}`,
    label: `Switch to ${mode} theme`,
    description: mode === "light" ? "Always use the light theme." : "Always use the dark theme.",
    mode,
    isActive: activeMode === mode,
  };
}

// Treat any token of length >= 2 that is a prefix of `keyword` as a match,
// so typing `th` / `the` already starts surfacing theme actions.
function hasTokenPrefixOf(query: string, keyword: string): boolean {
  return queryTokens(query).some((token) => token.length >= 2 && keyword.startsWith(token));
}

// Keep the palette quiet by default, then expose focused appearance actions
// once the user is clearly asking about theme modes.
function buildThemeCommandItems(input: {
  query: string;
  resolvedTheme: "light" | "dark";
  theme: "system" | "light" | "dark";
}): ThemeCommandItem[] {
  const normalizedQuery = input.query.trim().toLowerCase();
  if (!normalizedQuery) {
    return [];
  }

  if (
    hasTokenEqual(normalizedQuery, "system") ||
    hasTokenEqual(normalizedQuery, "auto") ||
    hasTokenEqual(normalizedQuery, "automatic") ||
    hasTokenEqual(normalizedQuery, "os")
  ) {
    return [createThemeCommandItem("system", input.theme)];
  }

  if (hasTokenEqual(normalizedQuery, "light")) {
    return [
      createThemeCommandItem("light", input.theme),
      createThemeCommandItem("system", input.theme),
    ];
  }

  if (hasTokenEqual(normalizedQuery, "dark")) {
    return [
      createThemeCommandItem("dark", input.theme),
      createThemeCommandItem("system", input.theme),
    ];
  }

  if (
    hasTokenPrefixOf(normalizedQuery, "theme") ||
    hasTokenPrefixOf(normalizedQuery, "appearance")
  ) {
    const nextMode = input.resolvedTheme === "dark" ? "light" : "dark";
    return [
      createThemeCommandItem(nextMode, input.theme),
      createThemeCommandItem("system", input.theme),
    ];
  }

  return [];
}

function CodeThemeBadge(props: { accent: string; background: string; foreground: string }) {
  return (
    <span
      aria-hidden="true"
      className="inline-flex size-6 shrink-0 items-center justify-center rounded-full border font-medium text-[10px] leading-none tracking-[-0.01em]"
      style={{
        backgroundColor: props.background,
        borderColor: `${props.foreground}26`,
        color: props.accent,
      }}
    >
      Aa
    </span>
  );
}

const THEME_MODE_ICONS: Record<"system" | "light" | "dark", IconComponent> = {
  system: DeviceLaptopIcon,
  light: SunIcon,
  dark: MoonIcon,
};

function threadMatchLabel(input: {
  matchKind: "message" | "project" | "title";
  messageMatchCount: number;
}): string | null {
  if (input.matchKind === "message") {
    return input.messageMatchCount > 1 ? `${input.messageMatchCount} chat hits` : "Chat match";
  }
  if (input.matchKind === "project") {
    return "Project match";
  }
  return null;
}

function tokenizeHighlightQuery(query: string): string[] {
  const tokens = query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((token) => token.length > 0)
    .filter((token, index, allTokens) => allTokens.indexOf(token) === index);
  return tokens.toSorted((left, right) => right.length - left.length);
}

function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function HighlightedText(props: { text: string; query: string; className?: string }) {
  const tokens = tokenizeHighlightQuery(props.query);
  let segments: Array<{ key: string; text: string; highlighted: boolean }>;
  if (tokens.length === 0) {
    segments = [{ key: "full", text: props.text, highlighted: false }];
  } else {
    const pattern = new RegExp(`(${tokens.map(escapeRegExp).join("|")})`, "gi");
    const parts = props.text.split(pattern).filter((part) => part.length > 0);
    let offset = 0;
    segments = parts.map((part) => {
      const segment = {
        key: `${offset}-${part.length}`,
        text: part,
        highlighted: tokens.some((token) => token === part.toLowerCase()),
      };
      offset += part.length;
      return segment;
    });
  }

  return (
    <span className={props.className}>
      {segments.map((segment) =>
        segment.highlighted ? (
          <mark
            key={segment.key}
            className="rounded-[3px] bg-amber-200/80 px-[1px] text-current dark:bg-amber-300/25"
          >
            {segment.text}
          </mark>
        ) : (
          <span key={segment.key}>{segment.text}</span>
        ),
      )}
    </span>
  );
}

export function SidebarSearchPalette(props: SidebarSearchPaletteProps) {
  const { activeTheme, resolvedTheme, setCodeThemeId, setTheme, theme } = useTheme();
  const [query, setQuery] = useState("");
  const [highlightedItemValue, setHighlightedItemValue] = useState<string | null>(null);
  const [importProviderState, setImportProvider] = useState<ImportProviderKind>(
    props.importProviders[0] ?? "codex",
  );
  const [importId, setImportId] = useState("");
  const [importError, setImportError] = useState<string | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  // Derived fallback (no syncing effect): an unavailable provider renders as
  // the first available one, and the user's pick resurfaces if it comes back.
  const importProvider = props.importProviders.includes(importProviderState)
    ? importProviderState
    : (props.importProviders[0] ?? "codex");
  // Error keyed to the query it was produced for: editing the query derives
  // straight back to null with no state-clearing effect.
  const [addProjectErrorState, setAddProjectErrorState] = useState<{
    query: string;
    message: string;
  } | null>(null);
  const [isAddingProject, setIsAddingProject] = useState(false);
  const addProjectError =
    addProjectErrorState !== null && addProjectErrorState.query === query
      ? addProjectErrorState.message
      : null;
  const setAddProjectError = (message: string | null) =>
    setAddProjectErrorState(message === null ? null : { query, message });

  useEffect(() => {
    if (props.open) {
      return;
    }
    // Timeout-0 keeps the reset writes asynchronous (the palette is already
    // hidden), which keeps this component eligible for React Compiler.
    const timeoutId = window.setTimeout(() => {
      setQuery("");
      setHighlightedItemValue(null);
      setImportProvider(props.importProviders[0] ?? "codex");
      setImportId("");
      setImportError(null);
      setIsImporting(false);
      setAddProjectError(null);
      setIsAddingProject(false);
    }, 0);
    return () => window.clearTimeout(timeoutId);
  }, [props.importProviders, props.open]);

  const platform = getNavigatorPlatform();
  const trimmedQuery = query.trim();
  const unsupportedWindowsPath = isUnsupportedWindowsProjectPath(trimmedQuery, platform);
  const isBrowsing = trimmedQuery.length > 0 && isFilesystemBrowseQuery(trimmedQuery, platform);
  const canBrowse = isBrowsing && !unsupportedWindowsPath;
  const browseDirectoryPath = canBrowse ? getBrowseDirectoryPath(query) : "";
  const leafSegment =
    canBrowse && !hasTrailingPathSeparator(query) ? getBrowseLeafPathSegment(query) : "";
  const expandedBrowsePath = canBrowse ? expandHomeInPath(browseDirectoryPath, props.homeDir) : "";

  const { data: browseResult, isFetching: isBrowseFetching } =
    useQuery<FilesystemBrowseResult | null>({
      queryKey: ["sidebar-palette-browse", expandedBrowsePath],
      queryFn: async () => {
        if (!canBrowse || expandedBrowsePath.length === 0) return null;
        const api = readNativeApi();
        if (!api) return null;
        return await api.filesystem.browse({ partialPath: expandedBrowsePath });
      },
      enabled: canBrowse && expandedBrowsePath.length > 0,
      staleTime: BROWSE_STALE_TIME_MS,
    });

  const browseEntries = browseResult?.entries ?? EMPTY_BROWSE_ENTRIES;
  const lowerFilter = leafSegment.toLowerCase();
  const showHidden = leafSegment.startsWith(".");
  const filteredBrowseEntries = browseEntries.filter(
    (entry) =>
      entry.name.toLowerCase().startsWith(lowerFilter) &&
      (showHidden || !entry.name.startsWith(".")),
  );

  const exactBrowseEntry =
    leafSegment.length === 0
      ? null
      : (filteredBrowseEntries.find((entry) => entry.name === leafSegment) ?? null);

  const browseParentPath = canBrowse ? getBrowseParentPath(query) : null;
  const canBrowseUp = canBrowse && canNavigateUp(query);

  const matchedActions = isBrowsing ? [] : matchSidebarSearchActions(props.actions, query);
  // Idle: "Quick actions" then "Settings", like the ⌘P menu. Searching: one flat
  // "Actions" group so a query never has to guess which heading a hit sits under.
  const quickActions = query
    ? matchedActions
    : matchedActions.filter((action) => !SETTINGS_ACTION_IDS.has(action.id));
  const settingsActions = query
    ? []
    : matchedActions.filter((action) => SETTINGS_ACTION_IDS.has(action.id));
  const themeCommandItems = buildThemeCommandItems({
    query,
    resolvedTheme,
    theme,
  });
  const currentCodeThemeItems: SidebarSearchTheme[] = getAvailableCodeThemes(resolvedTheme).map(
    (option) => ({
      id: `theme-code:${resolvedTheme}:${option.id}`,
      type: "code-theme",
      label: option.label,
      description: `Apply to the current ${resolvedTheme} theme slot.`,
      keywords: ["appearance", "theme", resolvedTheme, option.id],
      codeThemeId: option.id,
      variant: resolvedTheme,
      isActive: activeTheme.codeThemeId === option.id,
    }),
  );
  const matchedCurrentThemes =
    isBrowsing || query.trim().length === 0
      ? []
      : matchSidebarSearchThemes(currentCodeThemeItems, query);
  const showThemeSection =
    !isBrowsing &&
    query.trim().length > 0 &&
    (themeCommandItems.length > 0 || matchedCurrentThemes.length > 0);
  const matchedProjects = isBrowsing ? [] : matchSidebarSearchProjects(props.projects, query);
  const matchedThreads = isBrowsing ? [] : matchSidebarSearchThreads(props.threads, query);
  const hasSearchResults =
    matchedActions.length > 0 ||
    themeCommandItems.length > 0 ||
    matchedCurrentThemes.length > 0 ||
    matchedProjects.length > 0 ||
    matchedThreads.length > 0;
  const importFieldLabel = importProvider === "codex" ? "Thread ID" : "Session ID";
  const importPlaceholder =
    importProvider === "claudeAgent"
      ? "Paste a Claude session id"
      : importProvider === "cursor"
        ? "Paste a Cursor session id"
        : importProvider === "opencode"
          ? "Paste an OpenCode session id"
          : "Paste a Codex thread id";

  const hasHighlightedFolderItem =
    highlightedItemValue !== null && highlightedItemValue.startsWith("folder:");
  const hasHighlightedBrowseItem =
    hasHighlightedFolderItem || highlightedItemValue === "__browse_up__";

  const highlightedFolderPath = hasHighlightedFolderItem
    ? (highlightedItemValue?.slice("folder:".length) ?? null)
    : null;

  const willCreateMissingFolder =
    canBrowse &&
    !hasHighlightedFolderItem &&
    trimmedQuery.length > 0 &&
    !hasTrailingPathSeparator(query) &&
    exactBrowseEntry === null &&
    !isBrowseFetching;

  const browseSubmitLabel = willCreateMissingFolder ? "Create & Add" : "Add";

  const resolveBrowseSubmitPath = (): string => {
    if (highlightedFolderPath) {
      return normalizeProjectPathForDispatch(highlightedFolderPath);
    }
    const raw = hasTrailingPathSeparator(query)
      ? (browseResult?.parentPath ?? expandHomeInPath(trimmedQuery, props.homeDir))
      : (exactBrowseEntry?.fullPath ?? expandHomeInPath(trimmedQuery, props.homeDir));
    return normalizeProjectPathForDispatch(raw);
  };

  const submitBrowsePath = async () => {
    if (isAddingProject) return;
    if (trimmedQuery.length === 0 && !highlightedFolderPath) {
      setAddProjectError("Enter a folder path.");
      return;
    }
    if (unsupportedWindowsPath) {
      setAddProjectError("Windows paths are not supported on this platform.");
      return;
    }
    if (!highlightedFolderPath && isExplicitRelativeProjectPath(trimmedQuery)) {
      setAddProjectError(
        "Relative paths are not supported. Use an absolute path or start with ~/.",
      );
      return;
    }
    setIsAddingProject(true);
    setAddProjectError(null);
    // Promise chain instead of async/try-finally: React Compiler does not yet
    // support try/finally, and it would skip optimizing this whole component.
    void Promise.resolve(
      props.onAddProjectPath(resolveBrowseSubmitPath(), {
        createIfMissing: willCreateMissingFolder,
      }),
    )
      .then(() => {
        props.onOpenChange(false);
      })
      .catch((cause: unknown) => {
        setAddProjectError(cause instanceof Error ? cause.message : "Failed to add project.");
      })
      .finally(() => {
        setIsAddingProject(false);
      });
  };

  const isMac = isMacPlatform(platform);
  const submitModifierLabel = isMac ? "⌘" : "Ctrl";

  const handleBrowseInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (!isBrowsing) return;
    const isModifierPressed = isMac ? event.metaKey : event.ctrlKey;
    if (
      event.key === "Enter" &&
      (!hasHighlightedBrowseItem || (isModifierPressed && hasHighlightedFolderItem))
    ) {
      event.preventDefault();
      void submitBrowsePath();
      return;
    }
    if (
      event.key === "Backspace" &&
      hasTrailingPathSeparator(query) &&
      browseParentPath &&
      event.currentTarget.selectionStart === query.length &&
      event.currentTarget.selectionEnd === query.length
    ) {
      event.preventDefault();
      setQuery(browseParentPath);
    }
  };

  const submitImport = () => {
    const normalizedImportId = importId.trim();
    if (!normalizedImportId || isImporting) {
      return;
    }
    setImportError(null);
    setIsImporting(true);
    void Promise.resolve(props.onImportThread(importProvider, normalizedImportId))
      .then(() => {
        props.onOpenChange(false);
      })
      .catch((error: unknown) => {
        setImportError(error instanceof Error ? error.message : "Failed to import thread.");
      })
      .finally(() => {
        setIsImporting(false);
      });
  };

  const renderActionItem = (action: SidebarSearchAction) => {
    const onSelect = action.run ?? actionHandler(action.id, props);
    const Icon = action.icon ?? ACTION_ICONS[action.id];
    return (
      <CommandItem
        key={action.id}
        value={`action:${action.id}`}
        className={PALETTE_ITEM_CLASS}
        onMouseDown={(event) => {
          event.preventDefault();
        }}
        onClick={() => {
          if (action.id === "import-thread") {
            setImportError(null);
            setImportId("");
            setImportProvider(props.importProviders[0] ?? "codex");
            props.onModeChange("import");
            return;
          }
          if (!onSelect) return;
          props.onOpenChange(false);
          onSelect();
        }}
      >
        {Icon ? (
          <Icon className={PALETTE_ICON_CLASS} />
        ) : (
          <span className="size-3.5 shrink-0" aria-hidden="true" />
        )}
        <span className={PALETTE_TEXT_CLASS}>{action.label}</span>
        {action.shortcutLabel ? (
          <Kbd className={PALETTE_KBD_CLASS}>{action.shortcutLabel}</Kbd>
        ) : null}
      </CommandItem>
    );
  };

  return (
    <CommandDialog open={props.open} onOpenChange={props.onOpenChange}>
      <CommandDialogPopup className="max-w-lg rounded-3xl border-transparent before:rounded-[calc(var(--radius-3xl)-1px)] before:shadow-none dark:before:shadow-none">
        {props.mode === "import" ? (
          <div className="flex flex-col overflow-hidden">
            <div className="border-b border-border/70 px-4 py-3">
              <div className="flex items-start gap-3">
                <Button
                  size="icon"
                  variant="ghost"
                  className="-ml-1 mt-[-2px] size-8 shrink-0"
                  onClick={() => {
                    setImportError(null);
                    props.onModeChange("search");
                  }}
                >
                  <LuArrowLeft className="size-4" />
                </Button>
                <div>
                  <p className="text-sm font-medium text-foreground">Import thread from provider</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Create a local app thread and resume it from an existing provider id.
                  </p>
                </div>
              </div>
            </div>
            <div className="space-y-4 px-4 py-4">
              <div className="space-y-2">
                <p className="text-xs font-medium text-muted-foreground">Provider</p>
                <div className="flex gap-2">
                  {props.importProviders.map((provider) => (
                    <Button
                      key={provider}
                      className={
                        importProvider === provider
                          ? "flex-1 justify-start border-border bg-muted text-foreground hover:bg-muted/80"
                          : "flex-1 justify-start"
                      }
                      variant="outline"
                      onClick={() => setImportProvider(provider)}
                    >
                      <SharedProviderIcon provider={provider} className="size-[15px]" />
                      {provider === "claudeAgent"
                        ? "Claude"
                        : provider === "cursor"
                          ? "Cursor"
                          : provider === "opencode"
                            ? "OpenCode"
                            : "Codex"}
                    </Button>
                  ))}
                </div>
                {props.importProviders.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    No connected providers expose chat import in this build.
                  </p>
                ) : null}
              </div>
              <div className="space-y-2">
                <p className="text-xs font-medium text-muted-foreground">{importFieldLabel}</p>
                <Input
                  autoFocus
                  nativeInput
                  placeholder={importPlaceholder}
                  value={importId}
                  disabled={props.importProviders.length === 0}
                  onChange={(event) => setImportId(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void submitImport();
                    }
                  }}
                />
                <p className="text-xs text-muted-foreground">
                  {importProvider === "claudeAgent"
                    ? "Claude resumes a persisted session by session id."
                    : importProvider === "cursor"
                      ? "Cursor resumes a persisted session by session id."
                      : importProvider === "opencode"
                        ? "OpenCode resumes a persisted session by session id."
                        : "Codex resumes a persisted thread by thread id."}
                </p>
              </div>
              {importError ? (
                <p className="rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                  {importError}
                </p>
              ) : null}
              <div className="flex justify-end gap-2">
                <Button
                  variant="ghost"
                  onClick={() => {
                    setImportError(null);
                    props.onOpenChange(false);
                  }}
                >
                  Cancel
                </Button>
                <Button
                  disabled={
                    props.importProviders.length === 0 ||
                    importId.trim().length === 0 ||
                    isImporting
                  }
                  onClick={submitImport}
                >
                  {isImporting ? "Importing..." : "Import"}
                </Button>
              </div>
            </div>
          </div>
        ) : (
          <>
            <Command
              autoHighlight={isBrowsing ? false : "always"}
              mode="none"
              onItemHighlighted={(value) => {
                setHighlightedItemValue(typeof value === "string" ? value : null);
              }}
            >
              {/* Bare input, no hairline: the header row IS the input, like ⌘P. */}
              <div className="relative">
                <AutocompletePrimitive.Input
                  autoFocus
                  className={cn(
                    PALETTE_INPUT_CLASS,
                    isBrowsing ? (willCreateMissingFolder ? "pe-36" : "pe-24") : undefined,
                  )}
                  placeholder={
                    isBrowsing
                      ? "Enter project path (e.g. ~/projects/my-app)"
                      : "Search chats or run a command"
                  }
                  value={query}
                  onChange={(event) => setQuery(event.currentTarget.value)}
                  onKeyDown={handleBrowseInputKeyDown}
                />
                {isBrowsing ? (
                  <Button
                    variant="outline"
                    size="xs"
                    tabIndex={-1}
                    className="-translate-y-1/2 absolute end-3 top-1/2 gap-1.5 pe-1 ps-2"
                    disabled={
                      isAddingProject ||
                      unsupportedWindowsPath ||
                      (trimmedQuery.length === 0 && !highlightedFolderPath) ||
                      (!highlightedFolderPath && isExplicitRelativeProjectPath(trimmedQuery))
                    }
                    onMouseDown={(event) => {
                      event.preventDefault();
                    }}
                    onClick={() => void submitBrowsePath()}
                    title={
                      hasHighlightedFolderItem
                        ? `${browseSubmitLabel} highlighted folder (${submitModifierLabel} Enter)`
                        : `${browseSubmitLabel} (Enter)`
                    }
                  >
                    <span>{browseSubmitLabel}</span>
                    <KbdGroup className="pointer-events-none -me-0.5 items-center gap-1">
                      <Kbd>
                        {hasHighlightedFolderItem ? `${submitModifierLabel} Enter` : "Enter"}
                      </Kbd>
                    </KbdGroup>
                  </Button>
                ) : null}
              </div>
              <CommandList className="max-h-[min(30rem,60vh)] not-empty:px-1.5 not-empty:pt-0 not-empty:pb-2">
                {canBrowse && (canBrowseUp || filteredBrowseEntries.length > 0) ? (
                  <CommandGroup>
                    {canBrowseUp ? (
                      <CommandItem
                        key="browse-up"
                        value="__browse_up__"
                        className={PALETTE_ITEM_CLASS}
                        onMouseDown={(event) => {
                          event.preventDefault();
                        }}
                        onClick={() => {
                          if (browseParentPath) setQuery(browseParentPath);
                        }}
                      >
                        <LuCornerLeftUp className={PALETTE_ICON_CLASS} />
                        <span className={PALETTE_TEXT_CLASS}>..</span>
                      </CommandItem>
                    ) : null}
                    {filteredBrowseEntries.map((entry) => (
                      <CommandItem
                        key={entry.fullPath}
                        value={`folder:${entry.fullPath}`}
                        className={PALETTE_ITEM_CLASS}
                        onMouseDown={(event) => {
                          event.preventDefault();
                        }}
                        onClick={() => setQuery(appendBrowsePathSegment(query, entry.name))}
                      >
                        <FolderClosed className={PALETTE_ICON_CLASS} />
                        <span className={PALETTE_TEXT_CLASS}>{entry.name}</span>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                ) : null}

                {/* Recent threads lead when idle (mirrors the Ctrl+Tab switcher order);
                    with a query the group turns into the thread matches. */}
                {!isBrowsing && matchedThreads.length > 0 ? (
                  <CommandGroup>
                    <CommandGroupLabel className={PALETTE_GROUP_LABEL_CLASS}>
                      <span>{query ? "Threads" : "Recent chats"}</span>
                    </CommandGroupLabel>
                    {matchedThreads.map(({ id, matchKind, messageMatchCount, snippet, thread }) => {
                      const matchLabel = threadMatchLabel({ matchKind, messageMatchCount });
                      const matchContext =
                        snippet ??
                        (matchKind === "project"
                          ? [thread.projectName, thread.projectRemoteName, thread.spaceName]
                              .filter(Boolean)
                              .join(" · ")
                          : null);
                      return (
                        <CommandItem
                          key={id}
                          value={id}
                          className={cn(PALETTE_ITEM_CLASS, matchContext ? "py-1" : undefined)}
                          onMouseDown={(event) => {
                            event.preventDefault();
                          }}
                          onClick={() => {
                            props.onOpenChange(false);
                            props.onOpenThread(thread.id);
                          }}
                        >
                          <span className="flex size-3.5 shrink-0 items-center justify-center">
                            {isGenericChatThreadTitle(thread.title) ? null : (
                              <SharedProviderIcon
                                provider={thread.provider}
                                className={PALETTE_ICON_CLASS}
                              />
                            )}
                          </span>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-baseline gap-3">
                              <div className={PALETTE_TEXT_CLASS}>
                                <HighlightedText
                                  text={thread.title || "Untitled thread"}
                                  query={query}
                                />
                              </div>
                              {/* Keep the idle row compact; metadata search context appears below. */}
                              <span className={PALETTE_META_CLASS}>{thread.projectName}</span>
                            </div>
                            {matchContext ? (
                              <div className="flex items-start gap-3">
                                <div className="min-w-0 flex-1 line-clamp-1 text-[length:var(--app-font-size-ui-meta,10px)] leading-4 text-muted-foreground/78">
                                  <HighlightedText text={matchContext} query={query} />
                                </div>
                                {matchLabel ? (
                                  <span className="shrink-0 text-[length:var(--app-font-size-ui-meta,10px)] leading-4 text-muted-foreground/58">
                                    {matchLabel}
                                  </span>
                                ) : null}
                              </div>
                            ) : null}
                          </div>
                        </CommandItem>
                      );
                    })}
                  </CommandGroup>
                ) : null}

                {!isBrowsing && quickActions.length > 0 ? (
                  <CommandGroup>
                    <CommandGroupLabel className={PALETTE_GROUP_LABEL_CLASS}>
                      <span>{query ? "Actions" : "Quick actions"}</span>
                    </CommandGroupLabel>
                    {quickActions.map(renderActionItem)}
                  </CommandGroup>
                ) : null}

                {!isBrowsing && settingsActions.length > 0 ? (
                  <CommandGroup>
                    <CommandGroupLabel className={PALETTE_GROUP_LABEL_CLASS}>
                      <span>Settings</span>
                    </CommandGroupLabel>
                    {settingsActions.map(renderActionItem)}
                  </CommandGroup>
                ) : null}

                {!isBrowsing && matchedProjects.length > 0 ? (
                  <CommandGroup>
                    <CommandGroupLabel className={PALETTE_GROUP_LABEL_CLASS}>
                      <span>Projects</span>
                    </CommandGroupLabel>
                    {matchedProjects.map(({ id, project }) => (
                      <CommandItem
                        key={id}
                        value={id}
                        className={PALETTE_ITEM_CLASS}
                        onMouseDown={(event) => {
                          event.preventDefault();
                        }}
                        onClick={() => {
                          props.onOpenChange(false);
                          props.onOpenProject(project.id);
                        }}
                      >
                        <FolderOpenFrontIcon className={PALETTE_ICON_CLASS} />
                        <span className={PALETTE_TEXT_CLASS}>
                          {project.name || "Untitled project"}
                        </span>
                        {/* Opening a project from here can switch Space, so the destination
                            is worth naming; the path is what identifies the project. */}
                        <span className={PALETTE_META_CLASS}>
                          {project.spaceName
                            ? `${project.spaceName} · ${project.cwd}`
                            : project.cwd}
                        </span>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                ) : null}

                {showThemeSection ? (
                  <>
                    {themeCommandItems.length > 0 ? (
                      <CommandGroup>
                        <CommandGroupLabel className={PALETTE_GROUP_LABEL_CLASS}>
                          <span>Configure</span>
                        </CommandGroupLabel>
                        {themeCommandItems.map((themeCommandItem) => {
                          const ThemeIcon = THEME_MODE_ICONS[themeCommandItem.mode];
                          return (
                            <CommandItem
                              key={themeCommandItem.id}
                              value={themeCommandItem.id}
                              className={PALETTE_ITEM_CLASS}
                              onMouseDown={(event) => {
                                event.preventDefault();
                              }}
                              onClick={() => {
                                if (themeCommandItem.isActive) return;
                                props.onOpenChange(false);
                                setTheme(themeCommandItem.mode);
                              }}
                            >
                              <ThemeIcon className={PALETTE_ICON_CLASS} />
                              <span className={PALETTE_TEXT_CLASS}>{themeCommandItem.label}</span>
                              <span
                                className="flex size-3.5 shrink-0 items-center justify-center"
                                aria-hidden={!themeCommandItem.isActive}
                              >
                                {themeCommandItem.isActive ? (
                                  <CheckIcon className={PALETTE_ICON_CLASS} />
                                ) : null}
                              </span>
                            </CommandItem>
                          );
                        })}
                      </CommandGroup>
                    ) : null}
                    {matchedCurrentThemes.length > 0 ? (
                      <CommandGroup>
                        <CommandGroupLabel className={PALETTE_GROUP_LABEL_CLASS}>
                          <span>{resolvedTheme === "dark" ? "Dark themes" : "Light themes"}</span>
                        </CommandGroupLabel>
                        {matchedCurrentThemes.map((themeItem) => {
                          const seed =
                            themeItem.codeThemeId && themeItem.variant
                              ? getCodeThemeSeed(themeItem.codeThemeId, themeItem.variant)
                              : null;
                          return (
                            <CommandItem
                              key={themeItem.id}
                              value={themeItem.id}
                              className={PALETTE_ITEM_CLASS}
                              onMouseDown={(event) => {
                                event.preventDefault();
                              }}
                              onClick={() => {
                                if (!themeItem.codeThemeId || !themeItem.variant) return;
                                props.onOpenChange(false);
                                setCodeThemeId(themeItem.variant, themeItem.codeThemeId);
                              }}
                            >
                              {seed ? (
                                <CodeThemeBadge
                                  accent={seed.accent}
                                  background={seed.surface}
                                  foreground={seed.ink}
                                />
                              ) : null}
                              <span className={PALETTE_TEXT_CLASS}>{themeItem.label}</span>
                              <span className={PALETTE_META_CLASS}>
                                {resolvedTheme === "dark"
                                  ? "Dark color theme"
                                  : "Light color theme"}
                              </span>
                              <span
                                className="flex size-3.5 shrink-0 items-center justify-center"
                                aria-hidden={!themeItem.isActive}
                              >
                                {themeItem.isActive ? (
                                  <CheckIcon className={PALETTE_ICON_CLASS} />
                                ) : null}
                              </span>
                            </CommandItem>
                          );
                        })}
                      </CommandGroup>
                    ) : null}
                  </>
                ) : null}
              </CommandList>
              {/* Status copy and banners live outside the listbox: assistive
                  tech treats listbox children as options, so anything that is
                  not selectable goes in this polite live region instead. */}
              <CommandStatus className="p-0">
                {isBrowsing ? (
                  unsupportedWindowsPath ? (
                    <div className={PALETTE_STATUS_CLASS}>
                      Windows paths are not supported on this platform.
                    </div>
                  ) : (
                    <>
                      {!canBrowseUp && filteredBrowseEntries.length === 0 && !isBrowseFetching ? (
                        <div className={PALETTE_STATUS_CLASS}>No matching folders.</div>
                      ) : null}
                      {willCreateMissingFolder ? (
                        <div className="palette-row mx-3 mb-2 rounded-lg border border-dashed border-[color:var(--color-border)] px-3 py-2 text-[length:var(--app-font-size-ui,12px)] text-muted-foreground">
                          Press Enter to create{" "}
                          <span className="text-foreground">{trimmedQuery}</span> and add it as a
                          project.
                        </div>
                      ) : null}
                      {addProjectError ? (
                        <div className="palette-row mx-3 mb-2 rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2 text-[length:var(--app-font-size-ui,12px)] text-destructive">
                          {addProjectError}
                        </div>
                      ) : null}
                      <div className={cn(PALETTE_STATUS_CLASS, "flex justify-between gap-3")}>
                        <span>
                          {isAddingProject
                            ? "Adding project..."
                            : "Type a path, ↑↓ to navigate folders."}
                        </span>
                        <span>
                          {hasHighlightedFolderItem
                            ? `Enter to open · ${submitModifierLabel}+Enter to add`
                            : hasHighlightedBrowseItem
                              ? "Enter to go up"
                              : "Enter to add project"}
                        </span>
                      </div>
                    </>
                  )
                ) : !hasSearchResults ? (
                  <div className={PALETTE_STATUS_CLASS}>No matches.</div>
                ) : null}
              </CommandStatus>
            </Command>
          </>
        )}
      </CommandDialogPopup>
    </CommandDialog>
  );
}
