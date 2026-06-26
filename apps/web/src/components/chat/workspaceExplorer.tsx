// FILE: workspaceExplorer.tsx
// Purpose: Shared workspace file-tree explorer + file-search building blocks used
//          by both the full editor view and the right-dock explorer pane.
// Layer: Chat workspace-browsing UI primitives
// Exports: WorkspaceFilesSidebar, WorkspaceSearchSidebar, ExplorerActivityBarButton,
//          useExplorerEntryPrefetch, setFileReferenceDragData.

import type { ProjectEntry, ProjectFileSystemEntry } from "@t3tools/contracts";
import { useDebouncedValue } from "@tanstack/react-pacer";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type ComponentPropsWithoutRef,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  forwardRef,
  useCallback,
} from "react";

import {
  CHAT_FILE_REFERENCE_DRAG_TYPE,
  formatChatFileReference,
  type ChatFileReference,
} from "~/lib/chatReferences";
import { splitRepoRelativePath } from "~/lib/diffRendering";
import { showFileReferenceContextMenu } from "~/lib/fileReferenceContextMenu";
import {
  projectListDirectoriesQueryOptions,
  projectReadFileQueryOptions,
  projectSearchEntriesQueryOptions,
} from "~/lib/projectReactQuery";
import { getSyntaxHighlighterPromise, getSyntaxLanguageForPath } from "~/lib/syntaxHighlighting";
import { cn } from "~/lib/utils";
import { Skeleton } from "../ui/skeleton";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { DisclosureChevron } from "../ui/DisclosureChevron";
import { SearchInput } from "../ui/search-input";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { FileEntryIcon } from "./FileEntryIcon";
import { fileRowClassName, fileRowIndentStyle } from "./fileRowStyles";
import { PanelStateMessage } from "./PanelStateMessage";

const EXPLORER_HIDDEN_DIRECTORY_NAMES = new Set([
  ".cache",
  ".next",
  ".nuxt",
  ".parcel-cache",
  ".pnpm-store",
  ".svelte-kit",
  ".turbo",
  ".vite",
  ".yarn",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "target",
]);

// Mirrors the composer mention search: debounce keystrokes so they don't fan
// out into fuzzy-search RPCs, and cap results to keep the sidebar light.
const EXPLORER_SEARCH_QUERY_DEBOUNCE_MS = 120;
const EXPLORER_SEARCH_RESULTS_LIMIT = 80;
const EMPTY_WORKSPACE_SEARCH_FILE_MATCHES: ReadonlyArray<ProjectEntry> = [];

// Default sidebar shell: a full-height column in the editor's wide row layout
// that collapses to a stacked block on narrow viewports. Surfaces with a fixed
// horizontal layout (e.g. the right dock) override this via `containerClassName`.
const EXPLORER_SIDEBAR_CONTAINER_CLASS =
  "flex min-h-[11rem] w-full shrink-0 flex-col border-b border-border/65 bg-[var(--color-background-surface)] lg:h-full lg:w-56 lg:border-b-0 lg:border-r";

// Marks the drag payload so the chat composer can accept it as a reference.
export function setFileReferenceDragData(dataTransfer: DataTransfer, path: string): void {
  dataTransfer.effectAllowed = "copy";
  dataTransfer.setData(CHAT_FILE_REFERENCE_DRAG_TYPE, formatChatFileReference({ path }));
  dataTransfer.setData("text/plain", path);
}

function shouldShowExplorerEntry(entry: ProjectFileSystemEntry): boolean {
  if (entry.kind !== "directory") {
    return true;
  }
  if (entry.name.startsWith(".synara")) {
    return false;
  }
  return !EXPLORER_HIDDEN_DIRECTORY_NAMES.has(entry.name);
}

/**
 * Warms caches for an explorer entry before it is clicked: directory listings
 * for folders, file contents plus the matching syntax highlighter for files.
 */
export function useExplorerEntryPrefetch(cwd: string | null) {
  const queryClient = useQueryClient();
  return useCallback(
    (entry: Pick<ProjectFileSystemEntry, "path" | "kind">) => {
      if (!cwd) {
        return;
      }
      if (entry.kind === "directory") {
        void queryClient.prefetchQuery(
          projectListDirectoriesQueryOptions({
            cwd,
            relativePath: entry.path,
            includeFiles: true,
          }),
        );
        return;
      }
      void queryClient.prefetchQuery(
        projectReadFileQueryOptions({ cwd, relativePath: entry.path }),
      );
      void getSyntaxHighlighterPromise(getSyntaxLanguageForPath(entry.path)).catch(() => undefined);
    },
    [cwd, queryClient],
  );
}

// Forwards its ref and spreads incoming props so directory rows can act as the
// Collapsible trigger (Base UI injects onClick/aria/data + ref onto this element).
const ExplorerRow = forwardRef<
  HTMLButtonElement,
  {
    entry: ProjectFileSystemEntry;
    depth: number;
    selected: boolean;
    expanded: boolean;
    onSelectFile: (path: string) => void;
    onPrefetchEntry: (entry: ProjectFileSystemEntry) => void;
    onEntryContextMenu: (entry: ProjectFileSystemEntry, position: { x: number; y: number }) => void;
  } & ComponentPropsWithoutRef<"button">
>(function ExplorerRow(
  {
    entry,
    depth,
    selected,
    expanded,
    onSelectFile,
    onPrefetchEntry,
    onEntryContextMenu,
    className,
    onClick,
    ...rest
  },
  ref,
) {
  const isDirectory = entry.kind === "directory";
  // Directory rows are the Collapsible trigger: chain Base UI's injected onClick
  // (which toggles open/close) and skip file selection. File rows open the preview.
  const handleClick = useCallback(
    (event: ReactMouseEvent<HTMLButtonElement>) => {
      onClick?.(event);
      if (isDirectory) {
        return;
      }
      onSelectFile(entry.path);
    },
    [entry.path, isDirectory, onClick, onSelectFile],
  );
  const handlePrefetch = useCallback(() => {
    onPrefetchEntry(entry);
  }, [entry, onPrefetchEntry]);
  const handleContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      onEntryContextMenu(entry, { x: event.clientX, y: event.clientY });
    },
    [entry, onEntryContextMenu],
  );
  const handleDragStart = useCallback(
    (event: ReactDragEvent<HTMLButtonElement>) => {
      setFileReferenceDragData(event.dataTransfer, entry.path);
    },
    [entry.path],
  );

  return (
    <button
      {...rest}
      ref={ref}
      type="button"
      className={fileRowClassName(selected, cn("h-7 pr-2", className))}
      style={fileRowIndentStyle(depth)}
      title={entry.path}
      draggable
      onDragStart={handleDragStart}
      onClick={handleClick}
      onPointerEnter={handlePrefetch}
      onFocus={handlePrefetch}
      onContextMenu={handleContextMenu}
    >
      {isDirectory ? (
        <DisclosureChevron open={expanded} className="opacity-75" />
      ) : (
        <FileEntryIcon
          pathValue={entry.path}
          kind={entry.kind}
          className="size-3.5 shrink-0 opacity-75"
        />
      )}
      <span className="min-w-0 truncate">{entry.name}</span>
    </button>
  );
});

const EXPLORER_SKELETON_ROW_WIDTHS = ["w-9/12", "w-6/12", "w-7/12"];

function ExplorerLoadingRows(props: { depth: number }) {
  return (
    <div
      className="space-y-1.5 py-1.5 pr-2"
      style={fileRowIndentStyle(props.depth)}
      role="status"
      aria-label="Loading directory..."
    >
      {EXPLORER_SKELETON_ROW_WIDTHS.map((width) => (
        <div key={width} className="flex h-5 items-center gap-1.5">
          <Skeleton className="size-3.5 shrink-0 rounded-sm" />
          <Skeleton className={cn("h-3 rounded-full", width)} />
        </div>
      ))}
    </div>
  );
}

function WorkspaceDirectory(props: {
  cwd: string;
  relativePath: string | null;
  depth: number;
  selectedFilePath: string | null;
  expandedDirectories: ReadonlySet<string>;
  onSelectFile: (path: string) => void;
  onToggleDirectory: (path: string) => void;
  onPrefetchEntry: (entry: ProjectFileSystemEntry) => void;
  onEntryContextMenu: (entry: ProjectFileSystemEntry, position: { x: number; y: number }) => void;
}) {
  const query = useQuery(
    projectListDirectoriesQueryOptions({
      cwd: props.cwd,
      relativePath: props.relativePath,
      includeFiles: true,
    }),
  );

  if (query.isLoading && !query.data) {
    return <ExplorerLoadingRows depth={props.depth} />;
  }

  if (query.error) {
    return (
      <p className="px-3 py-2 text-[11px] text-destructive/80">
        {query.error instanceof Error ? query.error.message : "Could not load directory."}
      </p>
    );
  }

  return (
    <>
      {(query.data?.entries ?? []).filter(shouldShowExplorerEntry).map((entry) => {
        if (entry.kind !== "directory") {
          return (
            <ExplorerRow
              key={entry.path}
              entry={entry}
              depth={props.depth}
              selected={entry.path === props.selectedFilePath}
              expanded={false}
              onSelectFile={props.onSelectFile}
              onPrefetchEntry={props.onPrefetchEntry}
              onEntryContextMenu={props.onEntryContextMenu}
            />
          );
        }
        const expanded = props.expandedDirectories.has(entry.path);
        return (
          <Collapsible
            key={entry.path}
            open={expanded}
            onOpenChange={() => props.onToggleDirectory(entry.path)}
          >
            <CollapsibleTrigger
              render={
                <ExplorerRow
                  entry={entry}
                  depth={props.depth}
                  selected={false}
                  expanded={expanded}
                  onSelectFile={props.onSelectFile}
                  onPrefetchEntry={props.onPrefetchEntry}
                  onEntryContextMenu={props.onEntryContextMenu}
                />
              }
            />
            {/* Keep children mounted only while open (plus the closing transition Base UI
                manages) so the height animation plays and lazy listings stay cached. */}
            <CollapsiblePanel>
              <WorkspaceDirectory
                cwd={props.cwd}
                relativePath={entry.path}
                depth={props.depth + 1}
                selectedFilePath={props.selectedFilePath}
                expandedDirectories={props.expandedDirectories}
                onSelectFile={props.onSelectFile}
                onToggleDirectory={props.onToggleDirectory}
                onPrefetchEntry={props.onPrefetchEntry}
                onEntryContextMenu={props.onEntryContextMenu}
              />
            </CollapsiblePanel>
          </Collapsible>
        );
      })}
    </>
  );
}

export function WorkspaceFilesSidebar(props: {
  workspaceRoot: string | null;
  selectedFilePath: string | null;
  expandedDirectories: ReadonlySet<string>;
  containerClassName?: string;
  onSelectFile: (path: string) => void;
  onToggleDirectory: (path: string) => void;
  onReferenceInChat: ((reference: ChatFileReference) => void) | undefined;
}) {
  const prefetchEntry = useExplorerEntryPrefetch(props.workspaceRoot);
  const { onReferenceInChat } = props;
  const handleEntryContextMenu = useCallback(
    (entry: ProjectFileSystemEntry, position: { x: number; y: number }) => {
      void showFileReferenceContextMenu({ path: entry.path, position, onReferenceInChat });
    },
    [onReferenceInChat],
  );
  return (
    <aside className={props.containerClassName ?? EXPLORER_SIDEBAR_CONTAINER_CLASS}>
      <div className="min-h-0 flex-1 overflow-auto px-1 py-1">
        {props.workspaceRoot ? (
          <WorkspaceDirectory
            cwd={props.workspaceRoot}
            relativePath={null}
            depth={0}
            selectedFilePath={props.selectedFilePath}
            expandedDirectories={props.expandedDirectories}
            onSelectFile={props.onSelectFile}
            onToggleDirectory={props.onToggleDirectory}
            onPrefetchEntry={prefetchEntry}
            onEntryContextMenu={handleEntryContextMenu}
          />
        ) : (
          <PanelStateMessage density="compact" fill="flex">
            <p>No workspace.</p>
          </PanelStateMessage>
        )}
      </div>
    </aside>
  );
}

function WorkspaceSearchResultRow(props: {
  entry: ProjectEntry;
  selected: boolean;
  onSelectFile: (path: string) => void;
  onPrefetchEntry: (entry: Pick<ProjectFileSystemEntry, "path" | "kind">) => void;
  onEntryContextMenu: (path: string, position: { x: number; y: number }) => void;
}) {
  const { entry, onEntryContextMenu, onPrefetchEntry, onSelectFile } = props;
  const { dir, name } = splitRepoRelativePath(entry.path);
  const handlePrefetch = useCallback(() => {
    onPrefetchEntry(entry);
  }, [entry, onPrefetchEntry]);

  return (
    <button
      type="button"
      className={fileRowClassName(props.selected, "h-8 px-2")}
      title={entry.path}
      draggable
      onDragStart={(event) => {
        setFileReferenceDragData(event.dataTransfer, entry.path);
      }}
      onClick={() => onSelectFile(entry.path)}
      onPointerEnter={handlePrefetch}
      onFocus={handlePrefetch}
      onContextMenu={(event) => {
        event.preventDefault();
        onEntryContextMenu(entry.path, { x: event.clientX, y: event.clientY });
      }}
    >
      <FileEntryIcon pathValue={entry.path} kind="file" className="size-3.5 shrink-0 opacity-75" />
      <div className="flex min-w-0 flex-1 items-baseline gap-1.5 overflow-hidden">
        <span className="shrink-0 truncate font-medium">{name}</span>
        {dir ? (
          <span className="min-w-0 truncate text-[11px] text-muted-foreground/55">{dir}</span>
        ) : null}
      </div>
    </button>
  );
}

export function WorkspaceSearchSidebar(props: {
  workspaceRoot: string | null;
  query: string;
  onQueryChange: (query: string) => void;
  selectedFilePath: string | null;
  containerClassName?: string;
  onSelectFile: (path: string) => void;
  onReferenceInChat: ((reference: ChatFileReference) => void) | undefined;
}) {
  const prefetchEntry = useExplorerEntryPrefetch(props.workspaceRoot);
  const { onQueryChange, onReferenceInChat, onSelectFile } = props;
  const handleEntryContextMenu = useCallback(
    (path: string, position: { x: number; y: number }) => {
      void showFileReferenceContextMenu({ path, position, onReferenceInChat });
    },
    [onReferenceInChat],
  );
  const [debouncedQuery] = useDebouncedValue(props.query, {
    wait: EXPLORER_SEARCH_QUERY_DEBOUNCE_MS,
  });
  const inputQuery = props.query.trim();
  const trimmedQuery = debouncedQuery.trim();
  const entriesQuery = useQuery(
    projectSearchEntriesQueryOptions({
      cwd: props.workspaceRoot,
      query: trimmedQuery,
      kind: "file",
      limit: EXPLORER_SEARCH_RESULTS_LIMIT,
    }),
  );
  // Results are tied to the debounced query. While the user is ahead of that
  // query, keep old results non-selectable so Enter cannot open a stale match.
  const searchResultsPending = inputQuery !== trimmedQuery || entriesQuery.isPlaceholderData;
  const searchResultsCurrent = !searchResultsPending;
  const fileMatches = searchResultsCurrent
    ? (entriesQuery.data?.entries ?? EMPTY_WORKSPACE_SEARCH_FILE_MATCHES)
    : EMPTY_WORKSPACE_SEARCH_FILE_MATCHES;
  const handleInputKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Enter") {
        event.preventDefault();
        if (!searchResultsCurrent) {
          return;
        }
        const topMatch = fileMatches[0];
        if (topMatch) {
          onSelectFile(topMatch.path);
        }
        return;
      }
      if (event.key === "Escape" && props.query.length > 0) {
        event.stopPropagation();
        onQueryChange("");
      }
    },
    [fileMatches, onQueryChange, onSelectFile, props.query.length, searchResultsCurrent],
  );

  return (
    <aside className={props.containerClassName ?? EXPLORER_SIDEBAR_CONTAINER_CLASS}>
      <div className="shrink-0 border-b border-border/65 p-2">
        <SearchInput
          value={props.query}
          autoFocus
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          placeholder="Search files..."
          aria-label="Search files"
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={handleInputKeyDown}
        />
      </div>
      <div
        className={cn(
          "min-h-0 flex-1 overflow-auto px-1 py-1",
          fileMatches.length === 0 && "flex flex-col",
        )}
      >
        {!props.workspaceRoot ? (
          <PanelStateMessage density="compact" fill="flex">
            <p>No workspace.</p>
          </PanelStateMessage>
        ) : inputQuery.length === 0 ? (
          <PanelStateMessage density="compact" fill="flex">
            <p>Search files by name or path.</p>
          </PanelStateMessage>
        ) : searchResultsCurrent && entriesQuery.error ? (
          <PanelStateMessage density="compact" fill="flex">
            <p className="text-destructive/85">
              {entriesQuery.error instanceof Error
                ? entriesQuery.error.message
                : "Could not search files."}
            </p>
          </PanelStateMessage>
        ) : fileMatches.length === 0 ? (
          searchResultsPending || entriesQuery.isFetching ? (
            <ExplorerLoadingRows depth={0} />
          ) : (
            <PanelStateMessage density="compact" fill="flex">
              <p>No matching files.</p>
            </PanelStateMessage>
          )
        ) : (
          fileMatches.map((entry) => (
            <WorkspaceSearchResultRow
              key={entry.path}
              entry={entry}
              selected={entry.path === props.selectedFilePath}
              onSelectFile={onSelectFile}
              onPrefetchEntry={prefetchEntry}
              onEntryContextMenu={handleEntryContextMenu}
            />
          ))
        )}
      </div>
      {fileMatches.length > 0 && entriesQuery.data?.truncated ? (
        <p className="shrink-0 border-t border-border/45 px-3 py-1.5 text-[10px] text-muted-foreground/70">
          Showing the top matches. Refine the search to narrow them down.
        </p>
      ) : null}
    </aside>
  );
}

export function ExplorerActivityBarButton(props: {
  label: string;
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  const button = (
    <button
      type="button"
      className={cn(
        "relative flex h-12 w-full cursor-pointer items-center justify-center text-muted-foreground/72 transition-colors hover:bg-[var(--color-background-button-secondary-hover)] hover:text-foreground",
        props.active && "bg-[var(--color-background-button-secondary)] text-foreground",
      )}
      aria-label={props.label}
      aria-pressed={props.active}
      title={props.label}
      onClick={props.onClick}
    >
      <span
        className={cn(
          "absolute left-0 top-1/2 h-6 w-0.5 -translate-y-1/2 rounded-r-full bg-transparent",
          props.active && "bg-foreground/85",
        )}
        aria-hidden="true"
      />
      {props.children}
    </button>
  );

  return (
    <Tooltip>
      <TooltipTrigger render={button} />
      <TooltipPopup side="right">{props.label}</TooltipPopup>
    </Tooltip>
  );
}
