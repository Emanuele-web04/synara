// FILE: EditorWorkspaceView.tsx
// Purpose: Read-only editor-style thread surface with file explorer, workspace
//          file search, file/diff preview, and chat.
// Layer: Chat route presentation

import type { ProjectEntry, ProjectFileSystemEntry, ProjectId } from "@t3tools/contracts";
import type { FileDiffMetadata } from "@pierre/diffs/react";
import { isSupportedLocalImagePath } from "@t3tools/shared/localImage";
import { useDebouncedValue } from "@tanstack/react-pacer";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Component,
  Suspense,
  type ComponentPropsWithoutRef,
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  forwardRef,
  memo,
  use,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  ChangesIcon,
  ChatBubbleIcon,
  ChevronDownIcon,
  DiffIcon,
  EyeIcon,
  FileIcon,
  PanelRightCloseIcon,
  SearchIcon,
} from "~/lib/icons";
import { basenameOfPath } from "~/file-icons";
import {
  useDesktopTopBarTrafficLightGutterClassName,
  useDesktopTopBarWindowControlsGutterClassName,
} from "~/hooks/useDesktopTopBarGutter";
import {
  buildFileDiffRenderKey,
  resolveDiffThemeName,
  resolveFileDiffPath,
  splitRepoRelativePath,
  summarizeFileDiffStats,
  type DiffThemeName,
} from "~/lib/diffRendering";
import {
  projectListDirectoriesQueryOptions,
  projectReadFileQueryOptions,
  projectSearchEntriesQueryOptions,
} from "~/lib/projectReactQuery";
import {
  CHAT_FILE_REFERENCE_DRAG_TYPE,
  formatChatFileReference,
  formatSelectionLabel,
  getSelectionWithin,
  type ChatFileReference,
  type SelectionWithin,
} from "~/lib/chatReferences";
import {
  MAX_SYNTAX_HIGHLIGHT_INPUT_CHARS,
  cacheSyntaxHighlightedHtml,
  createSyntaxHighlightCacheKey,
  getCachedSyntaxHighlightedHtml,
  getSyntaxHighlighterPromise,
  getSyntaxLanguageForPath,
  highlightCodeToHtmlWithFallback,
} from "~/lib/syntaxHighlighting";
import { readNativeApi } from "~/nativeApi";
import { cn } from "~/lib/utils";
import { useTheme } from "~/hooks/useTheme";
import ChatMarkdown from "./ChatMarkdown";
import { Skeleton } from "./ui/skeleton";
import {
  ChatHeaderButton,
  ChatHeaderIconButton,
  CHAT_SURFACE_HEADER_DIVIDER_CLASS_NAME,
  CHAT_SURFACE_HEADER_HEIGHT_CLASS,
} from "./chat/chatHeaderControls";
import { FileEntryIcon } from "./chat/FileEntryIcon";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "./ui/collapsible";
import { DisclosureChevron } from "./ui/DisclosureChevron";
import { DiffStat } from "./chat/DiffStatLabel";
import { PanelStateMessage } from "./chat/PanelStateMessage";
import { TranscriptSelectionAction } from "./chat/TranscriptSelectionAction";
import { useCodeSelectionAction } from "./chat/useCodeSelectionAction";
import { LocalImagePreview } from "./LocalImagePreview";
import { ProjectMenuPicker, type ProjectMenuPickerOption } from "./ProjectMenuPicker";
import { SearchInput } from "./ui/search-input";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

type EditorCenterMode = "file" | "diff";
type EditorActivityBarItem = EditorCenterMode | "search";

const EDITOR_EXPLORER_HIDDEN_DIRECTORY_NAMES = new Set([
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

const EDITOR_CHAT_PANE_STORAGE_KEY = "synara.editor.chatPaneWidth";
const EDITOR_SIDEBAR_VISIBLE_STORAGE_KEY = "synara.editor.sidebarVisible";
const EDITOR_CHAT_PANE_VISIBLE_STORAGE_KEY = "synara.editor.chatPaneVisible";
const EDITOR_CHAT_PANE_DEFAULT_WIDTH = 384;
const EDITOR_CHAT_PANE_MIN_WIDTH = 320;
const EDITOR_CHAT_PANE_MAX_WIDTH = 600;
const EDITOR_CHAT_PANE_KEYBOARD_STEP = 24;
const EDITOR_MARKDOWN_PREVIEW_EXTENSIONS = new Set([".markdown", ".md", ".mdx"]);
// Mirrors the composer mention search: debounce keystrokes so they don't fan
// out into fuzzy-search RPCs, and cap results to keep the sidebar light.
const EDITOR_SEARCH_QUERY_DEBOUNCE_MS = 120;
const EDITOR_SEARCH_RESULTS_LIMIT = 80;
const EMPTY_WORKSPACE_SEARCH_FILE_MATCHES: ReadonlyArray<ProjectEntry> = [];

interface EditorWorkspaceViewProps {
  workspaceRoot: string | null;
  projectName: string | null;
  currentProjectId?: ProjectId | null;
  projectOptions?: ReadonlyArray<ProjectMenuPickerOption>;
  selectedFilePath: string | null;
  expandedDirectories: ReadonlySet<string>;
  centerMode: EditorCenterMode;
  diffFiles: ReadonlyArray<FileDiffMetadata>;
  diffFilesLoading?: boolean;
  selectedDiffFilePath: string | null;
  diffOptionsControl?: ReactNode;
  diffPanel: ReactNode;
  chatPanel: ReactNode;
  onSelectFile: (path: string) => void;
  onSelectDiffFile: (path: string) => void;
  onToggleDirectory: (path: string) => void;
  onCenterModeChange: (mode: EditorCenterMode) => void;
  onExitEditorView: () => void;
  onReferenceInChat?: (reference: ChatFileReference) => void;
  onAskWhyInChat?: (reference: ChatFileReference) => void;
  onSelectProject?: (projectId: ProjectId) => void;
}

// Marks the drag payload so the chat composer can accept it as a reference.
function setFileReferenceDragData(dataTransfer: DataTransfer, path: string): void {
  dataTransfer.effectAllowed = "copy";
  dataTransfer.setData(CHAT_FILE_REFERENCE_DRAG_TYPE, formatChatFileReference({ path }));
  dataTransfer.setData("text/plain", path);
}

// Right-click menu shared by explorer rows, changed-file rows, and the file
// preview. Falls back to a DOM menu outside the desktop app.
async function showFileReferenceContextMenu(input: {
  path: string;
  position: { x: number; y: number };
  selection?: SelectionWithin | null;
  onReferenceInChat: ((reference: ChatFileReference) => void) | undefined;
  onAskWhyInChat?: ((reference: ChatFileReference) => void) | undefined;
}): Promise<void> {
  const api = readNativeApi();
  if (!api) {
    return;
  }
  const reference: ChatFileReference = {
    path: input.path,
    ...(input.selection ?? {}),
  };
  const rangeLabel = formatSelectionLabel(reference);
  const clicked = await api.contextMenu.show(
    [
      ...(input.onReferenceInChat
        ? [
            {
              id: "reference-in-chat" as const,
              label: rangeLabel ? `Reference ${rangeLabel} in chat` : "Reference in chat",
            },
          ]
        : []),
      ...(input.onAskWhyInChat
        ? [
            {
              id: "ask-why-in-chat" as const,
              label: rangeLabel ? `Ask why ${rangeLabel} changed` : "Ask why this changed",
            },
          ]
        : []),
      { id: "copy-path" as const, label: "Copy path" },
    ],
    input.position,
  );
  if (clicked === "reference-in-chat") {
    input.onReferenceInChat?.(reference);
    return;
  }
  if (clicked === "ask-why-in-chat") {
    input.onAskWhyInChat?.(reference);
    return;
  }
  if (clicked === "copy-path") {
    void navigator.clipboard?.writeText(input.path);
  }
}

function clampEditorChatPaneWidth(width: number): number {
  return Math.min(
    EDITOR_CHAT_PANE_MAX_WIDTH,
    Math.max(EDITOR_CHAT_PANE_MIN_WIDTH, Math.round(width)),
  );
}

function readStoredEditorChatPaneWidth(): number {
  if (typeof window === "undefined") {
    return EDITOR_CHAT_PANE_DEFAULT_WIDTH;
  }

  try {
    const rawValue = window.localStorage.getItem(EDITOR_CHAT_PANE_STORAGE_KEY);
    const parsed = rawValue === null ? Number.NaN : Number.parseFloat(rawValue);
    return Number.isFinite(parsed)
      ? clampEditorChatPaneWidth(parsed)
      : EDITOR_CHAT_PANE_DEFAULT_WIDTH;
  } catch {
    return EDITOR_CHAT_PANE_DEFAULT_WIDTH;
  }
}

function storeEditorChatPaneWidth(width: number): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(
      EDITOR_CHAT_PANE_STORAGE_KEY,
      String(clampEditorChatPaneWidth(width)),
    );
  } catch {
    // Best-effort preference persistence only.
  }
}

function readStoredEditorVisibility(key: string): boolean {
  if (typeof window === "undefined") {
    return true;
  }
  try {
    return window.localStorage.getItem(key) !== "false";
  } catch {
    return true;
  }
}

function storeEditorVisibility(key: string, visible: boolean): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(key, String(visible));
  } catch {
    // Best-effort preference persistence only.
  }
}

interface EditorChatPaneResizeState {
  pointerId: number;
  startX: number;
  startWidth: number;
  pendingWidth: number;
  rafId: number | null;
  restoreBodyCursor: string;
  restoreBodyUserSelect: string;
  onPointerMove: (event: PointerEvent) => void;
  onPointerEnd: (event: PointerEvent) => void;
}

function fileNameFromPath(path: string): string {
  return path.split("/").filter(Boolean).at(-1) ?? path;
}

function parentDirectoryFromPath(path: string): string | null {
  const normalized = path.replace(/\\/g, "/");
  const separatorIndex = normalized.lastIndexOf("/");
  if (separatorIndex <= 0) {
    return null;
  }
  return normalized.slice(0, separatorIndex);
}

function joinWorkspaceRelativeDirectory(workspaceRoot: string, relativeDirectory: string): string {
  const separator = workspaceRoot.includes("\\") ? "\\" : "/";
  const normalizedRoot = workspaceRoot.replace(/[\\/]+$/, "");
  const normalizedRelativeDirectory = relativeDirectory.split("/").join(separator);
  return `${normalizedRoot}${separator}${normalizedRelativeDirectory}`;
}

function markdownPreviewCwd(workspaceRoot: string | null, filePath: string): string | undefined {
  if (!workspaceRoot) {
    return undefined;
  }
  const parentDirectory = parentDirectoryFromPath(filePath);
  if (!parentDirectory) {
    return workspaceRoot;
  }
  return joinWorkspaceRelativeDirectory(workspaceRoot, parentDirectory);
}

function shouldShowExplorerEntry(entry: ProjectFileSystemEntry): boolean {
  if (entry.kind !== "directory") {
    return true;
  }
  if (entry.name.startsWith(".synara")) {
    return false;
  }
  return !EDITOR_EXPLORER_HIDDEN_DIRECTORY_NAMES.has(entry.name);
}

/**
 * Warms caches for an explorer entry before it is clicked: directory listings
 * for folders, file contents plus the matching syntax highlighter for files.
 */
function useExplorerEntryPrefetch(cwd: string | null) {
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
      className={cn(
        "flex h-7 w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-md pr-2 text-left text-[12px] transition-colors",
        selected
          ? "bg-[var(--color-background-button-secondary)] text-foreground"
          : "text-foreground/78 hover:bg-[var(--color-background-button-secondary-hover)] hover:text-foreground",
        className,
      )}
      style={{ paddingLeft: `${0.5 + depth * 0.75}rem` }}
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
      style={{ paddingLeft: `${0.5 + props.depth * 0.75}rem` }}
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

function DiffFileRow(props: {
  fileDiff: FileDiffMetadata;
  selected: boolean;
  resolvedTheme: "light" | "dark";
  onSelectFile: (path: string) => void;
  onFileContextMenu: (filePath: string, position: { x: number; y: number }) => void;
}) {
  const filePath = resolveFileDiffPath(props.fileDiff);
  const { dir, name } = splitRepoRelativePath(filePath);
  const stat = useMemo(() => summarizeFileDiffStats([props.fileDiff]), [props.fileDiff]);

  return (
    <button
      type="button"
      className={cn(
        "flex h-8 w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-md px-2 text-left text-[12px] transition-colors",
        props.selected
          ? "bg-[var(--color-background-button-secondary)] text-foreground"
          : "text-foreground/78 hover:bg-[var(--color-background-button-secondary-hover)] hover:text-foreground",
      )}
      title={filePath}
      draggable
      onDragStart={(event) => {
        setFileReferenceDragData(event.dataTransfer, filePath);
      }}
      onClick={() => props.onSelectFile(filePath)}
      onContextMenu={(event) => {
        event.preventDefault();
        props.onFileContextMenu(filePath, { x: event.clientX, y: event.clientY });
      }}
    >
      <FileEntryIcon
        pathValue={filePath}
        kind="file"
        theme={props.resolvedTheme}
        className="size-3.5 shrink-0"
      />
      <div className="min-w-0 flex-1 overflow-hidden">
        <div className="flex min-w-0 items-baseline gap-1.5 overflow-hidden">
          <span className="shrink-0 truncate font-medium">{name}</span>
          {dir ? (
            <span className="min-w-0 truncate text-[11px] text-muted-foreground/55">{dir}</span>
          ) : null}
        </div>
      </div>
      <DiffStat
        additions={stat.additions}
        deletions={stat.deletions}
        className="shrink-0 text-[10px] tabular-nums"
      />
    </button>
  );
}

const DIFF_FILE_SKELETON_ROW_WIDTHS = ["w-10/12", "w-7/12", "w-9/12", "w-6/12", "w-8/12"];

function DiffFilesLoadingRows() {
  return (
    <div className="space-y-1 px-1 py-1" role="status" aria-label="Loading changed files...">
      {DIFF_FILE_SKELETON_ROW_WIDTHS.map((width) => (
        <div key={width} className="flex h-8 items-center gap-1.5 px-2">
          <Skeleton className="size-3.5 shrink-0 rounded-sm" />
          <Skeleton className={cn("h-3 rounded-full", width)} />
          <Skeleton className="ml-auto h-3 w-9 shrink-0 rounded-full" />
        </div>
      ))}
    </div>
  );
}

function DiffFilesSidebar(props: {
  files: ReadonlyArray<FileDiffMetadata>;
  isLoading: boolean;
  selectedFilePath: string | null;
  optionsControl?: ReactNode;
  onSelectFile: (path: string) => void;
  onReferenceInChat: ((reference: ChatFileReference) => void) | undefined;
  onAskWhyInChat: ((reference: ChatFileReference) => void) | undefined;
}) {
  const { resolvedTheme } = useTheme();
  const { onAskWhyInChat, onReferenceInChat } = props;
  const totals = useMemo(() => summarizeFileDiffStats(props.files), [props.files]);
  const hasDiffStats = totals.additions > 0 || totals.deletions > 0;
  const showLoadingRows = props.isLoading && props.files.length === 0;
  const handleFileContextMenu = useCallback(
    (filePath: string, position: { x: number; y: number }) => {
      void showFileReferenceContextMenu({
        path: filePath,
        position,
        onReferenceInChat,
        onAskWhyInChat,
      });
    },
    [onAskWhyInChat, onReferenceInChat],
  );

  return (
    <aside className="flex min-h-[11rem] w-full shrink-0 flex-col border-b border-border/65 bg-[var(--color-background-surface)] lg:h-full lg:w-56 lg:border-b-0 lg:border-r">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border/65 px-3">
        <DiffIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-foreground/86">
          Changed files
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {props.files.length > 0 ? (
            <span className="rounded-full bg-muted px-1.5 text-[10px] font-medium text-muted-foreground tabular-nums">
              {props.files.length}
            </span>
          ) : null}
          {props.optionsControl}
        </div>
      </div>
      {hasDiffStats ? (
        <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border/45 px-3">
          <DiffStat
            additions={totals.additions}
            deletions={totals.deletions}
            className="text-[11px] tabular-nums"
          />
        </div>
      ) : null}
      <div
        className={cn(
          "min-h-0 flex-1 overflow-auto px-1 py-1",
          !showLoadingRows && props.files.length === 0 && "flex flex-col",
        )}
      >
        {showLoadingRows ? (
          <DiffFilesLoadingRows />
        ) : props.files.length === 0 ? (
          <PanelStateMessage density="compact" fill="flex">
            <p>No files in this diff.</p>
          </PanelStateMessage>
        ) : (
          props.files.map((fileDiff) => {
            const filePath = resolveFileDiffPath(fileDiff);
            return (
              <DiffFileRow
                key={buildFileDiffRenderKey(fileDiff)}
                fileDiff={fileDiff}
                resolvedTheme={resolvedTheme}
                selected={props.selectedFilePath === filePath}
                onSelectFile={props.onSelectFile}
                onFileContextMenu={handleFileContextMenu}
              />
            );
          })
        )}
      </div>
    </aside>
  );
}

function WorkspaceFilesSidebar(props: {
  workspaceRoot: string | null;
  selectedFilePath: string | null;
  expandedDirectories: ReadonlySet<string>;
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
    <aside className="flex min-h-[11rem] w-full shrink-0 flex-col border-b border-border/65 bg-[var(--color-background-surface)] lg:h-full lg:w-56 lg:border-b-0 lg:border-r">
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
      className={cn(
        "flex h-8 w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-md px-2 text-left text-[12px] transition-colors",
        props.selected
          ? "bg-[var(--color-background-button-secondary)] text-foreground"
          : "text-foreground/78 hover:bg-[var(--color-background-button-secondary-hover)] hover:text-foreground",
      )}
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
    wait: EDITOR_SEARCH_QUERY_DEBOUNCE_MS,
  });
  const inputQuery = props.query.trim();
  const trimmedQuery = debouncedQuery.trim();
  const entriesQuery = useQuery(
    projectSearchEntriesQueryOptions({
      cwd: props.workspaceRoot,
      query: trimmedQuery,
      kind: "file",
      limit: EDITOR_SEARCH_RESULTS_LIMIT,
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
    <aside className="flex min-h-[11rem] w-full shrink-0 flex-col border-b border-border/65 bg-[var(--color-background-surface)] lg:h-full lg:w-56 lg:border-b-0 lg:border-r">
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

class FilePreviewHighlightErrorBoundary extends Component<
  { fallback: ReactNode; children: ReactNode },
  { hasError: boolean }
> {
  constructor(props: { fallback: ReactNode; children: ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  override render() {
    if (this.state.hasError) {
      return this.props.fallback;
    }
    return this.props.children;
  }
}

// Above this the plain fallback skips per-line spans (and therefore line
// numbers) to keep the DOM small for huge files.
const MAX_PLAIN_NUMBERED_LINES = 20_000;

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function PlainFileContents(props: { contents: string }) {
  // Wrap each line in a .line span (mirroring Shiki output) so the CSS
  // counter gutter applies. Built as an HTML string to avoid per-line React
  // nodes; the trailing \n stays inside each span so selection math and
  // clipboard copies keep working.
  const numberedHtml = useMemo(() => {
    if (props.contents.length === 0) {
      return null;
    }
    const lines = props.contents.split("\n");
    if (lines.length > MAX_PLAIN_NUMBERED_LINES) {
      return null;
    }
    return `<code>${lines
      .map((line, index) =>
        index === lines.length - 1
          ? `<span class="line">${escapeHtml(line)}</span>`
          : `<span class="line">${escapeHtml(line)}\n</span>`,
      )
      .join("")}</code>`;
  }, [props.contents]);

  if (numberedHtml !== null) {
    return (
      <pre
        className="editor-file-viewer__plain"
        aria-readonly="true"
        dangerouslySetInnerHTML={{ __html: numberedHtml }}
      />
    );
  }

  return (
    <pre className="editor-file-viewer__plain" aria-readonly="true">
      {props.contents}
    </pre>
  );
}

function SyntaxHighlightedFileContents(props: {
  path: string;
  contents: string;
  themeName: DiffThemeName;
}) {
  const language = useMemo(() => getSyntaxLanguageForPath(props.path), [props.path]);
  // The cache key hashes the whole file, so keep it off incidental re-renders
  // (selection state, diff-warming churn) and only recompute when inputs change.
  const cacheKey = useMemo(
    () => createSyntaxHighlightCacheKey(props.contents, language, props.themeName),
    [props.contents, language, props.themeName],
  );
  const cachedHighlightedHtml = getCachedSyntaxHighlightedHtml(cacheKey);

  if (cachedHighlightedHtml != null) {
    return (
      <div
        className="editor-file-viewer__highlight"
        data-syntax-highlighted="true"
        dangerouslySetInnerHTML={{ __html: cachedHighlightedHtml }}
      />
    );
  }

  // The uncached path lives in its own component: an early return above must
  // not change this component's hook order once the cache fills.
  return (
    <UncachedSyntaxHighlightedFileContents
      cacheKey={cacheKey}
      contents={props.contents}
      language={language}
      themeName={props.themeName}
    />
  );
}

function UncachedSyntaxHighlightedFileContents(props: {
  cacheKey: string;
  contents: string;
  language: string;
  themeName: DiffThemeName;
}) {
  const highlighter = use(getSyntaxHighlighterPromise(props.language));
  const highlightedHtml = useMemo(() => {
    return highlightCodeToHtmlWithFallback(
      highlighter,
      props.contents,
      props.language,
      props.themeName,
    );
  }, [highlighter, props.contents, props.language, props.themeName]);

  useEffect(() => {
    cacheSyntaxHighlightedHtml(props.cacheKey, highlightedHtml, props.contents);
  }, [props.cacheKey, highlightedHtml, props.contents]);

  return (
    <div
      className="editor-file-viewer__highlight"
      data-syntax-highlighted="true"
      dangerouslySetInnerHTML={{ __html: highlightedHtml }}
    />
  );
}

// Memoized: its inputs (path, contents, themeName) are stable across the
// FilePreview re-renders triggered by selection state and diff-warming, so the
// highlighted body (and its cache lookup) is skipped unless the file changes.
const FileContentsView = memo(function FileContentsView(props: {
  path: string;
  contents: string;
  themeName: DiffThemeName;
}) {
  const plain = <PlainFileContents contents={props.contents} />;
  if (props.contents.length === 0 || props.contents.length > MAX_SYNTAX_HIGHLIGHT_INPUT_CHARS) {
    return plain;
  }

  return (
    <FilePreviewHighlightErrorBoundary key={props.path} fallback={plain}>
      <Suspense fallback={plain}>
        <SyntaxHighlightedFileContents
          path={props.path}
          contents={props.contents}
          themeName={props.themeName}
        />
      </Suspense>
    </FilePreviewHighlightErrorBoundary>
  );
});

function isMarkdownPreviewablePath(filePath: string): boolean {
  const dot = filePath.lastIndexOf(".");
  if (dot < 0) return false;
  return EDITOR_MARKDOWN_PREVIEW_EXTENSIONS.has(filePath.slice(dot).toLowerCase());
}

// Mimics indented code lines so the placeholder reads as a file body
// instead of a generic spinner block.
const FILE_PREVIEW_SKELETON_LINES = [
  { indent: 0, width: "w-5/12" },
  { indent: 0, width: "w-8/12" },
  { indent: 1, width: "w-10/12" },
  { indent: 1, width: "w-7/12" },
  { indent: 2, width: "w-9/12" },
  { indent: 2, width: "w-4/12" },
  { indent: 1, width: "w-6/12" },
  { indent: 0, width: "w-3/12" },
  { indent: 0, width: "w-7/12" },
  { indent: 1, width: "w-9/12" },
  { indent: 1, width: "w-5/12" },
  { indent: 0, width: "w-2/12" },
];

function FilePreviewLoadingState() {
  return (
    <div
      className="min-h-0 flex-1 space-y-2.5 overflow-hidden px-3 py-3"
      role="status"
      aria-label="Loading file..."
    >
      {FILE_PREVIEW_SKELETON_LINES.map((line) => (
        <div key={`${line.indent}-${line.width}`} className="flex h-3 items-center gap-2">
          <Skeleton className="h-2.5 w-5 shrink-0 rounded-full opacity-60" />
          <Skeleton
            className={cn("h-2.5 rounded-full", line.width)}
            style={{ marginLeft: `${line.indent * 1}rem` }}
          />
        </div>
      ))}
      <span className="sr-only">Loading file...</span>
    </div>
  );
}

function FilePreview(props: {
  workspaceRoot: string | null;
  selectedFilePath: string | null;
  onReferenceInChat: ((reference: ChatFileReference) => void) | undefined;
  onAskWhyInChat: ((reference: ChatFileReference) => void) | undefined;
}) {
  const { resolvedTheme } = useTheme();
  const diffThemeName = resolveDiffThemeName(resolvedTheme);
  const contentsRef = useRef<HTMLDivElement>(null);
  const { onAskWhyInChat, onReferenceInChat, selectedFilePath } = props;
  const selectedFileIsImage =
    selectedFilePath !== null && isSupportedLocalImagePath(selectedFilePath);
  const selectedFileIsMarkdown =
    selectedFilePath !== null && isMarkdownPreviewablePath(selectedFilePath);
  const [markdownPreviewEnabled, setMarkdownPreviewEnabled] = useState(false);
  const fileQuery = useQuery(
    projectReadFileQueryOptions({
      cwd: props.workspaceRoot,
      relativePath: props.selectedFilePath,
      enabled:
        props.workspaceRoot !== null && props.selectedFilePath !== null && !selectedFileIsImage,
    }),
  );
  useEffect(() => {
    setMarkdownPreviewEnabled(false);
  }, [selectedFilePath]);

  const fileContents = fileQuery.data?.contents ?? "";
  const showMarkdownPreview = selectedFileIsMarkdown && markdownPreviewEnabled;
  const lineCount = useMemo(
    () => (fileContents.length === 0 ? 0 : fileContents.split("\n").length),
    [fileContents],
  );
  // Highlight code -> floating "Add to chat" -> reference that quotes exactly
  // what was selected (down to a single word), mirroring the transcript flow.
  const readPreviewSelection = useCallback(
    (container: HTMLElement) => getSelectionWithin(container),
    [],
  );
  const commitPreviewSelection = useCallback(
    (selection: SelectionWithin) => {
      if (selectedFilePath) {
        onReferenceInChat?.({ path: selectedFilePath, ...selection });
      }
    },
    [onReferenceInChat, selectedFilePath],
  );
  const previewSelectionAction = useCodeSelectionAction({
    enabled: Boolean(onReferenceInChat && selectedFilePath),
    readSelection: readPreviewSelection,
    onCommit: commitPreviewSelection,
  });
  // Right-click references the selected line range when text is selected,
  // otherwise the whole file.
  const handleContentsContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (!selectedFilePath) {
        return;
      }
      event.preventDefault();
      const container = contentsRef.current;
      const selection = container ? getSelectionWithin(container) : null;
      void showFileReferenceContextMenu({
        path: selectedFilePath,
        position: { x: event.clientX, y: event.clientY },
        selection,
        onReferenceInChat,
        onAskWhyInChat,
      });
    },
    [onAskWhyInChat, onReferenceInChat, selectedFilePath],
  );

  if (!props.workspaceRoot) {
    return (
      <PanelStateMessage density="compact" fill="flex">
        <p>No workspace is attached to this chat.</p>
      </PanelStateMessage>
    );
  }

  if (!props.selectedFilePath) {
    return (
      <PanelStateMessage density="compact" fill="flex">
        <p>Select a file from the explorer.</p>
      </PanelStateMessage>
    );
  }

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-[var(--color-background-surface)]">
      <div
        className={cn(
          "flex h-10 shrink-0 items-center gap-2 px-3",
          CHAT_SURFACE_HEADER_DIVIDER_CLASS_NAME,
        )}
      >
        <FileEntryIcon
          pathValue={props.selectedFilePath}
          kind="file"
          className="size-3.5 shrink-0"
        />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12px] font-medium text-foreground">
            {basenameOfPath(props.selectedFilePath)}
          </div>
          <div className="truncate text-[10px] text-muted-foreground/75">
            {props.selectedFilePath}
          </div>
        </div>
        {fileQuery.data?.truncated ? (
          <span className="shrink-0 text-[10px] text-muted-foreground/70">Shown partially</span>
        ) : null}
        {selectedFileIsMarkdown ? (
          <ChatHeaderIconButton
            type="button"
            label={showMarkdownPreview ? "Show Markdown source" : "Show Markdown preview"}
            title={showMarkdownPreview ? "Show Markdown source" : "Show Markdown preview"}
            aria-pressed={showMarkdownPreview}
            tone="plain"
            onClick={() => setMarkdownPreviewEnabled((previous) => !previous)}
          >
            {showMarkdownPreview ? (
              <FileIcon className="size-3.5" aria-hidden="true" />
            ) : (
              <EyeIcon className="size-3.5" aria-hidden="true" />
            )}
          </ChatHeaderIconButton>
        ) : null}
      </div>
      {selectedFileIsImage ? (
        <div
          className="editor-file-viewer min-h-0 flex-1 overflow-auto"
          onContextMenu={handleContentsContextMenu}
        >
          <LocalImagePreview
            src={props.selectedFilePath}
            cwd={props.workspaceRoot}
            alt={fileNameFromPath(props.selectedFilePath)}
            className="min-h-full"
            imageClassName="max-h-[calc(100vh-13rem)]"
          />
        </div>
      ) : fileQuery.isLoading ? (
        <FilePreviewLoadingState />
      ) : fileQuery.error ? (
        <PanelStateMessage density="compact" fill="flex" className="items-start justify-start p-3">
          <p className="text-left text-[11px] text-destructive/85">
            {fileQuery.error instanceof Error ? fileQuery.error.message : "Could not read file."}
          </p>
        </PanelStateMessage>
      ) : (
        <div
          ref={contentsRef}
          className={cn(
            "editor-file-viewer min-h-0 flex-1 overflow-auto",
            showMarkdownPreview && "editor-file-viewer--markdown-preview",
          )}
          onContextMenu={handleContentsContextMenu}
          onMouseUp={showMarkdownPreview ? undefined : previewSelectionAction.onContainerMouseUp}
        >
          {showMarkdownPreview ? (
            <div className="editor-markdown-preview">
              <ChatMarkdown
                text={fileContents}
                cwd={markdownPreviewCwd(props.workspaceRoot, props.selectedFilePath)}
                isStreaming={false}
                className="editor-markdown-preview__body text-sm leading-relaxed"
              />
            </div>
          ) : (
            <FileContentsView
              path={props.selectedFilePath}
              contents={fileContents}
              themeName={diffThemeName}
            />
          )}
          {!showMarkdownPreview && lineCount > 0 ? (
            <span className="sr-only">{lineCount} lines</span>
          ) : null}
          {!showMarkdownPreview && previewSelectionAction.pendingAction ? (
            <TranscriptSelectionAction
              left={previewSelectionAction.pendingAction.left}
              top={previewSelectionAction.pendingAction.top}
              placement={previewSelectionAction.pendingAction.placement}
              onAddToChat={previewSelectionAction.commit}
            />
          ) : null}
        </div>
      )}
    </div>
  );
}

function EditorActivityBarButton(props: {
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

function EditorActivityBar(props: {
  centerMode: EditorCenterMode;
  searchActive: boolean;
  sidebarVisible: boolean;
  onSelectItem: (item: EditorActivityBarItem) => void;
}) {
  const filesActive = props.sidebarVisible && !props.searchActive && props.centerMode === "file";
  const diffActive = props.sidebarVisible && !props.searchActive && props.centerMode === "diff";
  const searchActive = props.sidebarVisible && props.searchActive;
  return (
    <nav
      className="flex w-12 shrink-0 flex-col items-center border-r border-border/65 bg-[var(--color-background-surface)]"
      aria-label="Editor activity bar"
    >
      <EditorActivityBarButton
        label={filesActive ? "Hide files sidebar" : "Files"}
        active={filesActive}
        onClick={() => props.onSelectItem("file")}
      >
        <FileEntryIcon
          pathValue="Files"
          kind="directory"
          expanded={props.centerMode === "file"}
          className="size-5"
        />
      </EditorActivityBarButton>
      <EditorActivityBarButton
        label={diffActive ? "Hide diff sidebar" : "Diff"}
        active={diffActive}
        onClick={() => props.onSelectItem("diff")}
      >
        <ChangesIcon className="size-5" />
      </EditorActivityBarButton>
      <EditorActivityBarButton
        label={searchActive ? "Hide search sidebar" : "Search files"}
        active={searchActive}
        onClick={() => props.onSelectItem("search")}
      >
        <SearchIcon className="size-5" />
      </EditorActivityBarButton>
    </nav>
  );
}

export function EditorWorkspaceView(props: EditorWorkspaceViewProps) {
  // The editor header sits flush against the window's left edge whenever the
  // global sidebar is collapsed, so it has to clear the macOS traffic lights the
  // same way every other chat-surface header does.
  const trafficLightGutterClassName = useDesktopTopBarTrafficLightGutterClassName();
  const [chatPaneWidth, setChatPaneWidth] = useState(readStoredEditorChatPaneWidth);
  const chatPaneResizeStateRef = useRef<EditorChatPaneResizeState | null>(null);
  // Both side surfaces can be hidden so the main content takes the full width:
  // re-clicking the active activity-bar item collapses the sidebar (VS Code
  // style), and the header chat toggle hides the chat pane (kept mounted so
  // the chat runtime survives).
  const [sidebarVisible, setSidebarVisible] = useState(() =>
    readStoredEditorVisibility(EDITOR_SIDEBAR_VISIBLE_STORAGE_KEY),
  );
  const [chatPaneVisible, setChatPaneVisible] = useState(() =>
    readStoredEditorVisibility(EDITOR_CHAT_PANE_VISIBLE_STORAGE_KEY),
  );
  // The search pane replaces the explorer/diff sidebar without touching the
  // center mode, so picking a result simply opens it in the file preview. The
  // query lives here so it survives toggling between sidebar panes.
  const [searchPaneActive, setSearchPaneActive] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const desktopTopBarWindowControlsGutterClassName =
    useDesktopTopBarWindowControlsGutterClassName();
  const { centerMode, onCenterModeChange } = props;
  const handleActivityBarSelectItem = useCallback(
    (item: EditorActivityBarItem) => {
      const itemActive =
        sidebarVisible &&
        (item === "search" ? searchPaneActive : !searchPaneActive && centerMode === item);
      if (itemActive) {
        setSidebarVisible(false);
        storeEditorVisibility(EDITOR_SIDEBAR_VISIBLE_STORAGE_KEY, false);
        return;
      }
      if (!sidebarVisible) {
        setSidebarVisible(true);
        storeEditorVisibility(EDITOR_SIDEBAR_VISIBLE_STORAGE_KEY, true);
      }
      if (item === "search") {
        setSearchPaneActive(true);
        return;
      }
      setSearchPaneActive(false);
      onCenterModeChange(item);
    },
    [centerMode, onCenterModeChange, searchPaneActive, sidebarVisible],
  );
  const toggleChatPaneVisible = useCallback(() => {
    setChatPaneVisible((previous) => {
      const next = !previous;
      storeEditorVisibility(EDITOR_CHAT_PANE_VISIBLE_STORAGE_KEY, next);
      return next;
    });
  }, []);

  const stopChatPaneResize = useCallback(() => {
    const resizeState = chatPaneResizeStateRef.current;
    if (!resizeState || typeof window === "undefined") {
      return;
    }

    if (resizeState.rafId !== null) {
      window.cancelAnimationFrame(resizeState.rafId);
      resizeState.rafId = null;
    }

    window.removeEventListener("pointermove", resizeState.onPointerMove);
    window.removeEventListener("pointerup", resizeState.onPointerEnd);
    window.removeEventListener("pointercancel", resizeState.onPointerEnd);
    document.body.style.cursor = resizeState.restoreBodyCursor;
    document.body.style.userSelect = resizeState.restoreBodyUserSelect;
    setChatPaneWidth(resizeState.pendingWidth);
    storeEditorChatPaneWidth(resizeState.pendingWidth);
    chatPaneResizeStateRef.current = null;
  }, []);

  useEffect(() => stopChatPaneResize, [stopChatPaneResize]);

  const handleChatPaneResizePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0 || typeof window === "undefined") {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      stopChatPaneResize();

      const resizeState: EditorChatPaneResizeState = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startWidth: chatPaneWidth,
        pendingWidth: chatPaneWidth,
        rafId: null,
        restoreBodyCursor: document.body.style.cursor,
        restoreBodyUserSelect: document.body.style.userSelect,
        onPointerMove: () => undefined,
        onPointerEnd: () => undefined,
      };

      resizeState.onPointerMove = (moveEvent) => {
        if (moveEvent.pointerId !== resizeState.pointerId) {
          return;
        }

        resizeState.pendingWidth = clampEditorChatPaneWidth(
          resizeState.startWidth + resizeState.startX - moveEvent.clientX,
        );

        if (resizeState.rafId !== null) {
          return;
        }

        resizeState.rafId = window.requestAnimationFrame(() => {
          resizeState.rafId = null;
          setChatPaneWidth(resizeState.pendingWidth);
        });
      };

      resizeState.onPointerEnd = (endEvent) => {
        if (endEvent.pointerId !== resizeState.pointerId) {
          return;
        }
        stopChatPaneResize();
      };

      chatPaneResizeStateRef.current = resizeState;
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      window.addEventListener("pointermove", resizeState.onPointerMove);
      window.addEventListener("pointerup", resizeState.onPointerEnd);
      window.addEventListener("pointercancel", resizeState.onPointerEnd);
    },
    [chatPaneWidth, stopChatPaneResize],
  );

  const handleChatPaneResizeDoubleClick = useCallback(() => {
    setChatPaneWidth(EDITOR_CHAT_PANE_DEFAULT_WIDTH);
    storeEditorChatPaneWidth(EDITOR_CHAT_PANE_DEFAULT_WIDTH);
  }, []);

  const handleChatPaneResizeKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      let nextWidth: number | null = null;

      if (event.key === "ArrowLeft") {
        nextWidth = chatPaneWidth + EDITOR_CHAT_PANE_KEYBOARD_STEP;
      } else if (event.key === "ArrowRight") {
        nextWidth = chatPaneWidth - EDITOR_CHAT_PANE_KEYBOARD_STEP;
      } else if (event.key === "Home") {
        nextWidth = EDITOR_CHAT_PANE_MIN_WIDTH;
      } else if (event.key === "End") {
        nextWidth = EDITOR_CHAT_PANE_MAX_WIDTH;
      }

      if (nextWidth === null) {
        return;
      }

      event.preventDefault();
      const clampedWidth = clampEditorChatPaneWidth(nextWidth);
      setChatPaneWidth(clampedWidth);
      storeEditorChatPaneWidth(clampedWidth);
    },
    [chatPaneWidth],
  );

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-[var(--color-background-root)] text-foreground">
      <div
        className={cn(
          "flex shrink-0 items-center gap-2 px-2 sm:px-3",
          CHAT_SURFACE_HEADER_HEIGHT_CLASS,
          CHAT_SURFACE_HEADER_DIVIDER_CLASS_NAME,
          desktopTopBarWindowControlsGutterClassName,
        )}
      >
        <div
          className={cn("flex min-w-0 flex-1 items-center gap-1.5", trafficLightGutterClassName)}
        >
          <div className="flex min-w-0 items-baseline gap-2">
            <span className="truncate text-[13px] font-medium text-foreground">
              {props.projectName ?? "Workspace"}
            </span>
            <span className="hidden truncate text-[11px] text-muted-foreground/70 sm:inline">
              {props.workspaceRoot ?? "No workspace"}
            </span>
          </div>
          {props.onSelectProject && (props.projectOptions?.length ?? 0) > 0 ? (
            <ProjectMenuPicker
              projectOptions={props.projectOptions ?? []}
              selectedProjectId={props.currentProjectId ?? null}
              onProjectIdChange={props.onSelectProject}
              trigger={
                <ChatHeaderIconButton
                  type="button"
                  tone="plain"
                  label="Switch project"
                  title="Switch project"
                  className="size-6"
                >
                  <ChevronDownIcon className="size-3.5" />
                </ChatHeaderIconButton>
              }
            />
          ) : null}
        </div>
        <ChatHeaderButton
          type="button"
          tone="outline"
          aria-pressed={chatPaneVisible}
          title={chatPaneVisible ? "Hide chat panel" : "Show chat panel"}
          className="gap-1.5"
          onClick={toggleChatPaneVisible}
        >
          <PanelRightCloseIcon className="size-3.5" />
          <span className="sr-only">{chatPaneVisible ? "Hide chat panel" : "Show chat panel"}</span>
        </ChatHeaderButton>
        <ChatHeaderButton
          type="button"
          tone="outline"
          aria-pressed={true}
          title="Switch to chat view"
          className="w-[5.5rem] gap-1.5"
          onClick={props.onExitEditorView}
        >
          <ChatBubbleIcon className="size-3.5" />
          <span className="truncate font-normal">Chat</span>
        </ChatHeaderButton>
      </div>
      <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
        <EditorActivityBar
          centerMode={props.centerMode}
          searchActive={searchPaneActive}
          sidebarVisible={sidebarVisible}
          onSelectItem={handleActivityBarSelectItem}
        />
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden lg:flex-row">
          {!sidebarVisible ? null : searchPaneActive ? (
            <WorkspaceSearchSidebar
              workspaceRoot={props.workspaceRoot}
              query={searchQuery}
              onQueryChange={setSearchQuery}
              selectedFilePath={props.selectedFilePath}
              onSelectFile={props.onSelectFile}
              onReferenceInChat={props.onReferenceInChat}
            />
          ) : props.centerMode === "diff" ? (
            <DiffFilesSidebar
              files={props.diffFiles}
              isLoading={props.diffFilesLoading ?? false}
              selectedFilePath={props.selectedDiffFilePath}
              optionsControl={props.diffOptionsControl}
              onSelectFile={props.onSelectDiffFile}
              onReferenceInChat={props.onReferenceInChat}
              onAskWhyInChat={props.onAskWhyInChat}
            />
          ) : (
            <WorkspaceFilesSidebar
              workspaceRoot={props.workspaceRoot}
              selectedFilePath={props.selectedFilePath}
              expandedDirectories={props.expandedDirectories}
              onSelectFile={props.onSelectFile}
              onToggleDirectory={props.onToggleDirectory}
              onReferenceInChat={props.onReferenceInChat}
            />
          )}
          <main className="flex min-h-[16rem] min-w-0 flex-1 border-b border-border/65 lg:h-full lg:border-b-0">
            {/* Keep the diff panel mounted while browsing files: unmounting it
                drops the parsed patch, diff worker pool, and query subscriptions,
                which made every Files -> Diff switch a cold multi-second reload. */}
            <div className={cn("min-h-0 min-w-0 flex-1", props.centerMode !== "diff" && "hidden")}>
              {props.diffPanel}
            </div>
            {props.centerMode === "file" ? (
              <div className="flex min-h-0 min-w-0 flex-1">
                <FilePreview
                  workspaceRoot={props.workspaceRoot}
                  selectedFilePath={props.selectedFilePath}
                  onReferenceInChat={props.onReferenceInChat}
                  onAskWhyInChat={props.onAskWhyInChat}
                />
              </div>
            ) : null}
          </main>
          <div
            role="separator"
            aria-label="Resize chat panel"
            aria-orientation="vertical"
            aria-valuemin={EDITOR_CHAT_PANE_MIN_WIDTH}
            aria-valuemax={EDITOR_CHAT_PANE_MAX_WIDTH}
            aria-valuenow={chatPaneWidth}
            tabIndex={0}
            title="Drag to resize chat panel"
            className={cn(
              "group relative z-10 w-0 shrink-0 cursor-col-resize outline-none",
              chatPaneVisible ? "hidden lg:block" : "hidden",
            )}
            onPointerDown={handleChatPaneResizePointerDown}
            onDoubleClick={handleChatPaneResizeDoubleClick}
            onKeyDown={handleChatPaneResizeKeyDown}
          >
            <span
              className="absolute inset-y-0 left-[-3px] w-1.5 cursor-col-resize bg-transparent transition-colors group-hover:bg-[var(--color-background-button-secondary-hover)] group-focus-visible:bg-[var(--color-background-button-secondary-hover)]"
              aria-hidden="true"
            />
            <span
              className="pointer-events-none absolute inset-y-0 left-0 w-px bg-[var(--app-surface-divider)] transition-colors group-hover:bg-[var(--color-text-accent)] group-focus-visible:bg-[var(--color-text-accent)]"
              aria-hidden="true"
            />
          </div>
          {/* Hidden (not unmounted) so the chat runtime and composer focus
              state survive toggling the pane. */}
          <aside
            className={cn(
              "min-h-[18rem] w-full shrink-0 bg-[var(--color-background-surface)] lg:h-full lg:w-[var(--editor-chat-pane-width)]",
              chatPaneVisible ? "flex" : "hidden",
            )}
            style={
              {
                "--editor-chat-pane-width": `${chatPaneWidth}px`,
              } as CSSProperties
            }
          >
            {props.chatPanel}
          </aside>
        </div>
      </div>
    </div>
  );
}

export default EditorWorkspaceView;
