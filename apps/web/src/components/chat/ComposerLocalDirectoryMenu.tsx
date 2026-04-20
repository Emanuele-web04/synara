// FILE: ComposerLocalDirectoryMenu.tsx
// Purpose: Render the inline composer popup used for browsing local files and folders after `@local`.
// Layer: Chat composer UI
// Depends on: the same Command primitives used by ComposerCommandMenu so both pickers share chrome.

import type { ProjectFileSystemEntry, ProjectLocalSearchEntry } from "@t3tools/contracts";
import type { Ref } from "react";
import {
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { useQuery } from "@tanstack/react-query";
import { useDebouncedValue } from "@tanstack/react-pacer";
import { ArrowUpIcon, FileIcon } from "~/lib/icons";
import { expandLocalFolderPath } from "~/lib/localFolderMentions";
import { projectSearchLocalEntriesQueryOptions } from "~/lib/projectReactQuery";
import { readNativeApi } from "~/nativeApi";
import { cn } from "~/lib/utils";
import { FolderClosed } from "../FolderClosed";
import { Command, CommandGroup, CommandItem, CommandList, CommandSeparator } from "../ui/command";

type EntriesByPath = Record<string, readonly ProjectFileSystemEntry[] | undefined>;

// Delay search requests until the user stops typing — keeps chat input smooth
// because every keystroke reshapes mentionQuery in the parent.
const LOCAL_SEARCH_DEBOUNCE_MS = 220;
const LOCAL_SEARCH_MIN_QUERY_LENGTH = 2;

export interface ComposerLocalDirectoryMenuHandle {
  moveHighlight: (direction: "up" | "down") => void;
  activateHighlighted: () => boolean;
}

type VisibleRow =
  | { kind: "use-current"; separator: "/" | "\\" }
  | { kind: "entry"; entry: ProjectFileSystemEntry }
  | { kind: "search"; entry: ProjectLocalSearchEntry };

function detectPathSeparator(value: string): "/" | "\\" {
  return value.includes("\\") ? "\\" : "/";
}

function joinDirectoryPath(directoryPath: string, childName: string): string {
  if (!childName) return directoryPath;
  const separator = detectPathSeparator(directoryPath);
  const needsSeparator = !directoryPath.endsWith(separator);
  return `${directoryPath}${needsSeparator ? separator : ""}${childName}`;
}

function isTildeRoot(directoryPath: string): boolean {
  return directoryPath === "~/" || directoryPath === "~\\";
}

function parentDirectory(directoryPath: string): string | null {
  if (!directoryPath) return null;
  if (directoryPath === "/") return null;
  if (/^[A-Za-z]:[\\/]$/.test(directoryPath)) return null;
  if (isTildeRoot(directoryPath)) return null;

  const separator = detectPathSeparator(directoryPath);
  const trimmed = directoryPath.endsWith(separator) ? directoryPath.slice(0, -1) : directoryPath;
  const lastIndex = trimmed.lastIndexOf(separator);
  if (lastIndex === -1) return null;
  if (lastIndex === 0) return "/";

  const parentSlice = trimmed.slice(0, lastIndex);
  if (/^[A-Za-z]:$/.test(parentSlice) || parentSlice === "~") {
    return `${parentSlice}${separator}`;
  }
  return parentSlice;
}

function deriveDirectoryAndFilter(mentionQuery: string): { directory: string; filter: string } {
  const slashIndex = Math.max(mentionQuery.lastIndexOf("/"), mentionQuery.lastIndexOf("\\"));
  if (slashIndex === -1) {
    return { directory: "/", filter: mentionQuery };
  }
  const before = mentionQuery.slice(0, slashIndex);
  const after = mentionQuery.slice(slashIndex + 1);
  // `/foo` (root) and `C:/foo` (drive) and `~/foo` (home) share a rule:
  // the separator itself is the directory, everything before stays part of the root label.
  if (before === "" || /^[A-Za-z]:$/.test(before) || before === "~") {
    return { directory: mentionQuery.slice(0, slashIndex + 1), filter: after };
  }
  return { directory: before, filter: after };
}

function basename(value: string): string {
  const parts = value.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? value;
}

function isRootDirectory(directoryPath: string): boolean {
  if (directoryPath === "/") return true;
  if (/^[A-Za-z]:[\\/]$/.test(directoryPath)) return true;
  if (isTildeRoot(directoryPath)) return true;
  return false;
}

// Effect/fs errors come through with deep stack traces and absolute internal paths.
// Surface a short, user-friendly reason so the popover stays tidy on missing/denied paths.
function summarizeDirectoryLoadError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  if (/ENOENT|no such file or directory/i.test(raw)) {
    return "Folder not found.";
  }
  if (/EACCES|permission denied/i.test(raw)) {
    return "Permission denied.";
  }
  if (/ENOTDIR|not a directory/i.test(raw)) {
    return "Not a folder.";
  }
  return "Unable to load folders.";
}

export const ComposerLocalDirectoryMenu = memo(function ComposerLocalDirectoryMenu(props: {
  mentionQuery: string;
  rootLabel: string;
  homeDir: string | null;
  onSelectEntry: (absolutePath: string, entry: ProjectFileSystemEntry) => Promise<void> | void;
  onNavigateFolder: (absolutePath: string) => void;
  handleRef?: Ref<ComposerLocalDirectoryMenuHandle>;
}) {
  const { mentionQuery, rootLabel, homeDir, onSelectEntry, onNavigateFolder, handleRef } = props;
  const [entriesByPath, setEntriesByPath] = useState<EntriesByPath>({});
  const [loadingPaths, setLoadingPaths] = useState<ReadonlySet<string>>(() => new Set());
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const listRef = useRef<HTMLDivElement | null>(null);

  const { directory, filter } = useMemo(
    () => deriveDirectoryAndFilter(mentionQuery),
    [mentionQuery],
  );

  const expandedDirectory = useMemo(
    () => expandLocalFolderPath(directory, homeDir),
    [directory, homeDir],
  );

  // `~/...` paths can't be listed before homeDir is available from the server config.
  const isAwaitingHomeDir = useMemo(
    () =>
      (directory === "~" || directory.startsWith("~/") || directory.startsWith("~\\")) &&
      (!homeDir || homeDir.trim().length === 0),
    [directory, homeDir],
  );

  // Reset the error whenever the active directory changes so a stale message
  // from a non-existent path doesn't linger when the user backspaces elsewhere.
  useEffect(() => {
    setErrorMessage(null);
  }, [expandedDirectory]);

  // Cache by the expanded absolute path so `~/Documents` and `/Users/me/Documents`
  // share one entry instead of double-listing.
  useEffect(() => {
    if (!expandedDirectory) return;
    if (isAwaitingHomeDir) return;
    if (entriesByPath[expandedDirectory] !== undefined) return;
    if (loadingPaths.has(expandedDirectory)) return;
    const api = readNativeApi();
    if (!api) {
      setErrorMessage("App is still connecting. Try again in a moment.");
      return;
    }

    setLoadingPaths((current) => new Set(current).add(expandedDirectory));
    void api.projects
      .listDirectories({
        cwd: expandedDirectory,
        includeFiles: true,
      })
      .then((result) => {
        setEntriesByPath((current) => ({ ...current, [expandedDirectory]: result.entries }));
      })
      .catch((error) => {
        setEntriesByPath((current) => ({ ...current, [expandedDirectory]: [] }));
        setErrorMessage(summarizeDirectoryLoadError(error));
      })
      .finally(() => {
        setLoadingPaths((current) => {
          const next = new Set(current);
          next.delete(expandedDirectory);
          return next;
        });
      });
  }, [entriesByPath, expandedDirectory, isAwaitingHomeDir, loadingPaths]);

  const rawEntries = entriesByPath[expandedDirectory];
  const isLoading = loadingPaths.has(expandedDirectory);

  const { folders, files } = useMemo(() => {
    const normalizedFilter = filter.trim();
    const lowerFilter = normalizedFilter.toLowerCase();
    // Dotfiles are hidden by default, but unhide them as soon as the user opts
    // in by typing a leading `.` - devs want `.config`/`.ssh` to be reachable.
    const includeDotfiles = normalizedFilter.startsWith(".");
    const folderEntries: ProjectFileSystemEntry[] = [];
    const fileEntries: ProjectFileSystemEntry[] = [];
    for (const entry of rawEntries ?? []) {
      if (!includeDotfiles && entry.name.startsWith(".")) continue;
      if (lowerFilter.length > 0 && !entry.name.toLowerCase().includes(lowerFilter)) {
        continue;
      }
      if (entry.kind === "directory") folderEntries.push(entry);
      else fileEntries.push(entry);
    }
    return { folders: folderEntries, files: fileEntries };
  }, [filter, rawEntries]);

  const currentFolderRow = useMemo<VisibleRow | null>(() => {
    // Only offer "Use this folder" as a keyboard-accessible row when the user has
    // navigated past the root - the root itself never makes sense as a mention.
    if (isRootDirectory(directory)) return null;
    if (filter.trim().length > 0) return null;
    return { kind: "use-current", separator: detectPathSeparator(directory) };
  }, [directory, filter]);

  // Debounce the raw filter so keystrokes don't fan out into fuzzy-search RPCs.
  // The local listing still reacts immediately because it reads from `filter`.
  const [debouncedFilter] = useDebouncedValue(filter, {
    wait: LOCAL_SEARCH_DEBOUNCE_MS,
  });
  const trimmedDebouncedFilter = debouncedFilter.trim();
  const shouldRunFuzzySearch =
    !isAwaitingHomeDir &&
    expandedDirectory.length > 0 &&
    trimmedDebouncedFilter.length >= LOCAL_SEARCH_MIN_QUERY_LENGTH;

  const searchQuery = useQuery(
    projectSearchLocalEntriesQueryOptions({
      rootPath: shouldRunFuzzySearch ? expandedDirectory : null,
      query: trimmedDebouncedFilter,
      includeFiles: true,
      enabled: shouldRunFuzzySearch,
    }),
  );

  const searchRows = useMemo<ProjectLocalSearchEntry[]>(() => {
    if (!shouldRunFuzzySearch) return [];
    const result = searchQuery.data;
    if (!result) return [];
    const localPaths = new Set<string>();
    for (const entry of folders) {
      localPaths.add(joinDirectoryPath(expandedDirectory, entry.name));
    }
    for (const entry of files) {
      localPaths.add(joinDirectoryPath(expandedDirectory, entry.name));
    }
    const deduped: ProjectLocalSearchEntry[] = [];
    for (const entry of result.entries) {
      if (localPaths.has(entry.path)) continue;
      deduped.push(entry);
    }
    return deduped;
  }, [expandedDirectory, files, folders, searchQuery.data, shouldRunFuzzySearch]);

  const visibleRows = useMemo<VisibleRow[]>(() => {
    const rows: VisibleRow[] = [];
    if (currentFolderRow) rows.push(currentFolderRow);
    for (const entry of folders) rows.push({ kind: "entry", entry });
    for (const entry of files) rows.push({ kind: "entry", entry });
    for (const entry of searchRows) rows.push({ kind: "search", entry });
    return rows;
  }, [currentFolderRow, files, folders, searchRows]);

  useEffect(() => {
    if (visibleRows.length === 0) {
      if (highlightedIndex !== 0) setHighlightedIndex(0);
      return;
    }
    if (highlightedIndex >= visibleRows.length) {
      setHighlightedIndex(0);
    }
  }, [highlightedIndex, visibleRows.length]);

  useEffect(() => {
    setHighlightedIndex(0);
  }, [directory, filter]);

  const handleSelectCurrentDirectory = useCallback(() => {
    const absoluteDirectory = expandedDirectory;
    void onSelectEntry(absoluteDirectory, {
      kind: "directory",
      path: ".",
      name: basename(absoluteDirectory) || absoluteDirectory,
      hasChildren: folders.length > 0 || files.length > 0,
    });
  }, [expandedDirectory, files.length, folders.length, onSelectEntry]);

  const handleActivateEntry = useCallback(
    (entry: ProjectFileSystemEntry) => {
      if (entry.kind === "directory") {
        // Preserve the `~` prefix while the user keeps drilling in - the typed
        // composer text stays short until they commit a final selection.
        const displayPath = joinDirectoryPath(directory, entry.name);
        onNavigateFolder(displayPath);
      } else {
        // Commit with the fully expanded absolute path so the server receives
        // a stable reference even if the user originally typed `~/`.
        const absolute = joinDirectoryPath(expandedDirectory, entry.name);
        void onSelectEntry(absolute, entry);
      }
    },
    [directory, expandedDirectory, onNavigateFolder, onSelectEntry],
  );

  const handleActivateSearchEntry = useCallback(
    (entry: ProjectLocalSearchEntry) => {
      if (entry.kind === "directory") {
        onNavigateFolder(entry.path);
        return;
      }
      void onSelectEntry(entry.path, {
        kind: "file",
        path: entry.path,
        name: entry.name,
      });
    },
    [onNavigateFolder, onSelectEntry],
  );

  const handleActivateRow = useCallback(
    (row: VisibleRow) => {
      if (row.kind === "use-current") {
        handleSelectCurrentDirectory();
        return;
      }
      if (row.kind === "search") {
        handleActivateSearchEntry(row.entry);
        return;
      }
      handleActivateEntry(row.entry);
    },
    [handleActivateEntry, handleActivateSearchEntry, handleSelectCurrentDirectory],
  );

  const parent = parentDirectory(directory);
  const handleGoUp = useCallback(() => {
    if (parent) onNavigateFolder(parent);
  }, [onNavigateFolder, parent]);

  useImperativeHandle(
    handleRef,
    () => ({
      moveHighlight: (direction) => {
        if (visibleRows.length === 0) return;
        setHighlightedIndex((current) => {
          if (direction === "up") {
            return current <= 0 ? visibleRows.length - 1 : current - 1;
          }
          return current >= visibleRows.length - 1 ? 0 : current + 1;
        });
      },
      activateHighlighted: () => {
        const row = visibleRows[highlightedIndex];
        if (!row) return false;
        handleActivateRow(row);
        return true;
      },
    }),
    [handleActivateRow, highlightedIndex, visibleRows],
  );

  useEffect(() => {
    const node = listRef.current?.querySelector<HTMLElement>(
      `[data-highlight-index="${highlightedIndex}"]`,
    );
    node?.scrollIntoView({ block: "nearest" });
  }, [highlightedIndex]);

  const headerLabel = directory || rootLabel;
  const visibleCount = visibleRows.length;

  const entryRowStartIndex = currentFolderRow ? 1 : 0;
  const searchRowStartIndex = entryRowStartIndex + folders.length + files.length;
  const isSearchPending =
    shouldRunFuzzySearch && searchQuery.isFetching && searchRows.length === 0;

  return (
    <Command autoHighlight={false} mode="none">
      <div className="chat-composer-surface relative overflow-hidden rounded-xl border border-border/60 bg-card">
        <div className="flex items-center gap-2 border-b px-2 py-1.5">
          {parent ? (
            <button
              type="button"
              aria-label="Go up one directory"
              onMouseDown={(event) => event.preventDefault()}
              onClick={handleGoUp}
              className="inline-flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground"
            >
              <ArrowUpIcon className="size-3.5" />
            </button>
          ) : (
            <FolderClosed className="size-3.5 shrink-0 text-muted-foreground/70" />
          )}
          <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-foreground/80">
            {headerLabel}
          </span>
          {!isRootDirectory(directory) ? (
            <button
              type="button"
              onMouseDown={(event) => event.preventDefault()}
              onClick={handleSelectCurrentDirectory}
              className="shrink-0 rounded-md px-1.5 py-0.5 text-[10.5px] text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground"
            >
              Use this folder
            </button>
          ) : null}
        </div>
        <div ref={listRef}>
          <CommandList className="max-h-72 py-0.5">
            {currentFolderRow ? (
              <CommandGroup>
                <UseCurrentFolderRow
                  directoryLabel={headerLabel}
                  index={0}
                  isHighlighted={highlightedIndex === 0}
                  onHighlight={setHighlightedIndex}
                  onActivate={handleSelectCurrentDirectory}
                />
              </CommandGroup>
            ) : null}
            {currentFolderRow && (folders.length > 0 || files.length > 0) ? (
              <CommandSeparator className="my-0.5" />
            ) : null}
            {folders.length > 0 ? (
              <CommandGroup>
                {folders.map((entry, folderIndex) => {
                  const absoluteIndex = entryRowStartIndex + folderIndex;
                  return (
                    <LocalEntryRow
                      key={`dir:${entry.path}`}
                      entry={entry}
                      index={absoluteIndex}
                      isHighlighted={highlightedIndex === absoluteIndex}
                      onActivate={handleActivateEntry}
                      onHighlight={setHighlightedIndex}
                    />
                  );
                })}
              </CommandGroup>
            ) : null}
            {folders.length > 0 && files.length > 0 ? (
              <CommandSeparator className="my-0.5" />
            ) : null}
            {files.length > 0 ? (
              <CommandGroup>
                {files.map((entry, fileIndex) => {
                  const absoluteIndex = entryRowStartIndex + folders.length + fileIndex;
                  return (
                    <LocalEntryRow
                      key={`file:${entry.path}`}
                      entry={entry}
                      index={absoluteIndex}
                      isHighlighted={highlightedIndex === absoluteIndex}
                      onActivate={handleActivateEntry}
                      onHighlight={setHighlightedIndex}
                    />
                  );
                })}
              </CommandGroup>
            ) : null}
            {searchRows.length > 0 ? (
              <>
                {folders.length > 0 || files.length > 0 ? (
                  <CommandSeparator className="my-0.5" />
                ) : null}
                <CommandGroup heading="Matches deeper">
                  {searchRows.map((entry, searchIndex) => {
                    const absoluteIndex = searchRowStartIndex + searchIndex;
                    return (
                      <LocalSearchRow
                        key={`search:${entry.kind}:${entry.path}`}
                        entry={entry}
                        rootPath={expandedDirectory}
                        index={absoluteIndex}
                        isHighlighted={highlightedIndex === absoluteIndex}
                        onActivate={handleActivateSearchEntry}
                        onHighlight={setHighlightedIndex}
                      />
                    );
                  })}
                </CommandGroup>
              </>
            ) : null}
          </CommandList>
        </div>
        {isAwaitingHomeDir ? (
          <p className="px-2 py-1.5 text-muted-foreground/50 text-[11px]">
            Waiting for home directory from server…
          </p>
        ) : isLoading && visibleCount === 0 ? (
          <p className="px-2 py-1.5 text-muted-foreground/50 text-[11px]">Loading local files…</p>
        ) : errorMessage ? (
          <p className="px-2 py-1.5 text-destructive/80 text-[11px]">{errorMessage}</p>
        ) : isSearchPending ? (
          <p className="px-2 py-1.5 text-muted-foreground/50 text-[11px]">Searching nested files…</p>
        ) : visibleCount === 0 ? (
          <p className="px-2 py-1.5 text-muted-foreground/50 text-[11px]">
            {filter.trim().length > 0 ? "No matches." : "No files or folders here."}
          </p>
        ) : searchQuery.data?.truncated ? (
          <p className="px-2 py-1 text-muted-foreground/40 text-[10.5px]">
            Showing top matches. Keep typing to narrow.
          </p>
        ) : null}
      </div>
    </Command>
  );
});

const UseCurrentFolderRow = memo(function UseCurrentFolderRow(props: {
  directoryLabel: string;
  index: number;
  isHighlighted: boolean;
  onHighlight: (index: number) => void;
  onActivate: () => void;
}) {
  const { directoryLabel, index, isHighlighted, onHighlight, onActivate } = props;
  return (
    <CommandItem
      data-highlight-index={index}
      value="use-current-folder"
      className={cn(
        "cursor-pointer select-none gap-2 rounded-lg px-2 py-1 transition-colors hover:bg-accent/40",
        isHighlighted && "bg-accent/40 text-accent-foreground",
      )}
      onMouseDown={(event) => {
        event.preventDefault();
      }}
      onMouseMove={() => {
        if (!isHighlighted) onHighlight(index);
      }}
      onClick={onActivate}
    >
      <FolderClosed className="size-3.5 text-muted-foreground/60" />
      <div className="min-w-0 flex flex-1 items-center gap-1.5 overflow-hidden">
        <span className="shrink-0 text-[11.5px] font-medium text-foreground/80">
          Use this folder
        </span>
        <span className="truncate text-[11px] text-muted-foreground/55">{directoryLabel}</span>
      </div>
    </CommandItem>
  );
});

function buildSearchRowSubtitle(entry: ProjectLocalSearchEntry, rootPath: string): string {
  const parent = entry.parentPath ?? "";
  if (!parent) return "";
  if (rootPath.length > 0 && parent.startsWith(rootPath)) {
    // Strip the root prefix so long absolute paths don't eat the row; leave a leading
    // separator so the relative hop stays readable (e.g. `/src/components`).
    const relative = parent.slice(rootPath.length);
    if (relative.length === 0) return "";
    if (relative.startsWith("/") || relative.startsWith("\\")) return relative;
    return `/${relative}`;
  }
  return parent;
}

const LocalSearchRow = memo(function LocalSearchRow(props: {
  entry: ProjectLocalSearchEntry;
  rootPath: string;
  index: number;
  isHighlighted: boolean;
  onActivate: (entry: ProjectLocalSearchEntry) => void;
  onHighlight: (index: number) => void;
}) {
  const { entry, rootPath, index, isHighlighted, onActivate, onHighlight } = props;
  const isDirectory = entry.kind === "directory";
  const subtitle = buildSearchRowSubtitle(entry, rootPath);

  return (
    <CommandItem
      data-highlight-index={index}
      value={`search:${entry.kind}:${entry.path}`}
      className={cn(
        "cursor-pointer select-none gap-2 rounded-lg px-2 py-1 transition-colors hover:bg-accent/40",
        isHighlighted && "bg-accent/40 text-accent-foreground",
      )}
      onMouseDown={(event) => {
        event.preventDefault();
      }}
      onMouseMove={() => {
        if (!isHighlighted) onHighlight(index);
      }}
      onClick={() => onActivate(entry)}
    >
      {isDirectory ? (
        <FolderClosed className="size-3.5 text-muted-foreground/60" />
      ) : (
        <FileIcon className="size-3.5 text-muted-foreground/60" />
      )}
      <div className="min-w-0 flex flex-1 items-center gap-3">
        <span className="min-w-0 flex-1 truncate text-[11.5px] font-medium text-foreground/80">
          {entry.name}
        </span>
        {subtitle ? (
          <span className="shrink-0 max-w-[60%] truncate pl-2 text-right text-[10.5px] text-muted-foreground/42">
            {subtitle}
          </span>
        ) : null}
      </div>
    </CommandItem>
  );
});

const LocalEntryRow = memo(function LocalEntryRow(props: {
  entry: ProjectFileSystemEntry;
  index: number;
  isHighlighted: boolean;
  onActivate: (entry: ProjectFileSystemEntry) => void;
  onHighlight: (index: number) => void;
}) {
  const { entry, index, isHighlighted, onActivate, onHighlight } = props;
  const isDirectory = entry.kind === "directory";

  return (
    <CommandItem
      data-highlight-index={index}
      value={`${entry.kind}:${entry.path}`}
      className={cn(
        "cursor-pointer select-none gap-2 rounded-lg px-2 py-1 transition-colors hover:bg-accent/40",
        isHighlighted && "bg-accent/40 text-accent-foreground",
      )}
      onMouseDown={(event) => {
        event.preventDefault();
      }}
      onMouseMove={() => {
        if (!isHighlighted) onHighlight(index);
      }}
      onClick={() => onActivate(entry)}
    >
      {isDirectory ? (
        <FolderClosed className="size-3.5 text-muted-foreground/60" />
      ) : (
        <FileIcon className="size-3.5 text-muted-foreground/60" />
      )}
      <div className="min-w-0 flex flex-1 items-center gap-1.5 overflow-hidden">
        <span className="truncate text-[11.5px] font-medium text-foreground/80">{entry.name}</span>
      </div>
    </CommandItem>
  );
});
