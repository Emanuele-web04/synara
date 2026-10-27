// FILE: LibraryPanel.tsx
// Purpose: Group Library panel — the third chat auxiliary surface. Lists the
//          per-group git-versioned file store served by the
//          `projectAgent.library.*` RPCs and the /api/library/upload route:
//          search, type filter, list/grid views, expandable folders, preview,
//          rename/delete, version history with restore, and the remote-push
//          status pill.
// Layer: Chat UI component

import { SidePanelOverlay } from "~/components/chat/SidePanelOverlay";
import type { LibraryCommit, LibraryEntry, ProjectId } from "@synara/contracts";
import { formatBytes } from "@synara/shared/formatBytes";
import {
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { IconButton } from "~/components/ui/icon-button";
import { SearchInput } from "~/components/ui/search-input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { SettingsSegmentedControl } from "~/components/settings/SettingControls";
import { DisclosureChevron } from "~/components/ui/DisclosureChevron";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { toastManager } from "~/components/ui/toast";
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
  HistoryIcon,
  PanelCollapseIcon,
  PanelExpandIcon,
  XIcon,
} from "~/lib/icons";
import { formatRelativeTime } from "~/lib/relativeTime";
import { cn } from "~/lib/utils";
import { readNativeApi } from "~/nativeApi";
import { useStore } from "~/store";
import { createSidebarThreadSummariesSelector } from "~/storeSelectors";

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
import { useTranslation } from "~/i18n";

export interface LibraryPanelProps {
  open: boolean;
  variant: "docked" | "floating";
  projectId: ProjectId | null;
  onClose: () => void;
}

const TYPE_FILTER_OPTIONS: ReadonlyArray<{
  readonly value: LibraryTypeFilter;
  readonly labelKey: string;
}> = [
  { value: "all", labelKey: "workspace:all" },
  { value: "documents", labelKey: "workspace:documents" },
  { value: "images", labelKey: "workspace:images" },
  { value: "code", labelKey: "common:code" },
  { value: "other", labelKey: "chat:other" },
];

const VIEW_MODE_OPTIONS = [
  { value: "list" as const, labelKey: "workspace:list" },
  { value: "grid" as const, labelKey: "workspace:grid" },
];

// The server names delete commits "Delete <relativePath>" (wsRpc.ts) — the only
// whole-library commit kind the row-level Restore button can act on.
function deletedPathFromCommitMessage(message: string): string | null {
  return message.startsWith("Delete ") ? message.slice("Delete ".length) : null;
}

export function LibraryPanel({ open, variant, projectId, onClose }: LibraryPanelProps) {
  const { t, formatLocale } = useTranslation();

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
  // Empty string = the whole-library log (delete/rename commits included); any other
  // value is a per-entry log.
  const [historyScope, setHistoryScope] = useState<"entry" | "library">("entry");
  const [deleteTarget, setDeleteTarget] = useState<LibraryEntry | null>(null);
  const [renameTarget, setRenameTarget] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Set by the row context menu's "Upload here"; cleared after each pick so a
  // plain + Add still lands at the root.
  const uploadDirectoryRef = useRef<string | undefined>(undefined);
  // Latest history request wins — a slow response must not clobber a newer view.
  const historyGenerationRef = useRef(0);

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
      const expanding = !expandedDirectories.has(entry.relativePath);
      setExpandedDirectories((current) => toggleLibraryDirectory(current, entry.relativePath));
      if (expanding && !library.entriesByDir.has(entry.relativePath)) {
        void library.loadDirectory(entry.relativePath);
      }
    },
    [expandedDirectories, library],
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
      const generation = ++historyGenerationRef.current;
      setHistoryPath(entry.relativePath);
      setHistoryScope("entry");
      setHistoryCommits(null);
      const commits = await library.history(entry.relativePath);
      if (historyGenerationRef.current === generation) {
        setHistoryCommits(commits);
      }
    },
    [library],
  );

  const showLibraryHistory = useCallback(async () => {
    const generation = ++historyGenerationRef.current;
    setHistoryPath("");
    setHistoryScope("library");
    setHistoryCommits(null);
    const commits = await library.history();
    if (historyGenerationRef.current === generation) {
      setHistoryCommits(commits);
    }
  }, [library]);

  const refreshHistory = useCallback(async () => {
    if (historyPath === null) return;
    const generation = historyGenerationRef.current;
    const commits =
      historyScope === "library" ? await library.history() : await library.history(historyPath);
    if (historyGenerationRef.current === generation) {
      setHistoryCommits(commits);
    }
  }, [historyPath, historyScope, library]);

  // Cancelling the system picker fires no change event — when focus returns with no
  // files selected, the "Upload here" target would leak into the next root-level Add.
  const pickUploadDirectory = useCallback((directory: string | undefined) => {
    uploadDirectoryRef.current = directory;
    fileInputRef.current?.click();
    const onFocusReturn = () => {
      window.setTimeout(() => {
        const input = fileInputRef.current;
        if (input && (input.files === null || input.files.length === 0)) {
          uploadDirectoryRef.current = undefined;
        }
      }, 250);
    };
    window.addEventListener("focus", onFocusReturn, { once: true });
  }, []);

  const handleContextMenu = useCallback(
    async (entry: LibraryEntry, event: ReactMouseEvent<HTMLElement>) => {
      event.preventDefault();
      const api = readNativeApi();
      if (!api) return;
      const clicked = await api.contextMenu.show(
        [
          { id: "rename" as const, label: t("workspace:rename") },
          ...(entry.kind === "directory"
            ? [{ id: "upload-here" as const, label: t("workspace:uploadHere") }]
            : []),
          { id: "delete" as const, label: t("computer:detail_delete") },
          { id: "history" as const, label: t("workspace:history") },
        ],
        { x: event.clientX, y: event.clientY },
      );
      if (clicked === "upload-here") {
        pickUploadDirectory(entry.relativePath);
        return;
      }
      if (clicked === "rename") {
        setRenameTarget(entry.relativePath);
        setRenameDraft(entry.name);
        return;
      }
      if (clicked === "delete") {
        setDeleteTarget(entry);
        return;
      }
      if (clicked === "history") {
        void showHistory(entry);
      }
    },
    [pickUploadDirectory, showHistory, t],
  );

  const confirmDelete = useCallback(async () => {
    const target = deleteTarget;
    setDeleteTarget(null);
    if (!target) return;
    const deleted = await library.deleteEntry(target.relativePath);
    if (deleted && previewPath === target.relativePath) setPreviewPath(null);
  }, [deleteTarget, library, previewPath]);

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
      const uploadDirectory = uploadDirectoryRef.current;
      uploadDirectoryRef.current = undefined;
      for (const file of Array.from(fileList)) {
        await library.upload(uploadDirectory, file);
      }
      if (fileInputRef.current) fileInputRef.current.value = "";
    },
    [library],
  );

  // The coordinator and its threads write into the library on their own — refetch
  // the loaded listing when the window regains focus and whenever a group thread's
  // latest turn completes, matching how stale the list actually goes.
  useEffect(() => {
    if (!open || !projectId) return;
    const onFocus = () => void library.load();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [open, projectId, library]);

  const selectSidebarThreads = useMemo(() => createSidebarThreadSummariesSelector(), []);
  const sidebarThreads = useStore(selectSidebarThreads);
  const turnCompleteSignature = useMemo(
    () =>
      sidebarThreads
        .filter(
          (thread) => thread.projectId === projectId && thread.latestTurn?.state === "completed",
        )
        .map((thread) => `${thread.id}:${thread.latestTurn?.turnId ?? ""}`)
        .join(","),
    [sidebarThreads, projectId],
  );
  const lastTurnCompleteSignatureRef = useRef(turnCompleteSignature);
  useEffect(() => {
    const changed = lastTurnCompleteSignatureRef.current !== turnCompleteSignature;
    lastTurnCompleteSignatureRef.current = turnCompleteSignature;
    if (changed && open && projectId) {
      void library.load();
    }
  }, [turnCompleteSignature, open, projectId, library]);

  const remoteStatus = library.status;
  const emptyLibrary = rows.length === 0;

  const content = (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1 px-2 pb-1 pt-0.5">
        <EnvironmentPanelTitle>{t("chat:library")}</EnvironmentPanelTitle>
        <div className="ml-auto flex items-center gap-0.5">
          <IconButton
            type="button"
            label={t("workspace:addFiles")}
            tooltip={t("workspace:addFiles")}
            disabled={library.busy}
            onClick={() => pickUploadDirectory(undefined)}
          >
            <AddPlusIcon className="size-3.5" />
          </IconButton>
          <IconButton
            type="button"
            label={t("workspace:libraryHistory")}
            tooltip={t("workspace:history")}
            onClick={() => void showLibraryHistory()}
          >
            <HistoryIcon className="size-3.5" />
          </IconButton>
          <IconButton
            type="button"
            label={fullHeight ? t("workspace:collapseLibrary") : t("workspace:expandLibrary")}
            tooltip={fullHeight ? t("workspace:collapse") : t("chat:generatedImage_expand")}
            onClick={() => setFullHeight((current) => !current)}
          >
            {fullHeight ? (
              <PanelCollapseIcon className="size-3.5" />
            ) : (
              <PanelExpandIcon className="size-3.5" />
            )}
          </IconButton>
          <IconButton
            type="button"
            label={t("workspace:closeLibrary")}
            tooltip={t("common:app_close")}
            onClick={onClose}
          >
            <XIcon className="size-3.5" />
          </IconButton>
        </div>
      </div>

      <div className="px-2 pb-1">
        <SearchInput
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("workspace:searchLibrary2")}
          aria-label={t("workspace:searchLibrary")}
        />
      </div>

      <div className="flex items-center gap-1.5 px-2 pb-1.5">
        {/* Ghost select, like the panel's other pickers: the filter reads as a
            label until it is used, instead of a boxed native control. */}
        <Select
          value={typeFilter}
          onValueChange={(next) => {
            if (next !== null) setTypeFilter(next as LibraryTypeFilter);
          }}
        >
          <SelectTrigger
            variant="ghost"
            size="xs"
            className="w-auto min-w-0"
            aria-label={t("workspace:type")}
          >
            <SelectValue>
              {t(TYPE_FILTER_OPTIONS.find((option) => option.value === typeFilter)!.labelKey)}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup surface="composer">
            {TYPE_FILTER_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {t(option.labelKey)}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        <div className="ml-auto">
          <SettingsSegmentedControl
            value={viewMode}
            onValueChange={setViewMode}
            options={VIEW_MODE_OPTIONS.map((option) => ({
              value: option.value,
              label: t(option.labelKey),
            }))}
            ariaLabel={t("workspace:viewMode")}
          />
        </div>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          aria-label={t("workspace:uploadFilesToTheLibrary")}
          onChange={(event) => void handleUploadChange(event.target.files)}
        />
      </div>

      {remoteStatus?.remoteConfigured ? (
        <div className="flex items-center gap-1.5 px-2 pb-1.5">
          <span
            className={cn(
              "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-ui-xs",
              remoteStatus.lastPushError
                ? "border-destructive/40 text-destructive"
                : "border-[color:var(--color-border)] text-muted-foreground",
            )}
            title={
              remoteStatus.lastPushError ?? remoteStatus.lastPushAt ?? t("workspace:notPushedYet")
            }
          >
            <CloudSyncIcon className="size-3" />
            {remoteStatus.lastPushError
              ? t("git:pushFailed")
              : remoteStatus.lastPushAt
                ? t("workspace:pushed")
                : t("workspace:notPushedYet")}
          </span>
        </div>
      ) : null}

      {library.error ? (
        <p className="px-2 pb-1 text-ui-sm text-destructive" role="alert">
          {library.error}
        </p>
      ) : null}

      {previewPath !== null && library.root ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex items-center px-2 pb-1">
            <button
              type="button"
              aria-label={t("workspace:backToLibraryFrom", { value0: previewPath })}
              title={t("workspace:backToLibrary")}
              className="flex min-w-0 flex-1 items-center gap-1 rounded-md px-1.5 py-0.5 text-left text-ui-sm text-muted-foreground transition-colors hover:bg-[var(--color-background-button-secondary-hover)] hover:text-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
              onClick={() => setPreviewPath(null)}
            >
              <ArrowLeftIcon className="size-3.5 shrink-0" />
              <span className="min-w-0 truncate" title={previewPath}>
                {previewPath}
              </span>
            </button>
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
          <div className="flex items-center px-2 pb-1">
            <button
              type="button"
              aria-label={t("workspace:backToLibraryFromHistory")}
              title={t("workspace:backToLibrary")}
              className="flex min-w-0 flex-1 items-center gap-1 rounded-md px-1.5 py-0.5 text-left text-ui-sm text-muted-foreground transition-colors hover:bg-[var(--color-background-button-secondary-hover)] hover:text-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
              onClick={() => {
                setHistoryPath(null);
                setHistoryCommits(null);
              }}
            >
              <ArrowLeftIcon className="size-3.5 shrink-0" />
              <span
                className="min-w-0 truncate"
                title={historyScope === "library" ? t("chat:library") : historyPath}
              >
                {historyScope === "library"
                  ? t("workspace:history")
                  : t("workspace:history2", { value0: historyPath })}
              </span>
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-1">
            {historyCommits === null ? (
              <PanelStateMessage density="compact" fill="flex">
                <p>{t("workspace:loadingHistory")}</p>
              </PanelStateMessage>
            ) : historyCommits.length === 0 ? (
              <PanelStateMessage density="compact" fill="flex">
                <p>{t("workspace:noVersionsYet")}</p>
              </PanelStateMessage>
            ) : (
              <ul className="flex flex-col gap-0.5">
                {historyCommits.map((commit, index) => {
                  const deletedPath = deletedPathFromCommitMessage(commit.message);
                  const shaBeforeDelete =
                    deletedPath !== null ? historyCommits[index + 1]?.sha : undefined;
                  const restorePath = historyScope === "entry" ? historyPath : deletedPath;
                  const restoreSha = historyScope === "entry" ? commit.sha : shaBeforeDelete;
                  return (
                    <li
                      key={commit.sha}
                      className="flex items-center gap-1.5 rounded-md px-2 py-1 text-ui"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-medium text-foreground" title={commit.message}>
                          {commit.message}
                        </p>
                        <p className="text-ui-xs text-muted-foreground">
                          {commit.sha.slice(0, 7)} ·{" "}
                          {formatRelativeTime(commit.at, undefined, formatLocale)}
                        </p>
                      </div>
                      {restorePath !== null && restoreSha !== undefined ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          disabled={library.busy}
                          onClick={() => {
                            void library.restore(restorePath, restoreSha).then((restored) => {
                              if (restored) {
                                toastManager.add({
                                  type: "success",
                                  title: t("workspace:restored"),
                                  description: t("workspace:wasRestoredFrom", {
                                    value0: restorePath,
                                    value1: restoreSha.slice(0, 7),
                                  }),
                                });
                                void refreshHistory();
                              }
                            });
                          }}
                        >
                          {t("common:app_restore")}
                        </Button>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      ) : (
        <>
          {viewMode === "list" ? (
            // Quiet sentence-case sort headers with no rule under them: the rows
            // below carry the structure.
            <div className="grid grid-cols-[1fr_auto] items-center gap-1 px-3 pb-0.5 text-ui-xs text-muted-foreground">
              {(
                [
                  ["name", "common:scripts_name"],
                  ["modifiedAt", "workspace:dateModified"],
                ] as ReadonlyArray<readonly [LibrarySortKey, string]>
              ).map(([key, labelKey]) => (
                <button
                  key={key}
                  type="button"
                  className="flex items-center gap-0.5 text-left transition-colors hover:text-foreground"
                  aria-label={t("workspace:sortBy", { value0: t(labelKey) })}
                  onClick={() => setSort((current) => nextLibrarySort(current, key))}
                >
                  {t(labelKey)}
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
                {query || typeFilter !== "all" ? (
                  <p>{t("workspace:noFilesMatch")}</p>
                ) : (
                  <p>{t("workspace:noFilesYetAddDocumentsOrArtifactsForThis")}</p>
                )}
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
    <>
      <SidePanelOverlay
        open={open}
        variant={variant}
        // Expanded, the overlay spans the whole chat column so the card's
        // max width is measured against the column, never the window.
        className={fullHeight ? "left-0 items-end" : undefined}
        cardClassName={cn(
          "transition-[width] duration-200 ease-out motion-reduce:transition-none",
          // Collapsed is a narrow card capped below the overlay; expanded grows
          // both ways — full height and a reading width for documents — but
          // never wider than the chat column it sits in.
          fullHeight ? "h-full w-[48rem] max-w-full" : "w-72 max-h-[70%]",
        )}
      >
        {content}
      </SidePanelOverlay>
      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(next) => {
          if (!next) setDeleteTarget(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("computer:detail_delete")}{" "}
              {deleteTarget?.kind === "directory" ? t("workspace:folder2") : t("common:file")} "
              {deleteTarget?.name}
              "?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("workspace:thisRemovesItFromTheLibraryItCanBe")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" size="sm" />}>
              {t("common:form_cancel")}
            </AlertDialogClose>
            <Button
              size="sm"
              variant="destructive"
              disabled={library.busy}
              onClick={() => void confirmDelete()}
            >
              {t("computer:detail_delete")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
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
  const { t, formatLocale } = useTranslation();

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
            aria-label={t("workspace:rename2", { value0: entry.name })}
            className="h-6 flex-1 text-ui"
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
      <span className="pr-1 text-ui-xs text-muted-foreground/80">
        {entry.kind === "file"
          ? t("common:symbol9", {
              value0: formatBytes(entry.sizeBytes),
              value1: formatRelativeTime(entry.modifiedAt, undefined, formatLocale),
            })
          : ""}
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
  const { t } = useTranslation();

  const { entry, depth } = props.row;
  if (props.renaming) {
    return (
      <div className="col-span-2 flex items-center gap-1 px-1 py-0.5">
        <Input
          autoFocus
          value={props.renameDraft}
          aria-label={t("workspace:rename2", { value0: entry.name })}
          className="h-6 flex-1 text-ui"
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
          <span className="w-full truncate text-ui-xs text-muted-foreground/70">
            {entry.relativePath}
          </span>
        ) : null}
      </span>
    </button>
  );
}
