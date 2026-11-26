// FILE: CanvasLibraryView.tsx
// Purpose: The canvas library: Recent, Files and Archive, grid or list, search, thumbnails (the
//          work's cover frame, else its first frame, with the fonts and images it uses) and each
//          work's or folder's menu (Open, Rename, Duplicate, Move to, Project, Archive or Restore).
// Layer: Canvas UI route
// Exports: default CanvasLibraryView

import type {
  CanvasFolder,
  CanvasListInput,
  CanvasResourceUpdateInput,
  CanvasWorkSummary,
  ProjectId,
} from "@synara/contracts";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "~/i18n";
import { CentralIcon } from "~/lib/central-icons";
import { executionStorage } from "~/lib/hosts/executionStorage";
import { CanvasIcon, FolderIcon, MoreHorizontalIcon, PlusIcon } from "~/lib/icons";
import { cn, randomUUID } from "~/lib/utils";
import { ensureNativeApi } from "~/nativeApi";
import { useStore } from "~/store";
import { CanvasAgentIndicator } from "./editor/CanvasAgentActivity";
import { CanvasFramePreview } from "./editor/CanvasFramePreview";
import { RenameDialog } from "../RenameDialog";
import { RouteInsetSurface } from "../RouteInsetSurface";
import { RouteSurface, RouteSurfaceHeader } from "../RouteSurface";
import { SegmentedPicker } from "../SegmentedPicker";
import { WorkspaceSurfaceComputerPicker } from "../hosts/ComputerPicker";
import {
  ComposerPickerMenuPopup,
  ComposerPickerMenuSubPopup,
} from "../chat/ComposerPickerMenuPopup";
import { Button } from "../ui/button";
import { IconButton } from "../ui/icon-button";
import {
  Menu,
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  MenuSubTrigger,
  MenuTrigger,
} from "../ui/menu";
import { SearchInput } from "../ui/search-input";
import { CanvasResourceDialog, type CanvasResourceFields } from "./CanvasResourceDialog";
import { useActiveAgentPages } from "./canvasStores";
import { canvasQueryKey } from "./canvasWorkCache";
import { useCanvasLibrary } from "./useCanvasLibrary";
import { useCanvasPreviewContext } from "./canvasAssets";
import { canvasFolderTree } from "./canvasFolderTree";
import { CANVAS_SURFACE_CLASS_NAME } from "./CanvasFrameStrip";

const PAGE_SIZE = 50;
const VIEW_KEY = "synara:canvas-library-view";
type Section = "recent" | "files" | "archive";
type View = "grid" | "list";
type Resource = CanvasWorkSummary | CanvasFolder;

function readView(): View {
  try {
    return executionStorage.getItem(VIEW_KEY) === "list" ? "list" : "grid";
  } catch {
    return "grid";
  }
}

/**
 * The work's thumbnail, scaled to fit `height` px (and the container's width), on the canvas
 * backdrop with the fonts and images its frame uses.
 */
function CanvasPreview({ work, height }: { work: CanvasWorkSummary; height: number }) {
  const context = useCanvasPreviewContext(work.id, work.previewAssets);
  const container = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = container.current!;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const preview = work.preview;
  const scale = preview ? Math.min(width / preview.width, height / preview.height) : 1;
  return (
    <div
      ref={container}
      className={cn(
        "relative flex size-full items-center justify-center overflow-hidden",
        CANVAS_SURFACE_CLASS_NAME,
      )}
      aria-hidden="true"
    >
      {preview && width > 0 ? (
        <div style={{ width: preview.width * scale, height: preview.height * scale }}>
          <div className="origin-top-left" style={{ transform: `scale(${scale})` }}>
            <CanvasFramePreview frame={preview} context={context} />
          </div>
        </div>
      ) : (
        // An empty work's mark, sized to its well: the list's small thumbnail gets a small one.
        <CanvasIcon
          className={cn("text-muted-foreground/72", height > 100 ? "size-9" : "size-5")}
        />
      )}
    </div>
  );
}

/**
 * After a work's title, while an agent works on any of its pages: the activity stream reaches
 * the library with no editor open (`CanvasEventBridge` records it at the app's root).
 */
function WorkAgentIndicator({ workId }: { workId: string }) {
  return <CanvasAgentIndicator active={useActiveAgentPages(workId).size > 0} scope="work" />;
}

/** Creating a work or a folder (renaming has its own dialog). */
type DialogState = { kind: "work" | "folder"; id: string };

/** Refreshes the list and folders; cached works update from their own change events. */
const refreshList = (client: QueryClient) =>
  client.invalidateQueries({
    queryKey: canvasQueryKey,
    predicate: (query) => query.queryKey[1] !== "work",
  });

/** Folders inside `folderId`, at any depth (a folder cannot move into one of them). */
function descendantsOf(folderId: string, folders: readonly CanvasFolder[]) {
  const found = new Set([folderId]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const folder of folders)
      if (folder.folderId && found.has(folder.folderId) && !found.has(folder.id)) {
        found.add(folder.id);
        grew = true;
      }
  }
  return found;
}

export default function CanvasLibraryView() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const client = useQueryClient();
  const connection = useCanvasLibrary();
  const projects = useStore((state) => state.projects).filter((project) => project.kind !== "chat");
  const [section, setSection] = useState<Section>("recent");
  const [view, setView] = useState<View>(readView);
  const [folderId, setFolderId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [renaming, setRenaming] = useState<Resource | null>(null);
  const [renameOpen, setRenameOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(search.trim());
      setOffset(0);
    }, 180);
    return () => clearTimeout(timer);
  }, [search]);
  useEffect(() => {
    try {
      executionStorage.setItem(VIEW_KEY, view);
    } catch {
      /* A remembered layout is a convenience only. */
    }
  }, [view]);
  const archived = section === "archive";
  const searching = debouncedSearch !== "";
  // Recent lists every work by its last change; Files one folder (a search looks everywhere).
  const input: CanvasListInput = {
    archived,
    search: debouncedSearch,
    offset,
    limit: PAGE_SIZE,
    ...(section === "files" && !searching ? { folderId } : {}),
    ...(section === "archive" && folderId ? { folderId } : {}),
  };
  const query = useQuery({
    queryKey: [...canvasQueryKey, "list", input],
    queryFn: () => ensureNativeApi().canvas.list(input),
    enabled: connection.supported,
  });
  const folders = query.data?.folders ?? [];
  const works = query.data?.works ?? [];
  const folderById = new Map(folders.map((folder) => [folder.id, folder]));
  const trail: CanvasFolder[] = [];
  for (let at = folderId ? folderById.get(folderId) : undefined; at; ) {
    if (trail.includes(at)) break;
    trail.unshift(at);
    at = at.folderId ? folderById.get(at.folderId) : undefined;
  }
  const shownFolders =
    section === "recent" || searching
      ? []
      : folders.filter((folder) => folder.folderId === folderId || (archived && folderId === null));
  const writable = !archived && connection.supported && !connection.disconnected;

  const goTo = (next: Section | null, folder: string | null = null) => {
    if (next) setSection(next);
    setFolderId(folder);
    setOffset(0);
  };
  const open = (resource: Resource) => {
    if (resource.kind === "folder") return goTo(null, resource.id);
    void navigate({
      to: "/canvas/$workId",
      params: { workId: resource.id },
      search: { page: undefined, chat: undefined },
    });
  };
  const action = async (run: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await run();
      await refreshList(client);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("workspace:canvasOperationFailed"));
    } finally {
      setBusy(false);
    }
  };
  const update = (id: string, fields: Omit<CanvasResourceUpdateInput, "id">) =>
    void action(() => ensureNativeApi().canvas.update({ ...fields, id }));

  const resourceMenu = (resource: Resource) => {
    const blockedByFolder = archived && !resource.archivedAt;
    const blocked = resource.kind === "folder" ? descendantsOf(resource.id, folders) : new Set();
    // Folders as their tree: a subfolder sits under its parent, indented a level.
    const destinations = canvasFolderTree(
      folders.filter((folder) => !folder.archivedAt && !blocked.has(folder.id)),
    );
    return (
      <Menu>
        <MenuTrigger
          render={
            <IconButton
              label={t("workspace:canvasActions", { title: resource.title })}
              className="shrink-0"
            >
              <MoreHorizontalIcon />
            </IconButton>
          }
        />
        <ComposerPickerMenuPopup>
          <MenuItem onClick={() => open(resource)}>{t("workspace:canvasOpen")}</MenuItem>
          {!archived && (
            <MenuItem
              disabled={busy}
              onClick={() => {
                setRenaming(resource);
                setRenameOpen(true);
              }}
            >
              {t("workspace:canvasMenuRename")}
            </MenuItem>
          )}
          {resource.kind === "work" && (
            <MenuItem
              disabled={busy}
              onClick={() =>
                void action(() =>
                  ensureNativeApi().canvas.duplicate({
                    workId: resource.id,
                    id: randomUUID(),
                    title: `${resource.title.slice(0, 105)} ${t("workspace:canvasCopySuffix")}`,
                  }),
                )
              }
            >
              {t("workspace:canvasDuplicate")}
            </MenuItem>
          )}
          {!archived && (
            <MenuSub>
              <MenuSubTrigger disabled={busy}>{t("workspace:canvasMoveTo")}</MenuSubTrigger>
              <ComposerPickerMenuSubPopup>
                <MenuItem
                  disabled={resource.folderId === null}
                  onClick={() => update(resource.id, { folderId: null })}
                >
                  <CanvasIcon className="size-3.5 shrink-0 opacity-70" />
                  {t("workspace:canvasFiles")}
                </MenuItem>
                {destinations.length > 0 && <MenuSeparator />}
                {destinations.map(({ folder, depth }) => (
                  <MenuItem
                    key={folder.id}
                    data-folder-depth={depth}
                    disabled={resource.folderId === folder.id}
                    style={{
                      paddingInlineStart: `calc(var(--picker-option-px, 8px) + ${depth * 16}px)`,
                    }}
                    onClick={() => update(resource.id, { folderId: folder.id })}
                  >
                    <FolderIcon className="size-3.5 shrink-0 opacity-70" />
                    <span className="truncate">{folder.title}</span>
                  </MenuItem>
                ))}
              </ComposerPickerMenuSubPopup>
            </MenuSub>
          )}
          {!archived && resource.kind === "work" && (
            <MenuSub>
              <MenuSubTrigger disabled={busy}>{t("workspace:canvasProject")}</MenuSubTrigger>
              <ComposerPickerMenuSubPopup>
                <MenuRadioGroup
                  value={resource.projectId ?? ""}
                  onValueChange={(value: string) =>
                    update(resource.id, { projectId: (value || null) as ProjectId | null })
                  }
                >
                  <MenuRadioItem value="">{t("workspace:canvasStandalone")}</MenuRadioItem>
                  {projects.map((project) => (
                    <MenuRadioItem key={project.id} value={project.id}>
                      <span className="truncate">{project.name}</span>
                    </MenuRadioItem>
                  ))}
                </MenuRadioGroup>
              </ComposerPickerMenuSubPopup>
            </MenuSub>
          )}
          <MenuSeparator />
          <MenuItem
            disabled={busy || blockedByFolder}
            onClick={() => update(resource.id, { archived: !resource.archivedAt })}
          >
            {blockedByFolder
              ? t("workspace:canvasRestoreFolderFirst")
              : resource.archivedAt
                ? t("workspace:canvasRestore")
                : t("workspace:canvasArchive")}
          </MenuItem>
        </ComposerPickerMenuPopup>
      </Menu>
    );
  };
  const saveResource = async (fields: CanvasResourceFields) => {
    if (!dialog) return;
    const api = ensureNativeApi().canvas;
    if (dialog.kind === "folder")
      await api.createFolder({ id: dialog.id, title: fields.title, folderId: fields.folderId });
    else {
      const work = await api.create({ id: dialog.id, ...fields });
      await navigate({
        to: "/canvas/$workId",
        params: { workId: work.id },
        search: { page: work.pages[0]!.id, chat: undefined },
      });
    }
    await refreshList(client);
  };
  const subtitle = (work: CanvasWorkSummary) =>
    `${t("workspace:canvasPageCount", { count: work.pageCount })} · ${new Date(work.updatedAt).toLocaleDateString()}`;
  const empty = query.data !== undefined && works.length === 0 && shownFolders.length === 0;
  const emptyTitle = searching
    ? t("workspace:canvasSearchEmpty", { query: debouncedSearch })
    : archived
      ? t("workspace:canvasArchiveEmpty")
      : section === "files" && folderId
        ? t("workspace:canvasFolderEmpty")
        : t("workspace:canvasEmpty");
  const emptyHint = searching
    ? null
    : section === "files" && folderId
      ? t("workspace:canvasFolderEmptyHint")
      : archived
        ? null
        : t("workspace:canvasEmptyHint");
  const rootLabel = archived ? t("workspace:canvasArchive") : t("workspace:canvasFiles");

  return (
    <RouteInsetSurface>
      <RouteSurface>
        <RouteSurfaceHeader>
          <div className="no-drag flex min-w-0 flex-1 items-center gap-2">
            <CanvasIcon className="size-5 shrink-0" />
            <h1 className="text-ui-lg font-medium">{t("workspace:canvasTitle")}</h1>
            <WorkspaceSurfaceComputerPicker path="/canvas" />
            <div className="ms-auto flex items-center gap-2">
              <Button
                size="sm"
                disabled={!connection.supported || connection.disconnected}
                onClick={() => setDialog({ kind: "work", id: randomUUID() })}
              >
                <PlusIcon className="size-4" />
                {t("workspace:canvasNew")}
              </Button>
            </div>
          </div>
        </RouteSurfaceHeader>
        {/* 256px cards 24px apart, on the route card's own surface. */}
        <div className="flex min-h-0 flex-1 flex-col overflow-auto p-5 text-foreground sm:p-8">
          <div className="mx-auto w-full max-w-6xl space-y-6">
            <div className="flex flex-wrap items-center gap-3">
              <SegmentedPicker<Section>
                variant="buttons"
                ariaLabel={t("workspace:canvasLibrarySections")}
                value={section}
                disabled={!connection.supported}
                onValueChange={(next) => goTo(next)}
                options={[
                  { value: "recent", label: t("workspace:canvasRecent") },
                  { value: "files", label: t("workspace:canvasFiles") },
                  { value: "archive", label: t("workspace:canvasArchive") },
                ]}
              />
              <div className="ms-auto flex min-w-0 items-center gap-2">
                <div className="w-56 max-w-full">
                  <SearchInput
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder={t("workspace:canvasSearch")}
                    aria-label={t("workspace:canvasSearch")}
                  />
                </div>
                {/* The app's neutral segmented control, not an accent fill. */}
                <SegmentedPicker<View>
                  size="sm"
                  iconOnly
                  ariaLabel={t("workspace:canvasLibraryLayout")}
                  value={view}
                  className="w-auto shrink-0"
                  onValueChange={setView}
                  options={[
                    {
                      value: "grid",
                      label: t("workspace:canvasGridView"),
                      icon: <CentralIcon name="layout-grid-1" className="size-3.5" />,
                    },
                    {
                      value: "list",
                      label: t("workspace:canvasListView"),
                      icon: <CentralIcon name="list-bullets" className="size-3.5" />,
                    },
                  ]}
                />
              </div>
            </div>
            {section !== "recent" && !searching && (
              <div className="flex flex-wrap items-center gap-1">
                <nav aria-label={t("workspace:canvasFolder")} className="flex items-center gap-1">
                  {[null, ...trail].map((folder, index) => {
                    const current = index === trail.length;
                    return (
                      <span key={folder?.id ?? "root"} className="flex items-center gap-1">
                        {index > 0 && (
                          <span className="text-ui-sm text-muted-foreground/72">/</span>
                        )}
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-current={current ? "page" : undefined}
                          onClick={() => goTo(null, folder?.id ?? null)}
                        >
                          {folder?.title ?? rootLabel}
                        </Button>
                      </span>
                    );
                  })}
                </nav>
                {trail.at(-1) && resourceMenu(trail.at(-1)!)}
                {section === "files" && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="ms-auto"
                    disabled={!writable}
                    onClick={() => setDialog({ kind: "folder", id: randomUUID() })}
                  >
                    {t("workspace:canvasNewFolder")}
                  </Button>
                )}
              </div>
            )}
            {(error || query.isError || connection.disconnected) && (
              <div className="flex items-center gap-3 text-ui-sm text-destructive" role="alert">
                {error ??
                  (connection.disconnected
                    ? t("workspace:designSyncFailed")
                    : t("workspace:designLoadFailed"))}
                <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
                  {t("workspace:designRetry")}
                </Button>
              </div>
            )}
            {!connection.supported && (
              <p className="py-12 text-center text-ui text-muted-foreground" role="status">
                {connection.negotiating
                  ? t("workspace:designLoading")
                  : t("workspace:canvasHostUnavailable")}
              </p>
            )}
            {query.data?.unavailableIds.length ? (
              <p className="text-ui-sm text-destructive" role="alert">
                {t("workspace:canvasUnreadable", { count: query.data.unavailableIds.length })}
              </p>
            ) : null}
            {empty ? (
              <div className="flex flex-col items-center gap-3 py-20 text-center" role="status">
                <CanvasIcon className="size-10 text-muted-foreground/72" />
                <h2 className="text-ui-lg font-medium">{emptyTitle}</h2>
                {emptyHint && (
                  <p className="max-w-md text-ui-sm text-muted-foreground">{emptyHint}</p>
                )}
              </div>
            ) : view === "grid" ? (
              <>
                {shownFolders.length > 0 && (
                  <div className="grid grid-cols-[repeat(auto-fill,minmax(256px,1fr))] gap-6">
                    {shownFolders.map((folder) => (
                      <div
                        key={folder.id}
                        data-canvas-folder={folder.id}
                        className="flex h-12 items-center gap-1 rounded-lg border border-border bg-card ps-1 pe-3"
                      >
                        <button
                          type="button"
                          className="flex h-full min-w-0 flex-1 items-center gap-3 rounded-lg px-2 text-start text-ui-sm font-medium outline-none focus-visible:ring-1 focus-visible:ring-ring"
                          onClick={() => open(folder)}
                        >
                          <FolderIcon className="size-4 shrink-0 text-muted-foreground" />
                          <span className="truncate">{folder.title}</span>
                        </button>
                        {resourceMenu(folder)}
                      </div>
                    ))}
                  </div>
                )}
                <div className="grid grid-cols-[repeat(auto-fill,minmax(256px,1fr))] gap-6">
                  {works.map((work) => (
                    // The whole card opens the work (the thumbnail's button reaches over it), and
                    // its title row tints on hover, as the chat's canvas card does; the menu
                    // stays its own button.
                    <article
                      key={work.id}
                      className="group/work-card relative overflow-hidden rounded-lg border border-border bg-card p-1"
                      data-canvas-work={work.id}
                    >
                      <button
                        className="block aspect-[256/168] w-full overflow-hidden rounded-md text-start outline-none after:absolute after:inset-0 focus-visible:ring-1 focus-visible:ring-ring"
                        onClick={() => open(work)}
                        aria-label={t("workspace:canvasOpenWork", { title: work.title })}
                      >
                        <CanvasPreview work={work} height={168} />
                      </button>
                      <div className="mt-1 flex items-center gap-2 rounded-md ps-2 pe-1.5 pt-1 pb-1.5 transition-colors group-hover/work-card:bg-[var(--color-background-button-secondary-hover)]">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5">
                            <h2 className="min-w-0 truncate text-ui-sm font-medium">
                              {work.title}
                            </h2>
                            <WorkAgentIndicator workId={work.id} />
                          </div>
                          <p className="mt-0.5 truncate text-ui-xs text-muted-foreground">
                            {subtitle(work)}
                          </p>
                        </div>
                        <div className="relative">{resourceMenu(work)}</div>
                      </div>
                    </article>
                  ))}
                </div>
              </>
            ) : (
              <ul className="-mx-2 flex flex-col" aria-label={t("workspace:canvasTitle")}>
                {[...shownFolders, ...works].map((resource) => (
                  <li
                    key={resource.id}
                    {...(resource.kind === "work"
                      ? { "data-canvas-work": resource.id }
                      : { "data-canvas-folder": resource.id })}
                    className="flex items-center gap-4 rounded-md p-2 hover:bg-[var(--color-background-button-secondary-hover)]"
                  >
                    <button
                      className="flex min-w-0 flex-1 items-center gap-4 rounded-md text-start outline-none focus-visible:ring-1 focus-visible:ring-ring"
                      onClick={() => open(resource)}
                      aria-label={
                        resource.kind === "work"
                          ? t("workspace:canvasOpenWork", { title: resource.title })
                          : undefined
                      }
                    >
                      <span
                        className={cn(
                          "flex aspect-[256/168] w-24 shrink-0 items-center justify-center overflow-hidden rounded-md",
                          CANVAS_SURFACE_CLASS_NAME,
                        )}
                      >
                        {resource.kind === "work" ? (
                          <CanvasPreview work={resource} height={63} />
                        ) : (
                          <FolderIcon className="size-4 text-muted-foreground" />
                        )}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-1.5">
                          <span className="min-w-0 truncate text-ui-sm font-medium">
                            {resource.title}
                          </span>
                          {resource.kind === "work" && <WorkAgentIndicator workId={resource.id} />}
                        </span>
                        {resource.kind === "work" && (
                          <span className="block text-ui-xs text-muted-foreground">
                            {subtitle(resource)}
                          </span>
                        )}
                      </span>
                    </button>
                    {resourceMenu(resource)}
                  </li>
                ))}
              </ul>
            )}
            {query.data && query.data.total > PAGE_SIZE && (
              <div className="flex items-center justify-center gap-3">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={offset === 0}
                  onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
                >
                  {t("workspace:canvasPrevious")}
                </Button>
                <span className="text-ui-sm text-muted-foreground">
                  {offset + 1}–{Math.min(offset + PAGE_SIZE, query.data.total)} / {query.data.total}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={offset + PAGE_SIZE >= query.data.total}
                  onClick={() => setOffset(offset + PAGE_SIZE)}
                >
                  {t("workspace:canvasNext")}
                </Button>
              </div>
            )}
          </div>
        </div>
        {dialog && (
          <CanvasResourceDialog
            key={dialog.id}
            title={t(
              dialog.kind === "folder" ? "workspace:canvasNewFolder" : "workspace:canvasNew",
            )}
            initial={{
              title: "",
              folderId: section === "files" && !searching ? folderId : null,
              projectId: null,
            }}
            folders={folders.filter((folder) => !folder.archivedAt)}
            work={dialog.kind === "work"}
            onClose={() => setDialog(null)}
            onSave={saveResource}
          />
        )}
        <RenameDialog
          open={renameOpen}
          title={t(
            renaming?.kind === "folder"
              ? "workspace:canvasRenameFolder"
              : "workspace:canvasRenameWork",
          )}
          initialValue={renaming?.title ?? ""}
          maxLength={120}
          onOpenChange={setRenameOpen}
          onSave={async (title) => {
            const resource = renaming;
            if (!resource || title === resource.title) return;
            setError(null);
            try {
              await ensureNativeApi().canvas.update({ id: resource.id, title });
            } catch (cause) {
              setError(
                cause instanceof Error ? cause.message : t("workspace:canvasOperationFailed"),
              );
              throw cause;
            }
            await refreshList(client);
          }}
        />
      </RouteSurface>
    </RouteInsetSurface>
  );
}
