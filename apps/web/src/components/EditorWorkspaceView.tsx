// FILE: EditorWorkspaceView.tsx
// Purpose: Read-only editor-style thread surface with file explorer, workspace
//          file search, file/diff preview, and chat.
// Layer: Chat route presentation

import type { ProjectId } from "@synara/contracts";
import type { FileDiffMetadata } from "@pierre/diffs/react";
import {
  type ReactNode,
  useCallback,
  useMemo,
  useState,
} from "react";

import {
  ChangesIcon,
  ChatBubbleIcon,
  ChevronDownIcon,
  DiffIcon,
  FoldersIcon,
  PanelRightCloseIcon,
  SearchIcon,
} from "~/lib/icons";
import {
  useDesktopTopBarTrafficLightGutterClassName,
  useDesktopTopBarWindowControlsGutterClassName,
} from "~/hooks/useDesktopTopBarGutter";
import {
  buildFileDiffRenderKey,
  resolveFileDiffPath,
  splitRepoRelativePath,
  summarizeFileDiffStats,
} from "~/lib/diffRendering";
import { showFileReferenceContextMenu } from "~/lib/fileReferenceContextMenu";
import type { ChatFileReference } from "~/lib/chatReferences";
import type { FileCommentSelection } from "~/lib/fileComments";
import { cn } from "~/lib/utils";
import { useTheme } from "~/hooks/useTheme";
import { Skeleton } from "./ui/skeleton";
import {
  ChatHeaderButton,
  ChatHeaderIconButton,
  CHAT_SURFACE_HEADER_DIVIDER_CLASS_NAME,
  CHAT_SURFACE_HEADER_HEIGHT_CLASS,
} from "./chat/chatHeaderControls";
import { EXPLORER_ROW_PROPS, useExplorerListNavigation } from "./chat/explorerListNavigation";
import { FileEntryIcon } from "./chat/FileEntryIcon";
import { fileRowClassName } from "./chat/fileRowStyles";
import { DiffStat } from "./chat/DiffStatLabel";
import { PanelStateMessage } from "./chat/PanelStateMessage";
import {
  ExplorerActivityBarButton,
  setFileReferenceDragData,
  WorkspaceFilesSidebar,
  WorkspaceSearchSidebar,
} from "./chat/workspaceExplorer";
import { ProjectMenuPicker, type ProjectMenuPickerOption } from "./ProjectMenuPicker";
import { WorkspaceFilePreview } from "./WorkspaceFilePreview";
import { ResizableChatPane, useResizableChatPane } from "./ResizableChatPane";

type EditorCenterMode = "file" | "diff";
type EditorActivityBarItem = EditorCenterMode | "search";

const EDITOR_CHAT_PANE_STORAGE_KEY = "synara.editor.chatPaneWidth";
const EDITOR_SIDEBAR_VISIBLE_STORAGE_KEY = "synara.editor.sidebarVisible";
const EDITOR_CHAT_PANE_VISIBLE_STORAGE_KEY = "synara.editor.chatPaneVisible";
const EDITOR_CHAT_PANE_DEFAULT_WIDTH = 384;
const EDITOR_CHAT_PANE_MIN_WIDTH = 320;
const EDITOR_CHAT_PANE_MAX_WIDTH = 600;

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
  onCommentInChat?: (comment: FileCommentSelection) => void;
  onSelectProject?: (projectId: ProjectId) => void;
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
      {...EXPLORER_ROW_PROPS}
      type="button"
      className={fileRowClassName(props.selected, "h-8 px-2")}
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
  const handleListKeyDown = useExplorerListNavigation();
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
      {/* Keyboard nav lives on the scrolling list, not the whole aside, so the
          header's actions menu stays out of arrow-key scope (the search sidebars
          attach at the aside because their only header control is a text input). */}
      <div
        className={cn(
          "min-h-0 flex-1 overflow-auto px-1 py-1",
          !showLoadingRows && props.files.length === 0 && "flex flex-col",
        )}
        onKeyDown={handleListKeyDown}
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
      <ExplorerActivityBarButton
        label={filesActive ? "Hide files sidebar" : "Files"}
        active={filesActive}
        onClick={() => props.onSelectItem("file")}
      >
        <FoldersIcon className="size-5" />
      </ExplorerActivityBarButton>
      <ExplorerActivityBarButton
        label={diffActive ? "Hide diff sidebar" : "Diff"}
        active={diffActive}
        onClick={() => props.onSelectItem("diff")}
      >
        <ChangesIcon className="size-5" />
      </ExplorerActivityBarButton>
      <ExplorerActivityBarButton
        label={searchActive ? "Hide search sidebar" : "Search files"}
        active={searchActive}
        onClick={() => props.onSelectItem("search")}
      >
        <SearchIcon className="size-5" />
      </ExplorerActivityBarButton>
    </nav>
  );
}

export function EditorWorkspaceView(props: EditorWorkspaceViewProps) {
  // The editor header sits flush against the window's left edge whenever the
  // global sidebar is collapsed, so it has to clear the macOS traffic lights the
  // same way every other chat-surface header does.
  const trafficLightGutterClassName = useDesktopTopBarTrafficLightGutterClassName();
  const chatPane = useResizableChatPane({
    storageKey: "synara.editor.chatPane",
    widthStorageKey: EDITOR_CHAT_PANE_STORAGE_KEY,
    visibilityStorageKey: EDITOR_CHAT_PANE_VISIBLE_STORAGE_KEY,
    defaultWidth: EDITOR_CHAT_PANE_DEFAULT_WIDTH,
    minWidth: EDITOR_CHAT_PANE_MIN_WIDTH,
    maxWidth: EDITOR_CHAT_PANE_MAX_WIDTH,
  });
  // Both side surfaces can be hidden so the main content takes the full width:
  // re-clicking the active activity-bar item collapses the sidebar (VS Code
  // style), and the header chat toggle hides the chat pane (kept mounted so
  // the chat runtime survives).
  const [sidebarVisible, setSidebarVisible] = useState(() =>
    readStoredEditorVisibility(EDITOR_SIDEBAR_VISIBLE_STORAGE_KEY),
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
          aria-pressed={chatPane.visible}
          title={chatPane.visible ? "Hide chat panel" : "Show chat panel"}
          className="gap-1.5"
          onClick={chatPane.toggleVisible}
        >
          <PanelRightCloseIcon className="size-3.5" />
          <span className="sr-only">
            {chatPane.visible ? "Hide chat panel" : "Show chat panel"}
          </span>
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
                <WorkspaceFilePreview
                  workspaceRoot={props.workspaceRoot}
                  filePath={props.selectedFilePath}
                  onReferenceInChat={props.onReferenceInChat}
                  onAskWhyInChat={props.onAskWhyInChat}
                  onCommentInChat={props.onCommentInChat}
                />
              </div>
            ) : null}
          </main>
          <ResizableChatPane controller={chatPane}>{props.chatPanel}</ResizableChatPane>
        </div>
      </div>
    </div>
  );
}

export default EditorWorkspaceView;
