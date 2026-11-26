import type { ThreadId } from "@synara/contracts";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "~/i18n";
import { downloadBlob } from "~/lib/browserDownload";
import { executionStorage } from "~/lib/hosts/executionStorage";
import { ArrowLeftIcon, Minimize2, MoreHorizontalIcon } from "~/lib/icons";
import { cn, randomUUID } from "~/lib/utils";
import { ensureNativeApi } from "~/nativeApi";
import {
  CHAT_MAIN_CONTENT_SURFACE_CLASS_NAME,
  CHAT_MAIN_VIEWPORT_SHELL_CLASS_NAME,
} from "../chat/composerPickerStyles";
import {
  ComposerPickerMenuPopup,
  ComposerPickerMenuSubPopup,
} from "../chat/ComposerPickerMenuPopup";
import { RouteInsetSurface } from "../RouteInsetSurface";
import { RouteSurface, RouteSurfaceHeader } from "../RouteSurface";
import { Button } from "../ui/button";
import { IconButton } from "../ui/icon-button";
import { Menu, MenuItem, MenuSub, MenuSubTrigger, MenuTrigger } from "../ui/menu";
import { toastManager } from "../ui/toast";
import { askInChat, CanvasStatus, openCanvasPane, useCanvasWork } from "./canvasPane";
import { CanvasChatPanel } from "./CanvasChatPanel";
import { CanvasPageMenu } from "./CanvasPageMenu";
import { CanvasPagesSection } from "./CanvasPagesSection";
import { CanvasResourceDialog } from "./CanvasResourceDialog";
import { CANVAS_SIDE_TABS, CanvasSidePanel, type CanvasSideTab } from "./CanvasSidePanel";
import { CanvasEditorProvider } from "./editor/CanvasEditorContext";
import { CanvasEditorSurface } from "./editor/CanvasEditorSurface";
import { CanvasCommentsPanel, canvasCommentCount } from "./editor/CanvasCommentsPanel";
import { CanvasLayersPanel } from "./editor/CanvasLayersPanel";
import { loadCanvasAssets } from "./canvasAssets";
import { canvasQueryKey } from "./canvasWorkCache";
import { useCanvasEditorStore } from "./canvasStores";

const LEFT_TAB_KEY = "synara:canvas-left-tab";

/**
 * Full-size canvas: the route header (back, title, page) over the editor, inside the route's
 * rounded content card: the left panel (Chat, Layers, Comments), the tool strip, the canvas and
 * the inspector, whose top row holds the zoom menu and the work's actions.
 */
export default function CanvasWorkView({
  workId,
  pageId,
  chatThreadId,
}: {
  workId: string;
  pageId: string | undefined;
  chatThreadId: ThreadId | undefined;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { connection, query } = useCanvasWork(workId);
  const work = query.data;
  const [organizing, setOrganizing] = useState(false);
  const [activeChat, setActiveChat] = useState<ThreadId | null>(null);
  const [tab, setTab] = useState<CanvasSideTab>(() => {
    try {
      const stored = executionStorage.getItem(LEFT_TAB_KEY);
      return CANVAS_SIDE_TABS.find((value) => value === stored) ?? "chat";
    } catch {
      return "chat";
    }
  });
  useEffect(() => {
    try {
      executionStorage.setItem(LEFT_TAB_KEY, tab);
    } catch {
      /* A remembered tab is a convenience only. */
    }
  }, [tab]);
  const foldersQuery = useQuery({
    queryKey: [...canvasQueryKey, "folders"],
    queryFn: () => ensureNativeApi().canvas.list({ limit: 1 }),
    enabled: organizing && connection.supported,
  });
  const [rememberedPage] = useState(() => {
    try {
      return executionStorage.getItem(`synara:canvas-page:${workId}`);
    } catch {
      return null;
    }
  });
  const page =
    work?.pages.find((candidate) => candidate.id === (pageId ?? rememberedPage)) ?? work?.pages[0];
  const commentCount = page ? canvasCommentCount(page) : 0;
  useEffect(() => {
    if (!page) return;
    try {
      executionStorage.setItem(`synara:canvas-page:${workId}`, page.id);
    } catch {
      /* The server document remains authoritative when local storage is full. */
    }
  }, [workId, page]);
  const readOnly = work?.readOnly === true || !!work?.archivedAt;
  const selectPage = useCallback(
    (id: string) =>
      void navigate({
        to: "/canvas/$workId",
        params: { workId },
        search: { page: id, chat: activeChat ?? undefined },
      }),
    [activeChat, navigate, workId],
  );
  const openLibrary = useCallback(() => void navigate({ to: "/canvas" }), [navigate]);
  // `.` hides the panels; ⌥1 and ⌘R on a layer bring the Layers tab up.
  const uiHidden = useCanvasEditorStore((state) => state.uiHidden);
  const panelRequest = useCanvasEditorStore((state) => state.panelRequest);
  useEffect(() => {
    if (panelRequest?.kind === "layers" || panelRequest?.kind === "rename") setTab("layers");
  }, [panelRequest]);
  const onActiveThreadChange = useCallback(
    (threadId: ThreadId | null) => setActiveChat(threadId),
    [],
  );
  const action = async (run: () => Promise<void>) => {
    try {
      await run();
    } catch (cause) {
      toastManager.add({
        type: "error",
        title: t("workspace:canvasOperationFailed"),
        description: cause instanceof Error ? cause.message : undefined,
      });
    }
  };
  const exportWork = (format: "json" | "png" | "pdf") =>
    action(async () => {
      const snapshot = await ensureNativeApi().canvas.get({ workId });
      const filename = snapshot.title.replace(/[/\\]/g, "-");
      if (format === "json") {
        downloadBlob(
          new Blob([JSON.stringify(snapshot, null, 2)], { type: "application/json" }),
          `${filename}.synara-canvas.json`,
        );
        return;
      }
      const { exportCanvasPagePng, exportCanvasWorkPdf } = await import("~/lib/canvasExport");
      if (format === "png") {
        const selected = snapshot.pages.find((candidate) => candidate.id === page?.id);
        if (!selected) throw new Error(t("workspace:designLoadFailed"));
        downloadBlob(
          await exportCanvasPagePng(selected, await loadCanvasAssets(workId, snapshot.assets)),
          `${filename}-${selected.title.replace(/[/\\]/g, "-")}.png`,
        );
      } else
        downloadBlob(
          await exportCanvasWorkPdf(snapshot, await loadCanvasAssets(workId, snapshot.assets)),
          `${filename}.pdf`,
        );
    });

  // The work's own controls: in the inspector's top row, or in the header while the panels
  // are hidden.
  const actions = work ? (
    <>
      {activeChat && (
        <Button
          variant="outline"
          size="xs"
          title={t("workspace:canvasCollapseToChat")}
          onClick={() => {
            openCanvasPane(activeChat, work.id, page?.id);
            void navigate({ to: "/$threadId", params: { threadId: activeChat } });
          }}
        >
          <Minimize2 />
          {t("workspace:canvasCollapseToChat")}
        </Button>
      )}
      <Menu keepOpenOnSubmenuInteraction>
        <MenuTrigger
          render={
            <IconButton
              label={t("workspace:canvasActions", { title: work.title })}
              className="-me-1"
            >
              <MoreHorizontalIcon />
            </IconButton>
          }
        />
        <ComposerPickerMenuPopup align="end">
          <MenuItem onClick={() => setOrganizing(true)}>{t("workspace:canvasOrganize")}</MenuItem>
          <MenuSub keepOpenOnFocusOut>
            <MenuSubTrigger>{t("workspace:canvasExportMenu")}</MenuSubTrigger>
            <ComposerPickerMenuSubPopup>
              <MenuItem onClick={() => void exportWork("png")}>
                {t("workspace:canvasExportPng")}
              </MenuItem>
              <MenuItem onClick={() => void exportWork("pdf")}>
                {t("workspace:canvasExportPdf")}
              </MenuItem>
              <MenuItem onClick={() => void exportWork("json")}>
                {t("workspace:canvasExport")}
              </MenuItem>
            </ComposerPickerMenuSubPopup>
          </MenuSub>
          <MenuItem
            onClick={() =>
              void action(async () => {
                const copy = await ensureNativeApi().canvas.duplicate({
                  workId,
                  id: randomUUID(),
                  title: `${work.title.slice(0, 105)} ${t("workspace:canvasCopySuffix")}`,
                });
                await navigate({
                  to: "/canvas/$workId",
                  params: { workId: copy.id },
                  search: { page: undefined, chat: undefined },
                });
              })
            }
          >
            {t("workspace:canvasDuplicate")}
          </MenuItem>
          <MenuItem
            disabled={readOnly && !work.archivedAt}
            onClick={() =>
              void action(async () => {
                await ensureNativeApi().canvas.update({
                  id: workId,
                  archived: !work.archivedAt,
                });
                await query.refetch();
              })
            }
          >
            {readOnly && !work.archivedAt
              ? t("workspace:canvasRestoreFolderFirst")
              : work.archivedAt
                ? t("workspace:canvasRestore")
                : t("workspace:canvasArchive")}
          </MenuItem>
        </ComposerPickerMenuPopup>
      </Menu>
    </>
  ) : null;

  return (
    <div className={cn(CHAT_MAIN_VIEWPORT_SHELL_CLASS_NAME, CHAT_MAIN_CONTENT_SURFACE_CLASS_NAME)}>
      <RouteInsetSurface>
        <RouteSurface>
          <RouteSurfaceHeader>
            <div className="no-drag flex min-w-0 flex-1 items-center gap-1">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t("workspace:canvasAllWorks")}
                onClick={() => void navigate({ to: "/canvas" })}
              >
                <ArrowLeftIcon className="size-4" />
              </Button>
              <h1 className="truncate px-1 text-ui-lg font-medium">
                {work?.title ?? t("workspace:canvasTitle")}
              </h1>
              {work && page && (
                <CanvasPageMenu
                  work={work}
                  pageId={page.id}
                  onSelect={(id) => void selectPage(id)}
                />
              )}
              {readOnly && (
                <span className="text-ui-xs text-muted-foreground">
                  {t("workspace:canvasArchived")}
                </span>
              )}
              {uiHidden && actions ? (
                <div className="ms-auto flex items-center gap-2">{actions}</div>
              ) : null}
            </div>
          </RouteSurfaceHeader>
          {!work || !page ? (
            <CanvasStatus connection={connection} error={query.isError} />
          ) : (
            <CanvasEditorProvider
              work={work}
              pageId={page.id}
              readOnly={readOnly}
              threadId={activeChat}
              onAskAgent={
                activeChat
                  ? (prompt) => {
                      setTab("chat");
                      askInChat(activeChat, prompt);
                    }
                  : null
              }
              onSelectPage={selectPage}
              onOpenLibrary={openLibrary}
            >
              {/* The editor fills the route's content card like any route body; its panels sit on
                  the card's own surface, and its corners follow the card's (the rail layout's
                  block radii), so the canvas never paints a square corner over the rounded edge. */}
              <div className="flex min-h-0 flex-1 overflow-hidden rounded-[var(--app-rail-block-radii,0)] text-foreground">
                <CanvasSidePanel
                  tab={tab}
                  onTab={setTab}
                  commentCount={commentCount}
                  hidden={uiHidden}
                  panels={{
                    chat: (
                      <CanvasChatPanel
                        work={work}
                        pageId={page.id}
                        readOnly={readOnly}
                        preferredThreadId={chatThreadId}
                        onActiveThreadChange={onActiveThreadChange}
                      />
                    ),
                    layers: (
                      <>
                        <CanvasPagesSection
                          work={work}
                          pageId={page.id}
                          onSelect={(id) => void selectPage(id)}
                        />
                        <CanvasLayersPanel className="flex-1" />
                      </>
                    ),
                    comments: <CanvasCommentsPanel className="flex-1" />,
                  }}
                />
                <CanvasEditorSurface inspector actions={uiHidden ? undefined : actions} />
              </div>
            </CanvasEditorProvider>
          )}
          {organizing && work && (
            <CanvasResourceDialog
              title={t("workspace:canvasOrganize")}
              initial={{ title: work.title, folderId: work.folderId, projectId: work.projectId }}
              folders={foldersQuery.data?.folders ?? []}
              work
              onClose={() => setOrganizing(false)}
              onSave={async (fields) => {
                await ensureNativeApi().canvas.update({ id: workId, ...fields });
                await query.refetch();
              }}
            />
          )}
        </RouteSurface>
      </RouteInsetSurface>
    </div>
  );
}
