// FILE: LibraryPanel.tsx
// Purpose: Group Library panel — the third chat auxiliary surface. Lists the
//          per-group git-versioned file store served by the
//          `projectAgent.library.*` RPCs and the /api/library/upload route:
//          search, type filter, list/grid views, expandable folders, preview,
//          rename/delete, version history with restore, and the remote-push
//          status pill.
// Layer: Chat UI component

import type { LibraryCommit, LibraryEntry, ProjectId } from "@synara/contracts";
import { type MouseEvent as ReactMouseEvent, useCallback, useMemo, useRef, useState } from "react";

import { IconButton } from "~/components/ui/icon-button";
import { SearchInput } from "~/components/ui/search-input";
import { SettingsSegmentedControl } from "~/components/settings/SettingControls";
import { DisclosureChevron } from "~/components/ui/DisclosureChevron";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { toastManager } from "~/components/ui/toast";
import { AUXILIARY_PANEL_MOTION_CLASS } from "~/components/chat/auxiliary/ChatAuxiliaryPanel";
import { ENVIRONMENT_PANEL_SURFACE_CLASS_NAME } from "~/components/chat/composerPickerStyles";
import { EnvironmentPanelTitle } from "~/components/chat/environment/EnvironmentRow";
import { FileEntryIcon } from "~/components/chat/FileEntryIcon";
import { fileRowClassName } from "~/components/chat/fileRowStyles";
import { PanelStateMessage } from "~/components/chat/PanelStateMessage";
import { WorkspaceFilePreview } from "~/components/WorkspaceFilePreview";
import {
  AddPlusIcon,
  ArrowLeftIcon,
  ArrowUpIcon,
  ArrowDownIcon,
  CloudSyncIcon,
  PanelCollapseIcon,
  PanelExpandIcon,
  XIcon,
} from "~/lib/icons";
import { formatRelativeTime } from "~/lib/relativeTime";
import { cn } from "~/lib/utils";
import { readNativeApi } from "~/nativeApi";

import {
  DEFAULT_EXPANDED_DIRECTORIES,
  DEFAULT_LIBRARY_SORT,
  flattenLibraryRows,
  type LibraryRow,
  type LibrarySortKey,
  type LibrarySortState,
  type LibraryTypeFilter,
  type LibraryViewMode,
  nextLibrarySort,
  toggleLibraryDirectory,
} from "./libraryPanel.logic";
import { useGroupLibrary } from "./useGroupLibrary";

export interface LibraryPanelProps {
  open: boolean;
  variant: "docked" | "floating";
  projectId: ProjectId | null;
  onClose: () => void;
}

const PANEL_OVERLAY_WRAPPER_CLASS_NAME =
  "pointer-events-none absolute inset-y-0 right-0 z-20 flex flex-col p-3";

const TYPE_FILTER_OPTIONS: ReadonlyArray<{
  readonly value: LibraryTypeFilter;
  readonly label: string;
}> = [
  { value: "all", label: "All" },
  { value: "documents", label: "Documents" },
  { value: "images", label: "Images" },
  { value: "code", label: "Code" },
  { value: "other", label: "Other" },
];

const VIEW_MODE_OPTIONS = [
  { value: "list" as const, label: "List" },
  { value: "grid" as const, label: "Grid" },
];

export function LibraryPanel({ open, variant, projectId, onClose }: LibraryPanelProps) {
  const library = useGroupLibrary({ projectId, enabled: open && projectId !== null });
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState<LibraryTypeFilter>("all");
  const [viewMode, setViewMode] = useState<LibraryViewMode>("list");
  const [sort, setSort] = useState<LibrarySortState>(DEFAULT_LIBRARY_SORT);
  const [expandedDirectories, setExpandedDirectories] = useState<ReadonlySet<string>>(
    DEFAULT_EXPANDED_DIRECTORIES,
  );
  const [fullHeight, setFullHeight] = useState(false);
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const [historyPath, setHistoryPath] = useState<string | null>(null);
  const [historyCommits, setHistoryCommits] = useState<readonly LibraryCommit[] | null>(null);
  const [renameTarget, setRenameTarget] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const rows = useMemo(
    () =>
      flattenLibraryRows({
        entriesByDir: library.entriesByDir,
        expandedDirectories,
        sort,
        typeFilter,
        query,
      }),
    [library.entriesByDir, expandedDirectories, sort, typeFilter, query],
  );

  const openFile = useCallback((entry: LibraryEntry) => {
    setPreviewPath(entry.relativePath);
  }, []);

  const toggleDirectory = useCallback(
    (entry: LibraryEntry) => {
      setExpandedDirectories((current) => {
        const next = toggleLibraryDirectory(current, entry.relativePath);
        if (next.has(entry.relativePath) && !library.entriesByDir.has(entry.relativePath)) {
          void library.loadDirectory(entry.relativePath);
        }
        return next;
      });
    },
    [library],
  );

  const handleEntryClick = useCallback(
    (entry: LibraryEntry) => {
      if (entry.kind === "directory") {
        toggleDirectory(entry);
      } else {
        openFile(entry);
      }
    },
    [openFile, toggleDirectory],
  );

  const showHistory = useCallback(
    async (entry: LibraryEntry) => {
      setHistoryPath(entry.relativePath);
      setHistoryCommits(null);
      setHistoryCommits(await library.history(entry.relativePath));
    },
    [library],
  );

  const refreshHistory = useCallback(async () => {
    if (historyPath === null) return;
    setHistoryCommits(await library.history(historyPath));
  }, [historyPath, library]);

  const handleContextMenu = useCallback(
    async (entry: LibraryEntry, event: ReactMouseEvent<HTMLElement>) => {
      event.preventDefault();
      const api = readNativeApi();
      if (!api) return;
      const clicked = await api.contextMenu.show(
        [
          { id: "rename" as const, label: "Rename" },
          { id: "delete" as const, label: "Delete" },
          { id: "history" as const, label: "History" },
        ],
        { x: event.clientX, y: event.clientY },
      );
      if (clicked === "rename") {
        setRenameTarget(entry.relativePath);
        setRenameDraft(entry.name);
        return;
      }
      if (clicked === "delete") {
        const deleted = await library.deleteEntry(entry.relativePath);
        if (deleted && previewPath === entry.relativePath) setPreviewPath(null);
        return;
      }
      if (clicked === "history") {
        void showHistory(entry);
      }
    },
    [library, previewPath, showHistory],
  );

  const commitRename = useCallback(async () => {
    const target = renameTarget;
    const nextName = renameDraft.trim();
    setRenameTarget(null);
    if (!target || !nextName) return;
    const slash = target.lastIndexOf("/");
    const to = slash === -1 ? nextName : `${target.slice(0, slash + 1)}${nextName}`;
    if (to === target) return;
    const renamed = await library.rename(target, to);
    if (renamed) {
      setPreviewPath((current) => (current === target ? to : current));
      setHistoryPath((current) => (current === target ? to : current));
    }
  }, [library, renameDraft, renameTarget]);

  const handleUploadChange = useCallback(
    async (fileList: FileList | null) => {
      if (!fileList) return;
      // Sequential like composerSend: several max-size uploads must not burst
      // concurrent body buffers.
      for (const file of Array.from(fileList)) {
        await library.upload(undefined, file);
      }
      if (fileInputRef.current) fileInputRef.current.value = "";
    },
    [library],
  );

  const remoteStatus = library.status;
  const emptyLibrary = rows.length === 0;

  const content = (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1 px-2 pb-1 pt-0.5">
        <EnvironmentPanelTitle>Library</EnvironmentPanelTitle>
        <div className="ml-auto flex items-center gap-0.5">
          <IconButton
            type="button"
            label={fullHeight ? "Collapse panel" : "Expand to full height"}
            tooltip={fullHeight ? "Collapse" : "Expand to full height"}
            onClick={() => setFullHeight((current) => !current)}
          >
            {fullHeight ? (
              <PanelCollapseIcon className="size-3.5" />
            ) : (
              <PanelExpandIcon className="size-3.5" />
            )}
          </IconButton>
          <IconButton type="button" label="Close library" tooltip="Close" onClick={onClose}>
            <XIcon className="size-3.5" />
          </IconButton>
        </div>
      </div>

      <div className="px-2 pb-1">
        <SearchInput
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search library..."
          aria-label="Search library"
        />
      </div>

      <div className="flex items-center gap-1.5 px-2 pb-1.5">
        <label className="sr-only" htmlFor="library-type-filter">
          Type
        </label>
        <select
          id="library-type-filter"
          aria-label="Type"
          className="h-6 min-w-0 flex-1 rounded-md border border-[color:var(--color-border)] bg-transparent px-1.5 text-[11px] text-foreground"
          value={typeFilter}
          onChange={(event) => setTypeFilter(event.target.value as LibraryTypeFilter)}
        >
          {TYPE_FILTER_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <SettingsSegmentedControl
          value={viewMode}
          onValueChange={setViewMode}
          options={VIEW_MODE_OPTIONS}
          ariaLabel="View mode"
        />
        <Button
          type="button"
          size="sm"
          variant="default"
          className="shrink-0"
          disabled={library.busy}
          onClick={() => fileInputRef.current?.click()}
        >
          <AddPlusIcon className="size-3.5" /> Add
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          aria-label="Upload files to the library"
          onChange={(event) => void handleUploadChange(event.target.files)}
        />
      </div>

      {remoteStatus?.remoteConfigured ? (
        <div className="flex items-center gap-1.5 px-2 pb-1.5">
          <span
            className={cn(
              "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px]",
              remoteStatus.lastPushError
                ? "border-destructive/40 text-destructive"
                : "border-[color:var(--color-border)] text-muted-foreground",
            )}
            title={remoteStatus.lastPushError ?? remoteStatus.lastPushAt ?? "Not pushed yet"}
          >
            <CloudSyncIcon className="size-3" />
            {remoteStatus.lastPushError
              ? "Push failed"
              : remoteStatus.lastPushAt
                ? "Pushed"
                : "Not pushed yet"}
          </span>
        </div>
      ) : null}

      {library.error ? (
        <p className="px-2 pb-1 text-[11px] text-destructive" role="alert">
          {library.error}
        </p>
      ) : null}

      {previewPath !== null && library.root ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex items-center gap-1 px-2 pb-1">
            <IconButton
              type="button"
              label="Back to library"
              tooltip="Back"
              onClick={() => setPreviewPath(null)}
            >
              <ArrowLeftIcon className="size-3.5" />
            </IconButton>
            <span
              className="min-w-0 truncate text-[11px] text-muted-foreground"
              title={previewPath}
            >
              {previewPath}
            </span>
          </div>
          <div className="min-h-0 flex-1 overflow-hidden">
            <WorkspaceFilePreview
              workspaceRoot={library.root}
              filePath={previewPath}
              markdownPreviewDefault
              editable={false}
            />
          </div>
        </div>
      ) : historyPath !== null ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex items-center gap-1 px-2 pb-1">
            <IconButton
              type="button"
              label="Back to library"
              tooltip="Back"
              onClick={() => {
                setHistoryPath(null);
                setHistoryCommits(null);
              }}
            >
              <ArrowLeftIcon className="size-3.5" />
            </IconButton>
            <span
              className="min-w-0 truncate text-[11px] text-muted-foreground"
              title={historyPath}
            >
              History — {historyPath}
            </span>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-1">
            {historyCommits === null ? (
              <PanelStateMessage density="compact" fill="flex">
                <p>Loading history…</p>
              </PanelStateMessage>
            ) : historyCommits.length === 0 ? (
              <PanelStateMessage density="compact" fill="flex">
                <p>No versions yet.</p>
              </PanelStateMessage>
            ) : (
              <ul className="flex flex-col gap-0.5">
                {historyCommits.map((commit) => (
                  <li
                    key={commit.sha}
                    className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px]"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium text-foreground" title={commit.message}>
                        {commit.message}
                      </p>
                      <p className="text-[10px] text-muted-foreground">
                        {commit.sha.slice(0, 7)} · {formatRelativeTime(commit.at)}
                      </p>
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={library.busy}
                      onClick={() => {
                        void library.restore(historyPath, commit.sha).then((restored) => {
                          if (restored) {
                            toastManager.add({
                              type: "success",
                              title: "Restored",
                              description: `${historyPath} was restored from ${commit.sha.slice(0, 7)}.`,
                            });
                            void refreshHistory();
                          }
                        });
                      }}
                    >
                      Restore
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      ) : (
        <>
          {viewMode === "list" ? (
            <div
              className="grid grid-cols-[1fr_auto] items-center gap-1 border-b border-[color:var(--color-border-light)] px-2 pb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground"
              role="rowheader"
            >
              {(
                [
                  ["name", "Name"],
                  ["modifiedAt", "Date modified"],
                ] as ReadonlyArray<readonly [LibrarySortKey, string]>
              ).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  className="flex items-center gap-0.5 text-left uppercase"
                  aria-label={`Sort by ${label}`}
                  onClick={() => setSort((current) => nextLibrarySort(current, key))}
                >
                  {label}
                  {sort.key === key ? (
                    sort.direction === "asc" ? (
                      <ArrowUpIcon className="size-2.5" />
                    ) : (
                      <ArrowDownIcon className="size-2.5" />
                    )
                  ) : null}
                </button>
              ))}
            </div>
          ) : null}
          <div className="min-h-0 flex-1 overflow-y-auto p-1" data-library-view={viewMode}>
            {emptyLibrary ? (
              <PanelStateMessage density="compact" fill="flex">
                <p>No files yet. Add documents or artifacts for this group.</p>
              </PanelStateMessage>
            ) : viewMode === "grid" ? (
              <div className="grid grid-cols-2 gap-1 p-1">
                {rows.map((row) => (
                  <LibraryGridTile
                    key={row.entry.relativePath}
                    row={row}
                    renaming={renameTarget === row.entry.relativePath}
                    renameDraft={renameDraft}
                    onRenameDraftChange={setRenameDraft}
                    onRenameCommit={() => void commitRename()}
                    onRenameCancel={() => setRenameTarget(null)}
                    onOpen={handleEntryClick}
                    onContextMenu={handleContextMenu}
                  />
                ))}
              </div>
            ) : (
              <div className="flex flex-col gap-0.5">
                {rows.map((row) => (
                  <LibraryListRow
                    key={row.entry.relativePath}
                    row={row}
                    expanded={expandedDirectories.has(row.entry.relativePath)}
                    renaming={renameTarget === row.entry.relativePath}
                    renameDraft={renameDraft}
                    onRenameDraftChange={setRenameDraft}
                    onRenameCommit={() => void commitRename()}
                    onRenameCancel={() => setRenameTarget(null)}
                    onOpen={handleEntryClick}
                    onContextMenu={handleContextMenu}
                  />
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );

  return (
    <div
      className={PANEL_OVERLAY_WRAPPER_CLASS_NAME}
      data-environment-panel-variant={variant}
      aria-hidden={!open}
    >
      <div
        className={cn(
          ENVIRONMENT_PANEL_SURFACE_CLASS_NAME,
          AUXILIARY_PANEL_MOTION_CLASS,
          "flex w-72 flex-col",
          fullHeight ? "h-full" : "max-h-full",
          open
            ? "pointer-events-auto translate-x-0 opacity-100"
            : "pointer-events-none translate-x-full opacity-0",
        )}
      >
        {content}
      </div>
    </div>
  );
}

function LibraryListRow(props: {
  row: LibraryRow;
  expanded: boolean;
  renaming: boolean;
  renameDraft: string;
  onRenameDraftChange: (value: string) => void;
  onRenameCommit: () => void;
  onRenameCancel: () => void;
  onOpen: (entry: LibraryEntry) => void;
  onContextMenu: (entry: LibraryEntry, event: ReactMouseEvent<HTMLElement>) => void;
}) {
  const { entry, depth } = props.row;
  return (
    <div
      className="grid grid-cols-[1fr_auto] items-center gap-1"
      style={{ paddingLeft: depth * 14 }}
    >
      {props.renaming ? (
        <div className="flex items-center gap-1 px-1 py-0.5">
          <Input
            autoFocus
            value={props.renameDraft}
            aria-label={`Rename ${entry.name}`}
            className="h-6 flex-1 text-[12px]"
            onChange={(event) => props.onRenameDraftChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") props.onRenameCommit();
              if (event.key === "Escape") props.onRenameCancel();
            }}
            onBlur={props.onRenameCommit}
          />
        </div>
      ) : (
        <button
          type="button"
          className={fileRowClassName(false, "h-8 px-2")}
          title={entry.relativePath}
          onClick={() => props.onOpen(entry)}
          onContextMenu={(event) => props.onContextMenu(entry, event)}
        >
          {entry.kind === "directory" ? (
            <DisclosureChevron open={props.expanded} className="size-3 shrink-0 opacity-70" />
          ) : null}
          <FileEntryIcon
            pathValue={entry.name}
            kind={entry.kind}
            expanded={props.expanded}
            className="size-3.5 shrink-0 opacity-75"
          />
          <span className="min-w-0 truncate font-medium">{entry.name}</span>
        </button>
      )}
      <span className="pr-1 text-[10px] text-muted-foreground/80">
        {entry.kind === "file" ? formatRelativeTime(entry.modifiedAt) : ""}
      </span>
    </div>
  );
}

function LibraryGridTile(props: {
  row: LibraryRow;
  renaming: boolean;
  renameDraft: string;
  onRenameDraftChange: (value: string) => void;
  onRenameCommit: () => void;
  onRenameCancel: () => void;
  onOpen: (entry: LibraryEntry) => void;
  onContextMenu: (entry: LibraryEntry, event: ReactMouseEvent<HTMLElement>) => void;
}) {
  const { entry, depth } = props.row;
  if (props.renaming) {
    return (
      <div className="col-span-2 flex items-center gap-1 px-1 py-0.5">
        <Input
          autoFocus
          value={props.renameDraft}
          aria-label={`Rename ${entry.name}`}
          className="h-6 flex-1 text-[12px]"
          onChange={(event) => props.onRenameDraftChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") props.onRenameCommit();
            if (event.key === "Escape") props.onRenameCancel();
          }}
          onBlur={props.onRenameCommit}
        />
      </div>
    );
  }
  return (
    <button
      type="button"
      className={cn(fileRowClassName(false, "h-9 px-2"), depth > 0 && "col-start-auto")}
      title={entry.relativePath}
      onClick={() => props.onOpen(entry)}
      onContextMenu={(event) => props.onContextMenu(entry, event)}
    >
      <FileEntryIcon
        pathValue={entry.name}
        kind={entry.kind}
        className="size-4 shrink-0 opacity-80"
      />
      <span className="flex min-w-0 flex-1 flex-col items-start overflow-hidden">
        <span className="w-full truncate font-medium">{entry.name}</span>
        {depth > 0 ? (
          <span className="w-full truncate text-[10px] text-muted-foreground/70">
            {entry.relativePath}
          </span>
        ) : null}
      </span>
    </button>
  );
}
