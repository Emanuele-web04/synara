import type { CanvasWork, ThreadId } from "@synara/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "~/i18n";
import { createCentralIconComponent } from "~/lib/central-icons";
import { executionStorage } from "~/lib/hosts/executionStorage";
import { LayoutAlignRightIcon, LayoutRightIcon } from "~/lib/icons";
import { useContainerSize } from "~/lib/pdf/useContainerSize";
import { cn } from "~/lib/utils";
import { selectRightDockState, useRightDockStore } from "~/rightDockStore";
import {
  CHAT_SURFACE_CONTROL_ACTIVE_CLASS_NAME,
  DOCK_HEADER_ICON_BUTTON_CLASS,
} from "../chat/chatHeaderControls";
import { DockPaneHeader } from "../chat/DockPaneHeader";
import { IconButton } from "../ui/icon-button";
import { CanvasEditorProvider, useCanvasEditor } from "./editor/CanvasEditorContext";
import { CanvasEditorSurface } from "./editor/CanvasEditorSurface";
import { CanvasZoomMenu } from "./editor/CanvasToolbar";
import {
  askInChat,
  CanvasHeaderStatus,
  CanvasStatus,
  openCanvasPane,
  useCanvasWork,
} from "./canvasPane";
import { CanvasPageMenu } from "./CanvasPageMenu";

/** Below this width the side pane shows the canvas alone; Open full size has the full layout. */
export const INSPECTOR_MIN_PANE_WIDTH = 560;
/** Below this width the header drops the zoom so the title and page keep their room. */
const HEADER_ZOOM_MIN_PANE_WIDTH = 420;
/** This viewer's choice to show the inspector in the side pane (closed until opened). */
export const CANVAS_DOCK_INSPECTOR_KEY = "synara:canvas-dock-inspector";

export function readDockInspectorOpen(): boolean {
  try {
    return executionStorage.getItem(CANVAS_DOCK_INSPECTOR_KEY) === "open";
  } catch {
    return false;
  }
}

function saveDockInspectorOpen(open: boolean) {
  try {
    executionStorage.setItem(CANVAS_DOCK_INSPECTOR_KEY, open ? "open" : "closed");
  } catch {
    /* A remembered panel state is a convenience only. */
  }
}

// Diagonal arrows: opens the full-size canvas route, unlike the dock's own maximize glyph.
const OpenFullSizeIcon = createCentralIconComponent("expand-45");

/**
 * Opening or closing the side pane's inspector takes width from (or gives it back to) the
 * canvas's right edge: the camera moves half of it, so what was in the middle of the canvas
 * stays in the middle instead of going under the inspector. Pane resizes leave the camera alone.
 */
function CanvasCentreKeeper({
  inspectorShown,
  viewportElement,
}: {
  inspectorShown: boolean;
  viewportElement: () => HTMLElement | null;
}) {
  const { camera } = useCanvasEditor();
  const last = useRef<{ shown: boolean; width: number } | null>(null);
  useLayoutEffect(() => {
    const element = viewportElement();
    if (!element) return;
    const width = element.clientWidth;
    const previous = last.current;
    last.current = { shown: inspectorShown, width };
    if (!previous || previous.shown === inspectorShown || previous.width === width) return;
    const view = camera.get();
    camera.preview({ ...view, x: view.x + (width - previous.width) / 2 });
    camera.commit();
  });
  return null;
}

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
  // The inspector stays closed in the narrow pane until this viewer opens it.
  const [inspectorOpen, setInspectorOpen] = useState(readDockInspectorOpen);
  const inspectorFits = width >= INSPECTOR_MIN_PANE_WIDTH;
  const inspectorLabel = t(
    inspectorOpen ? "workspace:canvasHideInspector" : "workspace:canvasShowInspector",
  );
  const { connection, query } = useCanvasWork(workId);
  const work: CanvasWork | undefined = query.data;
  const page = work?.pages.find((item) => item.id === pageId) ?? work?.pages[0];
  const readOnly = work?.readOnly === true || (work !== undefined && work.archivedAt !== null);
  return (
    <div ref={setElement} className="flex min-h-0 flex-1 flex-col">
      {!work || !page ? (
        <CanvasStatus connection={connection} error={query.isError} />
      ) : (
        <CanvasEditorProvider
          work={work}
          pageId={page.id}
          readOnly={readOnly}
          threadId={hostThreadId}
          onAskAgent={(prompt) => askInChat(hostThreadId, prompt)}
          onSelectPage={(next) => openCanvasPane(hostThreadId, work.id, next)}
          onOpenLibrary={() => void navigate({ to: "/canvas" })}
        >
          {/* The dock family's pane header (as Source control and the simulator): 44 px under
              the dock's tabs, the title on the left, the pane's actions and close on the right. */}
          <DockPaneHeader
            title={
              <span className="flex min-w-0 items-center gap-0.5">
                <span className="min-w-0 truncate pe-1">{work.title}</span>
                <span aria-hidden="true" className="font-normal text-muted-foreground/60">
                  /
                </span>
                <CanvasPageMenu
                  work={work}
                  pageId={page.id}
                  onSelect={(next) => openCanvasPane(hostThreadId, work.id, next)}
                />
                {/* As in the full layout's header: archived, or updates unavailable. */}
                <CanvasHeaderStatus workId={work.id} readOnly={readOnly} connection={connection} />
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
                {inspectorFits && (
                  <IconButton
                    variant="chrome"
                    size="icon-xs"
                    label={inspectorLabel}
                    tooltip={inspectorLabel}
                    tooltipSide="bottom"
                    aria-pressed={inspectorOpen}
                    data-canvas-dock-inspector-toggle=""
                    className={cn(
                      DOCK_HEADER_ICON_BUTTON_CLASS,
                      inspectorOpen && CHAT_SURFACE_CONTROL_ACTIVE_CLASS_NAME,
                    )}
                    onClick={() => {
                      const next = !inspectorOpen;
                      setInspectorOpen(next);
                      saveDockInspectorOpen(next);
                    }}
                  >
                    {/* The chat header's right-panel glyphs: filled while open. */}
                    {inspectorOpen ? (
                      <LayoutRightIcon className="size-3.5" />
                    ) : (
                      <LayoutAlignRightIcon className="size-3.5" />
                    )}
                  </IconButton>
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
          {/* Mounted once the pane is measured, so the canvas starts at the width it keeps
              (with or without the inspector) and its first fit uses it. */}
          {size ? (
            <>
              <CanvasEditorSurface
                inspector={inspectorFits && inspectorOpen && "slim"}
                zoomInHeader={width >= HEADER_ZOOM_MIN_PANE_WIDTH}
              />
              <CanvasCentreKeeper
                inspectorShown={inspectorFits && inspectorOpen}
                viewportElement={() =>
                  element?.querySelector<HTMLElement>("[data-canvas-viewport]") ?? null
                }
              />
            </>
          ) : null}
        </CanvasEditorProvider>
      )}
    </div>
  );
}
