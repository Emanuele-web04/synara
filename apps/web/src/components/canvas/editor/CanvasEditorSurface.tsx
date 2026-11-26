import { useCallback, useRef, type ReactNode } from "react";
import { cn } from "~/lib/utils";
import { useCanvasEditorStore } from "../canvasStores";
import { CanvasInspector } from "../inspector/CanvasInspector";
import { CanvasToolStrip, CanvasZoomMenu } from "./CanvasToolbar";
import { CanvasViewport } from "./CanvasViewport";

/**
 * The editor body from the tool strip rightwards: the vertical tool strip, the canvas, and the
 * inspector column when there is room (its top row holds the zoom menu and `actions`).
 * `"slim"` is the narrower column the right-dock pane uses next to the chat. The strip and the
 * inspector sit on the surrounding surface and meet the canvas at 1px borders.
 */
export function CanvasEditorSurface({
  inspector,
  zoomInHeader = false,
  actions,
  className,
}: {
  inspector: boolean | "slim";
  /** The pane header shows the zoom control, so neither the canvas nor the inspector does. */
  zoomInHeader?: boolean;
  /** The work's own controls at the end of the inspector's top row (Back to chat, menu). */
  actions?: ReactNode;
  className?: string;
}) {
  // `.` / ⌘\: the canvas alone.
  const uiHidden = useCanvasEditorStore((state) => state.uiHidden);
  const canvas = useRef<HTMLDivElement>(null);
  const viewportElement = useCallback(
    () => canvas.current?.querySelector<HTMLElement>("[data-canvas-viewport]") ?? null,
    [],
  );
  const showInspector = inspector !== false && !uiHidden;
  const zoomInInspector = showInspector && !zoomInHeader;
  return (
    <div className={cn("flex min-h-0 min-w-0 flex-1 text-foreground", className)}>
      {uiHidden ? null : <CanvasToolStrip viewportElement={viewportElement} />}
      <div ref={canvas} className="relative min-h-0 min-w-0 flex-1">
        <CanvasViewport zoomOutside={zoomInHeader || zoomInInspector} />
      </div>
      {showInspector && (
        <aside
          className={cn(
            "flex shrink-0 flex-col border-s border-border",
            inspector === "slim" ? "w-58" : "w-70",
          )}
        >
          <CanvasInspector
            className="min-h-0 flex-1"
            actions={
              zoomInInspector || actions ? (
                <>
                  {zoomInInspector ? (
                    <CanvasZoomMenu viewportElement={viewportElement} className="-me-1" />
                  ) : null}
                  {actions}
                </>
              ) : undefined
            }
          />
        </aside>
      )}
    </div>
  );
}
