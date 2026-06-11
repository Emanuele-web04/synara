/**
 * SidebarSearchPalette - Command-style palette for sidebar actions, threads, and projects.
 *
 * Keeps the sidebar search UX aligned with the shared command primitives so
 * keyboard navigation and shortcut labels behave like the rest of the app.
 */
import { CheckIcon, GitPullRequestIcon, SearchIcon } from "~/lib/icons";
import { type FilesystemBrowseResult } from "@t3tools/contracts";
import { isGenericChatThreadTitle } from "@t3tools/shared/chatThreads";
import { HiOutlineFolderOpen } from "react-icons/hi2";
import { LuCornerLeftUp, LuFolderPlus } from "react-icons/lu";
import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { FolderClosed } from "./FolderClosed";
import { formatRelativeTime } from "./Sidebar";
import { readNativeApi } from "~/nativeApi";
import { isMacPlatform } from "~/lib/utils";
import { parsePullRequestReference } from "~/pullRequestReference";
import { Kbd, KbdGroup } from "./ui/kbd";
import {
  appendBrowsePathSegment,
  canNavigateUp,
  getBrowseDirectoryPath,
  getBrowseLeafPathSegment,
  getBrowseParentPath,
  getInitialBrowseQuery,
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
  buildThemeCommandItem,
  expandHomeInPath,
  matchSidebarSearchActions,
  matchSidebarSearchProjects,
  matchSidebarSearchThemes,
  matchSidebarSearchThreads,
  threadMatchLabel,
} from "./SidebarSearchPalette.logic";
import {
  ACTION_ICONS,
  CodeThemeBadge,
  HighlightedText,
  PaletteIcon,
  ProviderIcon,
  THEME_MODE_ICONS,
} from "./SidebarSearchPalette.parts";
import { type ImportProviderKind, SidebarSearchImportPanel } from "./SidebarSearchImportPanel";
import { useTheme } from "../hooks/useTheme";
import { getAvailableCodeThemes, getCodeThemeSeed } from "../theme/theme.logic";
import {
  Command,
  CommandDialog,
  CommandDialogPopup,
  CommandEmpty,
  CommandFooter,
  CommandGroup,
  CommandGroupLabel,
  CommandInput,
  CommandItem,
  CommandList,
  CommandPanel,
  CommandSeparator,
} from "./ui/command";
import { Button } from "./ui/button";
import { ShortcutKbd } from "./ui/shortcut-kbd";

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
  initialBrowseQuery?: string | null;
  onOpenSettings: () => void;
  onOpenProject: (projectId: string) => void;
  onOpenPullRequestReference: (reference: string) => void;
  onOpenThread: (threadId: string) => void;
  importProviders: readonly ImportProviderKind[];
  onImportThread: (provider: ImportProviderKind, externalId: string) => Promise<void>;
}

export type { ImportProviderKind };

function actionHandler(
  actionId: string,
  props: Pick<SidebarSearchPaletteProps, "onCreateChat" | "onCreateThread" | "onOpenSettings">,
): (() => void) | null {
  switch (actionId) {
    case "new-chat":
      return props.onCreateChat;
    case "new-thread":
      return props.onCreateThread;
    case "settings":
      return props.onOpenSettings;
    default:
      return null;
  }
}

const BROWSE_STALE_TIME_MS = 10_000;

const EMPTY_BROWSE_ENTRIES: FilesystemBrowseResult["entries"] = [];

export function SidebarSearchPalette(props: SidebarSearchPaletteProps) {
  const { activeTheme, resolvedTheme, setCodeThemeId, setTheme, theme } = useTheme();
  const [query, setQuery] = useState(props.initialBrowseQuery ?? "");
  const [highlightedItemValue, setHighlightedItemValue] = useState<string | null>(null);
  const [addProjectError, setAddProjectError] = useState<string | null>(null);
  const [isAddingProject, setIsAddingProject] = useState(false);

  useEffect(() => {
    if (!props.open) {
      setQuery("");
      setHighlightedItemValue(null);
      setAddProjectError(null);
      setIsAddingProject(false);
    }
  }, [props.open]);

  useEffect(() => {
    setAddProjectError(null);
  }, [query]);

  const platform = typeof navigator === "undefined" ? "" : navigator.platform;
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
  const filteredBrowseEntries = useMemo(() => {
    const lowerFilter = leafSegment.toLowerCase();
    const showHidden = leafSegment.startsWith(".");
    return browseEntries.filter(
      (entry) =>
        entry.name.toLowerCase().startsWith(lowerFilter) &&
        (showHidden || !entry.name.startsWith(".")),
    );
  }, [browseEntries, leafSegment]);

  const exactBrowseEntry = useMemo(() => {
    if (leafSegment.length === 0) return null;
    return filteredBrowseEntries.find((entry) => entry.name === leafSegment) ?? null;
  }, [filteredBrowseEntries, leafSegment]);

  const browseParentPath = canBrowse ? getBrowseParentPath(query) : null;
  const canBrowseUp = canBrowse && canNavigateUp(query);

  const matchedActions = useMemo(
    () => (isBrowsing ? [] : matchSidebarSearchActions(props.actions, query)),
    [isBrowsing, props.actions, query],
  );
  const parsedPullRequestReference = useMemo(
    () => (isBrowsing ? null : parsePullRequestReference(trimmedQuery)),
    [isBrowsing, trimmedQuery],
  );
  const themeCommandItem = useMemo(
    () =>
      buildThemeCommandItem({
        query,
        resolvedTheme,
        theme,
      }),
    [query, resolvedTheme, theme],
  );
  const currentCodeThemeItems = useMemo<SidebarSearchTheme[]>(
    () =>
      getAvailableCodeThemes(resolvedTheme).map((option) => ({
        id: `theme-code:${resolvedTheme}:${option.id}`,
        type: "code-theme",
        label: option.label,
        description: `Apply to the current ${resolvedTheme} theme slot.`,
        keywords: ["appearance", "theme", resolvedTheme, option.id],
        codeThemeId: option.id,
        variant: resolvedTheme,
        isActive: activeTheme.codeThemeId === option.id,
      })),
    [activeTheme.codeThemeId, resolvedTheme],
  );
  const matchedCurrentThemes = useMemo(
    () =>
      isBrowsing || query.trim().length === 0
        ? []
        : matchSidebarSearchThemes(currentCodeThemeItems, query),
    [currentCodeThemeItems, isBrowsing, query],
  );
  const showThemeSection =
    !isBrowsing &&
    query.trim().length > 0 &&
    (themeCommandItem !== null || matchedCurrentThemes.length > 0);
  const matchedProjects = useMemo(
    () => (isBrowsing ? [] : matchSidebarSearchProjects(props.projects, query)),
    [isBrowsing, props.projects, query],
  );
  const matchedThreads = useMemo(
    () => (isBrowsing ? [] : matchSidebarSearchThreads(props.threads, query)),
    [isBrowsing, props.threads, query],
  );
  const hasSearchResults =
    matchedActions.length > 0 ||
    themeCommandItem !== null ||
    matchedCurrentThemes.length > 0 ||
    parsedPullRequestReference !== null ||
    matchedProjects.length > 0 ||
    matchedThreads.length > 0;

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
    try {
      await props.onAddProjectPath(resolveBrowseSubmitPath(), {
        createIfMissing: willCreateMissingFolder,
      });
      props.onOpenChange(false);
    } catch (cause) {
      setAddProjectError(cause instanceof Error ? cause.message : "Failed to add project.");
    } finally {
      setIsAddingProject(false);
    }
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

  return (
    <CommandDialog open={props.open} onOpenChange={props.onOpenChange}>
      <CommandDialogPopup className="max-w-2xl">
        {props.mode === "import" ? (
          <SidebarSearchImportPanel
            open={props.open}
            importProviders={props.importProviders}
            onModeChange={props.onModeChange}
            onOpenChange={props.onOpenChange}
            onImportThread={props.onImportThread}
          />
        ) : (
          <>
            <Command
              autoHighlight={isBrowsing ? false : "always"}
              mode="none"
              onItemHighlighted={(value) => {
                setHighlightedItemValue(typeof value === "string" ? value : null);
              }}
            >
              <CommandPanel className="overflow-hidden">
                <div className="relative">
                  <CommandInput
                    placeholder={
                      isBrowsing
                        ? "Enter project path (e.g. ~/projects/my-app)"
                        : "Search projects, threads, and actions"
                    }
                    value={query}
                    onChange={(event) => setQuery(event.currentTarget.value)}
                    onKeyDown={handleBrowseInputKeyDown}
                    startAddon={
                      isBrowsing ? (
                        <LuFolderPlus className="text-muted-foreground" />
                      ) : (
                        <SearchIcon className="text-muted-foreground" />
                      )
                    }
                    className={
                      isBrowsing ? (willCreateMissingFolder ? "pe-36" : "pe-24") : undefined
                    }
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
                <CommandList className="max-h-[min(24rem,60vh)] not-empty:px-1.5 not-empty:pt-0 not-empty:pb-1.5">
                  {isBrowsing ? (
                    unsupportedWindowsPath ? (
                      <CommandEmpty className="py-10">
                        <div className="text-center text-sm text-muted-foreground/79">
                          Windows paths are not supported on this platform.
                        </div>
                      </CommandEmpty>
                    ) : (
                      <>
                        {canBrowseUp || filteredBrowseEntries.length > 0 ? (
                          <CommandGroup>
                            {canBrowseUp ? (
                              <CommandItem
                                key="browse-up"
                                value="__browse_up__"
                                className="cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5"
                                onMouseDown={(event) => {
                                  event.preventDefault();
                                }}
                                onClick={() => {
                                  if (browseParentPath) setQuery(browseParentPath);
                                }}
                              >
                                <LuCornerLeftUp className="size-3.5 text-muted-foreground/75" />
                                <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                                  ..
                                </span>
                              </CommandItem>
                            ) : null}
                            {filteredBrowseEntries.map((entry) => (
                              <CommandItem
                                key={entry.fullPath}
                                value={`folder:${entry.fullPath}`}
                                className="cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5"
                                onMouseDown={(event) => {
                                  event.preventDefault();
                                }}
                                onClick={() => setQuery(appendBrowsePathSegment(query, entry.name))}
                              >
                                <FolderClosed className="size-3.5 text-muted-foreground/75" />
                                <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                                  {entry.name}
                                </span>
                              </CommandItem>
                            ))}
                          </CommandGroup>
                        ) : !isBrowseFetching ? (
                          <div className="px-3 py-2 text-sm text-muted-foreground">
                            No matching folders.
                          </div>
                        ) : null}
                        {willCreateMissingFolder ? (
                          <div className="mx-1.5 mt-2 rounded-md border border-dashed border-[color:var(--color-border)] px-3 py-2 text-sm text-muted-foreground">
                            Press Enter to create{" "}
                            <span className="text-foreground">{trimmedQuery}</span> and add it as a
                            project.
                          </div>
                        ) : null}
                        {addProjectError ? (
                          <div className="mx-1.5 mt-2 rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                            {addProjectError}
                          </div>
                        ) : null}
                      </>
                    )
                  ) : null}

                  {!isBrowsing && matchedActions.length > 0 ? (
                    <CommandGroup>
                      <CommandGroupLabel className="pt-0 pb-1.5 pl-3">Suggested</CommandGroupLabel>
                      {matchedActions.map((action) => {
                        const onSelect = actionHandler(action.id, props);
                        const Icon = ACTION_ICONS[action.id];
                        return (
                          <CommandItem
                            key={action.id}
                            value={`action:${action.id}`}
                            className="cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5"
                            onMouseDown={(event) => {
                              event.preventDefault();
                            }}
                            onClick={() => {
                              if (action.id === "import-thread") {
                                props.onModeChange("import");
                                return;
                              }
                              if (action.id === "add-project") {
                                setQuery(getInitialBrowseQuery(props.homeDir));
                                return;
                              }
                              if (!onSelect) return;
                              props.onOpenChange(false);
                              onSelect();
                            }}
                          >
                            {Icon ? <PaletteIcon icon={Icon} /> : null}
                            <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                              {action.label}
                            </span>
                            {action.shortcutLabel ? (
                              <ShortcutKbd
                                shortcutLabel={action.shortcutLabel}
                                groupClassName="shrink-0"
                              />
                            ) : null}
                          </CommandItem>
                        );
                      })}
                    </CommandGroup>
                  ) : null}

                  {!isBrowsing &&
                  matchedActions.length > 0 &&
                  (parsedPullRequestReference !== null ||
                    matchedThreads.length > 0 ||
                    matchedProjects.length > 0 ||
                    showThemeSection) ? (
                    <CommandSeparator />
                  ) : null}

                  {!isBrowsing && parsedPullRequestReference !== null ? (
                    <CommandGroup>
                      <CommandGroupLabel className="py-1.5 pl-3">Review</CommandGroupLabel>
                      <CommandItem
                        key="review-pr-reference"
                        value={`review-pr:${parsedPullRequestReference}`}
                        className="cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5"
                        onMouseDown={(event) => {
                          event.preventDefault();
                        }}
                        onClick={() => {
                          props.onOpenChange(false);
                          props.onOpenPullRequestReference(parsedPullRequestReference);
                        }}
                      >
                        <PaletteIcon icon={GitPullRequestIcon} />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-[length:var(--app-font-size-ui,12px)] text-foreground">
                            Open pull request
                          </div>
                          <div className="truncate text-[length:var(--app-font-size-ui-meta,10px)] text-muted-foreground/79">
                            {parsedPullRequestReference}
                          </div>
                        </div>
                      </CommandItem>
                    </CommandGroup>
                  ) : null}

                  {!isBrowsing &&
                  parsedPullRequestReference !== null &&
                  (matchedThreads.length > 0 || matchedProjects.length > 0 || showThemeSection) ? (
                    <CommandSeparator />
                  ) : null}

                  {!isBrowsing && matchedThreads.length > 0 ? (
                    <CommandGroup>
                      <CommandGroupLabel className="py-1.5 pl-3">
                        {query ? "Threads" : "Recent"}
                      </CommandGroupLabel>
                      {matchedThreads.map(
                        ({ id, matchKind, messageMatchCount, snippet, thread }) => (
                          <CommandItem
                            key={id}
                            value={id}
                            className="cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2"
                            onMouseDown={(event) => {
                              event.preventDefault();
                            }}
                            onClick={() => {
                              props.onOpenChange(false);
                              props.onOpenThread(thread.id);
                            }}
                          >
                            {isGenericChatThreadTitle(thread.title) ? null : (
                              <ProviderIcon provider={thread.provider} />
                            )}
                            <div className="min-w-0 flex-1">
                              <div className="flex items-baseline gap-3">
                                <div className="min-w-0 flex-1 truncate text-[length:var(--app-font-size-ui,12px)] text-foreground">
                                  <HighlightedText
                                    text={thread.title || "Untitled thread"}
                                    query={query}
                                  />
                                </div>
                                <span className="w-24 shrink-0 truncate text-right text-[length:var(--app-font-size-ui-meta,10px)] text-muted-foreground/79">
                                  {thread.projectName}
                                </span>
                                {thread.updatedAt || thread.createdAt ? (
                                  <span className="w-10 shrink-0 text-right text-[length:var(--app-font-size-ui-timestamp,10px)] text-muted-foreground/79">
                                    {formatRelativeTime(thread.updatedAt ?? thread.createdAt)}
                                  </span>
                                ) : (
                                  <span className="w-10 shrink-0" />
                                )}
                              </div>
                              {snippet ? (
                                <div className="mt-0.5 flex items-start gap-3">
                                  <div className="min-w-0 flex-1 line-clamp-1 text-[length:var(--app-font-size-ui-meta,10px)] leading-5 text-muted-foreground/78">
                                    <HighlightedText text={snippet} query={query} />
                                  </div>
                                  <div className="flex w-[8.5rem] shrink-0 justify-end">
                                    {threadMatchLabel({ matchKind, messageMatchCount }) ? (
                                      <span className="truncate text-[length:var(--app-font-size-ui-meta,10px)] text-muted-foreground/70">
                                        {threadMatchLabel({ matchKind, messageMatchCount })}
                                      </span>
                                    ) : null}
                                  </div>
                                </div>
                              ) : threadMatchLabel({ matchKind, messageMatchCount }) ? (
                                <div className="mt-0.5 text-[length:var(--app-font-size-ui-meta,10px)] text-muted-foreground/70">
                                  {threadMatchLabel({ matchKind, messageMatchCount })}
                                </div>
                              ) : null}
                            </div>
                          </CommandItem>
                        ),
                      )}
                    </CommandGroup>
                  ) : null}

                  {!isBrowsing &&
                  matchedThreads.length > 0 &&
                  (matchedProjects.length > 0 || showThemeSection) ? (
                    <CommandSeparator />
                  ) : null}

                  {!isBrowsing && matchedProjects.length > 0 ? (
                    <CommandGroup>
                      <CommandGroupLabel className="py-1.5 pl-3">Projects</CommandGroupLabel>
                      {matchedProjects.map(({ id, project }) => (
                        <CommandItem
                          key={id}
                          value={id}
                          className="cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5"
                          onMouseDown={(event) => {
                            event.preventDefault();
                          }}
                          onClick={() => {
                            props.onOpenChange(false);
                            props.onOpenProject(project.id);
                          }}
                        >
                          <PaletteIcon icon={HiOutlineFolderOpen} />
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-[length:var(--app-font-size-ui,12px)] text-foreground">
                              {project.name || "Untitled project"}
                            </div>
                            <div className="truncate text-[length:var(--app-font-size-ui-meta,10px)] text-muted-foreground/79">
                              {project.localName
                                ? `${project.folderName} · ${project.cwd}`
                                : project.cwd}
                            </div>
                          </div>
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  ) : null}

                  {showThemeSection && matchedProjects.length > 0 ? <CommandSeparator /> : null}

                  {showThemeSection ? (
                    <>
                      {themeCommandItem ? (
                        <CommandGroup>
                          <CommandGroupLabel className="py-1.5 pl-3">Configure</CommandGroupLabel>
                          <CommandItem
                            key={themeCommandItem.id}
                            value={themeCommandItem.id}
                            className="cursor-pointer items-center gap-3 rounded-lg px-3 py-1.5"
                            onMouseDown={(event) => {
                              event.preventDefault();
                            }}
                            onClick={() => {
                              if (themeCommandItem.isActive) return;
                              props.onOpenChange(false);
                              setTheme(themeCommandItem.mode);
                            }}
                          >
                            <PaletteIcon icon={THEME_MODE_ICONS[themeCommandItem.mode]} />
                            <span className="min-w-0 flex-1 truncate text-[length:var(--app-font-size-ui,12px)] text-foreground">
                              {themeCommandItem.label}
                            </span>
                            {themeCommandItem.isActive ? (
                              <CheckIcon className="size-3.5 shrink-0 text-muted-foreground/79" />
                            ) : null}
                          </CommandItem>
                        </CommandGroup>
                      ) : null}
                      {matchedCurrentThemes.length > 0 ? (
                        <CommandGroup>
                          <CommandGroupLabel className="py-1.5 pl-3">
                            {resolvedTheme === "dark" ? "Dark themes" : "Light themes"}
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
                                className="cursor-pointer items-center gap-3 rounded-lg px-3 py-1.5"
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
                                <span className="min-w-0 flex-1 truncate text-[length:var(--app-font-size-ui,12px)] text-foreground">
                                  {themeItem.label}
                                </span>
                                <span className="shrink-0 text-[length:var(--app-font-size-ui-meta,10px)] text-muted-foreground/79">
                                  {resolvedTheme === "dark"
                                    ? "Dark color theme"
                                    : "Light color theme"}
                                </span>
                                <span
                                  className="flex size-3.5 shrink-0 items-center justify-center"
                                  aria-hidden={!themeItem.isActive}
                                >
                                  {themeItem.isActive ? (
                                    <CheckIcon className="size-3.5 text-muted-foreground/79" />
                                  ) : null}
                                </span>
                              </CommandItem>
                            );
                          })}
                        </CommandGroup>
                      ) : null}
                    </>
                  ) : null}

                  {!isBrowsing && !hasSearchResults ? (
                    <CommandEmpty className="py-10">
                      <div className="flex flex-col items-center justify-center gap-2 text-center text-sm text-muted-foreground/79">
                        <SearchIcon className="size-4 opacity-70" />
                        <div>No matches. Paste a pull request number or GitHub PR link.</div>
                      </div>
                    </CommandEmpty>
                  ) : null}
                </CommandList>
                <div className="h-1.5" />
              </CommandPanel>
              <CommandFooter>
                {isBrowsing ? (
                  <>
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
                  </>
                ) : (
                  <>
                    <span>Jump to threads, projects, PRs, actions, or appearance.</span>
                    <span>Enter to open</span>
                  </>
                )}
              </CommandFooter>
            </Command>
          </>
        )}
      </CommandDialogPopup>
    </CommandDialog>
  );
}
