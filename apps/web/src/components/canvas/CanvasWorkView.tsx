import type { ThreadId } from "@synara/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "~/i18n";
import { downloadBlob } from "~/lib/browserDownload";
import { executionStorage } from "~/lib/hosts/executionStorage";
import { ArrowLeftIcon, Minimize2, MoreHorizontalIcon } from "~/lib/icons";
import { cn, randomUUID } from "~/lib/utils";
import { ensureNativeApi } from "~/nativeApi";
import { ChatHeaderButton, ChatHeaderIconButton } from "../chat/chatHeaderControls";
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
import { Menu, MenuItem, MenuSub, MenuSubTrigger, MenuTrigger } from "../ui/menu";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  askInChat,
  CanvasHeaderStatus,
  CanvasStatus,
  openCanvasPane,
  showCanvasArchiveUndo,
  useCanvasWork,
} from "./canvasPane";
import { CanvasChatPanel } from "./CanvasChatPanel";
import { CanvasPageMenu } from "./CanvasPageMenu";
import { CanvasPagesSection } from "./CanvasPagesSection";
import { CanvasResourceDialog } from "./CanvasResourceDialog";
import { CANVAS_SIDE_TABS, CanvasSidePanel, type CanvasSideTab } from "./CanvasSidePanel";
import { CanvasEditorProvider } from "./editor/CanvasEditorContext";
import { CanvasEditorSurface } from "./editor/CanvasEditorSurface";
import { CanvasZoomMenu } from "./editor/CanvasToolbar";
import { CanvasCommentsPanel, canvasCommentCount } from "./editor/CanvasCommentsPanel";
import { CanvasLayersPanel } from "./editor/CanvasLayersPanel";
import { loadCanvasAssets } from "./canvasAssets";
import { canvasQueryKey } from "./canvasWorkCache";
import { useCanvasEditorStore } from "./canvasStores";
import { runCanvasJob } from "./editor/canvasToasts";

const LEFT_TAB_KEY = "synara:canvas-left-tab";

/**
 * Full-size canvas: the app's top bar (back, title and page on the left; the zoom menu, Back to
 * chat and the work's menu on the right, like the chat header's actions) over the editor, inside
 * the route's rounded content card: the left panel (Chat, Layers, Comments), the canvas with its
 * floating toolbar, and the inspector.
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
  const client = useQueryClient();
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
  const commentCount = work ? canvasCommentCount(work) : 0;
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
  // The top bar's zoom menu drives the canvas in the editor body below it.
  const body = useRef<HTMLDivElement>(null);
  const viewportElement = useCallback(
    () => body.current?.querySelector<HTMLElement>("[data-canvas-viewport]") ?? null,
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
  const exportJson = () =>
    action(async () => {
      const snapshot = await ensureNativeApi().canvas.get({ workId });
      downloadBlob(
        new Blob([JSON.stringify(snapshot, null, 2)], { type: "application/json" }),
        `${snapshot.title.replace(/[/\\]/g, "-")}.synara-canvas.json`,
      );
    });
  /** The page as PNG or the work as PDF: rendered under the app's progress toast. */
  const exportWork = (format: "png" | "pdf") =>
    runCanvasJob(
      t("workspace:canvasExporting"),
      async () => {
        const snapshot = await ensureNativeApi().canvas.get({ workId });
        const filename = snapshot.title.replace(/[/\\]/g, "-");
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
        return 1;
      },
      {
        success: (files) => t("workspace:canvasExportedFiles", { count: files }),
        failure: (cause) => ({
          title: t("workspace:canvasExportFailed"),
          description: cause instanceof Error ? cause.message : undefined,
        }),
      },
    );

  // The work's own controls, at the end of the top bar.
  const actionsLabel = work ? t("workspace:canvasActions", { title: work.title }) : "";
  const actions = work ? (
    <>
      {activeChat && (
        <ChatHeaderButton
          tone="outline"
          onClick={() => {
            openCanvasPane(activeChat, work.id, page?.id);
            void navigate({ to: "/$threadId", params: { threadId: activeChat } });
          }}
        >
          <Minimize2 />
          {t("workspace:canvasCollapseToChat")}
        </ChatHeaderButton>
      )}
      <Menu keepOpenOnSubmenuInteraction>
        <Tooltip>
          <TooltipTrigger
            render={
              <MenuTrigger
                render={<ChatHeaderIconButton type="button" tone="surface" label={actionsLabel} />}
              >
                <MoreHorizontalIcon className="size-4" />
              </MenuTrigger>
            }
          />
          <TooltipPopup side="bottom">{actionsLabel}</TooltipPopup>
        </Tooltip>
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
              <MenuItem onClick={() => void exportJson()}>{t("workspace:canvasExport")}</MenuItem>
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
                const archiving = !work.archivedAt;
                await ensureNativeApi().canvas.update({ id: workId, archived: archiving });
                await query.refetch();
                // Archiving offers the app's compact Undo, as archiving a chat does.
                if (archiving)
                  showCanvasArchiveUndo(client, {
                    id: workId,
                    message: t("workspace:canvasArchivedToast"),
                    failedTitle: t("workspace:canvasOperationFailed"),
                  });
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

  /** The top bar: back, the title and the page picker on the left, `trailing` on the right. */
  const header = (trailing: ReactNode) => (
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
          <CanvasPageMenu work={work} pageId={page.id} onSelect={(id) => void selectPage(id)} />
        )}
        {work && (
          <CanvasHeaderStatus workId={work.id} readOnly={readOnly} connection={connection} />
        )}
      </div>
      {trailing ? (
        <div className="flex shrink-0 items-center gap-2 [-webkit-app-region:no-drag]">
          {trailing}
        </div>
      ) : null}
    </RouteSurfaceHeader>
  );

  return (
    <div className={cn(CHAT_MAIN_VIEWPORT_SHELL_CLASS_NAME, CHAT_MAIN_CONTENT_SURFACE_CLASS_NAME)}>
      <RouteInsetSurface>
        <RouteSurface>
          {!work || !page ? (
            <>
              {header(actions)}
              <CanvasStatus connection={connection} error={query.isError} />
            </>
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
              {header(
                <>
                  <CanvasZoomMenu variant="topbar" viewportElement={viewportElement} />
                  {actions}
                </>,
              )}
              {/* The editor fills the route's content card like any route body; its panels sit on
                  the card's own surface, and its corners follow the card's (the rail layout's
                  block radii), so the canvas never paints a square corner over the rounded edge. */}
              <div
                ref={body}
                className="flex min-h-0 flex-1 overflow-hidden rounded-[var(--app-rail-block-radii,0)] text-foreground"
              >
                <CanvasSidePanel
                  tab={tab}
                  onTab={setTab}
                  chatThreadId={activeChat}
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
                          onRenameDone={() => viewportElement()?.focus({ preventScroll: true })}
                        />
                        <CanvasLayersPanel className="flex-1" />
                      </>
                    ),
                    comments: <CanvasCommentsPanel className="flex-1" />,
                  }}
                />
                <CanvasEditorSurface inspector zoomInHeader />
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
