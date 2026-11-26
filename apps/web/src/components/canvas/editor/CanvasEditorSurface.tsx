import { cn } from "~/lib/utils";
import { useCanvasEditorStore } from "../canvasStores";
import { CanvasInspector } from "../inspector/CanvasInspector";
import { CanvasViewport } from "./CanvasViewport";

/**
 * The editor body from the side panel rightwards: the canvas, with the floating toolbar over it,
 * and the inspector column when there is room. The zoom menu sits in the header above (the app's
 * top bar on the canvas route, the pane header in the side pane); `zoomInHeader` off puts it in
 * the toolbar instead. `"slim"` is the narrower column the right-dock pane uses next to the chat;
 * it names the selection at its top, since the pane has no layers panel. The inspector sits on
 * the surrounding surface and meets the canvas at a 1px border.
 */
export function CanvasEditorSurface({
  inspector,
  zoomInHeader = false,
  className,
}: {
  inspector: boolean | "slim";
  /** The header above shows the zoom control, so the toolbar does not. */
  zoomInHeader?: boolean;
  className?: string;
}) {
  // `.` / ⌘\: the canvas alone.
  const uiHidden = useCanvasEditorStore((state) => state.uiHidden);
  const showInspector = inspector !== false && !uiHidden;
  return (
    <div className={cn("flex min-h-0 min-w-0 flex-1 text-foreground", className)}>
      <div className="relative min-h-0 min-w-0 flex-1">
        <CanvasViewport zoomOutside={zoomInHeader} toolbar />
      </div>
      {showInspector && (
        <aside
          className={cn(
            "flex shrink-0 flex-col border-s border-border",
            inspector === "slim" ? "w-58" : "w-70",
          )}
        >
          <CanvasInspector className="min-h-0 flex-1" selectionRow={inspector === "slim"} />
        </aside>
      )}
    </div>
  );
}
