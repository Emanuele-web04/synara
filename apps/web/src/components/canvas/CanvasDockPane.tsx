import type { CanvasWork, ThreadId } from "@synara/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "~/i18n";
import { createCentralIconComponent } from "~/lib/central-icons";
import { useContainerSize } from "~/lib/pdf/useContainerSize";
import { cn } from "~/lib/utils";
import { selectRightDockState, useRightDockStore } from "~/rightDockStore";
import {
  CHAT_SURFACE_HEADER_DIVIDER_CLASS_NAME,
  DOCK_HEADER_ICON_BUTTON_CLASS,
} from "../chat/chatHeaderControls";
import { DockPaneHeader } from "../chat/DockPaneHeader";
import { IconButton } from "../ui/icon-button";
import { CanvasEditorProvider } from "./editor/CanvasEditorContext";
import { CanvasEditorSurface } from "./editor/CanvasEditorSurface";
import { CanvasZoomMenu } from "./editor/CanvasToolbar";
import { askInChat, CanvasStatus, openCanvasPane, useCanvasWork } from "./canvasPane";
import { CanvasPageMenu } from "./CanvasPageMenu";

/** Below this width the side pane shows the canvas alone; Open full size has the full layout. */
const INSPECTOR_MIN_PANE_WIDTH = 560;
/** Below this width the header drops the zoom so the title and page keep their room. */
const HEADER_ZOOM_MIN_PANE_WIDTH = 420;

// Diagonal arrows: opens the full-size canvas route, unlike the dock's own maximize glyph.
const OpenFullSizeIcon = createCentralIconComponent("expand-45");

function closeCanvasPane(hostThreadId: ThreadId) {
  const store = useRightDockStore.getState();
  const pane = selectRightDockState(hostThreadId)(store).panes.find(
    (item) => item.kind === "canvas",
  );
  if (pane) store.closePane(hostThreadId, pane.id);
}

export default function CanvasDockPane({
  hostThreadId,
  workId,
  pageId,
}: {
  hostThreadId: ThreadId;
  workId: string;
  pageId: string | null;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const size = useContainerSize(element);
  const width = size?.width ?? 0;
  const { connection, query } = useCanvasWork(workId);
  const work: CanvasWork | undefined = query.data;
  const page = work?.pages.find((item) => item.id === pageId) ?? work?.pages[0];
  return (
    <div ref={setElement} className="flex min-h-0 flex-1 flex-col">
      {!work || !page ? (
        <CanvasStatus connection={connection} error={query.isError} />
      ) : (
        <CanvasEditorProvider
          work={work}
          pageId={page.id}
          readOnly={work.readOnly === true || work.archivedAt !== null}
          threadId={hostThreadId}
          onAskAgent={(prompt) => askInChat(hostThreadId, prompt)}
          onSelectPage={(next) => openCanvasPane(hostThreadId, work.id, next)}
          onOpenLibrary={() => void navigate({ to: "/canvas" })}
        >
          <div className={cn("h-10 shrink-0 ps-3 pe-2", CHAT_SURFACE_HEADER_DIVIDER_CLASS_NAME)}>
            <DockPaneHeader
              variant="embedded"
              title={
                <span className="flex min-w-0 items-center gap-0.5 text-ui-sm tracking-normal">
                  <span className="min-w-0 truncate pe-1">{work.title}</span>
                  <span aria-hidden="true" className="font-normal text-muted-foreground/60">
                    /
                  </span>
                  <CanvasPageMenu
                    work={work}
                    pageId={page.id}
                    onSelect={(next) => openCanvasPane(hostThreadId, work.id, next)}
                  />
                </span>
              }
              actions={
                <>
                  {width >= HEADER_ZOOM_MIN_PANE_WIDTH && (
                    <>
                      <CanvasZoomMenu
                        variant="header"
                        viewportElement={() =>
                          element?.querySelector<HTMLElement>("[data-canvas-viewport]") ?? null
                        }
                      />
                      <span aria-hidden="true" className="mx-1 h-3.5 w-px bg-border" />
                    </>
                  )}
                  <IconButton
                    variant="chrome"
                    size="icon-xs"
                    label={t("workspace:canvasExpand")}
                    tooltip={t("workspace:canvasExpand")}
                    tooltipSide="bottom"
                    className={DOCK_HEADER_ICON_BUTTON_CLASS}
                    onClick={() =>
                      void navigate({
                        to: "/canvas/$workId",
                        params: { workId: work.id },
                        search: { page: page.id, chat: hostThreadId },
                      })
                    }
                  >
                    <OpenFullSizeIcon className="size-3.5" />
                  </IconButton>
                </>
              }
              onClose={() => closeCanvasPane(hostThreadId)}
            />
          </div>
          <CanvasEditorSurface
            inspector={width >= INSPECTOR_MIN_PANE_WIDTH && "slim"}
            zoomInHeader={width >= HEADER_ZOOM_MIN_PANE_WIDTH}
          />
        </CanvasEditorProvider>
      )}
    </div>
  );
}
