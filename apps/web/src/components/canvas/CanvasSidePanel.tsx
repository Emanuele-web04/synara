// FILE: CanvasSidePanel.tsx
// Purpose: The full-size canvas's left panel: the app's surface tab strip for Chat, Layers and
//          Comments, then the open tab (the chat, the pages list over the layer tree, or the
//          comments). Its width is per tab (240px for Layers and Comments, more for the chat)
//          and resizable from its right edge; the canvas keeps its content in place on screen
//          when the width changes.
// Layer: Canvas editor UI
// Exports: CanvasSidePanel, CanvasSideTab, CANVAS_SIDE_TABS

import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "~/i18n";
import { executionStorage } from "~/lib/hosts/executionStorage";
import {
  attachPanelPointerOverlaySession,
  createPanelResizeOverlay,
  removePanelResizeOverlay,
} from "~/lib/panelResize";
import { cn } from "~/lib/utils";
import { SurfaceTabChip, SurfaceTabStrip } from "../chat/chatHeaderControls";
import { useCanvasEditor } from "./editor/CanvasEditorContext";
import { canvasShortcutLabelFor } from "./editor/canvasShortcuts";
import { ShortcutTooltip } from "./editor/ShortcutTooltip";

export type CanvasSideTab = "chat" | "layers" | "comments";
export const CANVAS_SIDE_TABS: readonly CanvasSideTab[] = ["chat", "layers", "comments"];

/** A 240px left panel; the chat reads better a little wider. */
const DEFAULT_WIDTHS: Readonly<Record<CanvasSideTab, number>> = {
  chat: 360,
  layers: 240,
  comments: 240,
};
const MIN_WIDTH = 200;
const MAX_WIDTH = 560;
const KEYBOARD_STEP = 16;
const widthKey = (tab: CanvasSideTab) => `synara:canvas-left-width:${tab}`;

const clampWidth = (width: number) => Math.round(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, width)));

function readWidth(tab: CanvasSideTab): number {
  try {
    const stored = Number(executionStorage.getItem(widthKey(tab)));
    return Number.isFinite(stored) && stored > 0 ? clampWidth(stored) : DEFAULT_WIDTHS[tab];
  } catch {
    return DEFAULT_WIDTHS[tab];
  }
}

function saveWidth(tab: CanvasSideTab, width: number) {
  try {
    executionStorage.setItem(widthKey(tab), String(width));
  } catch {
    /* A remembered width is a convenience only. */
  }
}

export function CanvasSidePanel({
  tab,
  onTab,
  commentCount,
  hidden,
  panels,
}: {
  tab: CanvasSideTab;
  onTab: (tab: CanvasSideTab) => void;
  commentCount: number;
  /** `.` hides the editor chrome: the panel steps aside with it. */
  hidden: boolean;
  /** Each tab's panel; only the chat stays mounted while its tab is closed. */
  panels: Readonly<Record<CanvasSideTab, ReactNode>>;
}) {
  const { t } = useTranslation();
  const { camera } = useCanvasEditor();
  const tabsId = useId();
  const aside = useRef<HTMLElement>(null);
  const [widths, setWidths] = useState<Record<CanvasSideTab, number>>(() => ({
    chat: readWidth("chat"),
    layers: readWidth("layers"),
    comments: readWidth("comments"),
  }));
  const width = widths[tab];
  /** The width the panel shows right now, a drag in progress included. */
  const shown = useRef(width);

  /**
   * Gives the panel `next` px. The canvas starts where the panel ends, so the camera moves by
   * the same amount the other way and the frames stay where they were on screen.
   */
  const applyWidth = (next: number, commit: boolean) => {
    const delta = next - shown.current;
    shown.current = next;
    if (aside.current) aside.current.style.width = `${next}px`;
    if (delta !== 0) {
      const view = camera.get();
      camera.preview({ ...view, x: view.x - delta });
    }
    if (commit) camera.commit();
  };

  // A tab switch changes the width at once; the frames still stay put.
  useLayoutEffect(() => {
    if (hidden) return;
    applyWidth(width, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [width, hidden]);

  const settle = (next: number) => {
    applyWidth(next, true);
    saveWidth(tab, next);
    setWidths((current) => ({ ...current, [tab]: next }));
  };
  const startResize = (event: React.PointerEvent<HTMLDivElement>) => {
    const element = aside.current;
    if (!element || event.button !== 0) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = shown.current;
    const overlay = createPanelResizeOverlay();
    let detach: (() => void) | null = null;
    const finish = () => {
      detach?.();
      removePanelResizeOverlay(overlay);
      document.body.style.removeProperty("user-select");
      settle(shown.current);
    };
    document.body.style.userSelect = "none";
    // While dragging only the DOM and the live camera move: nothing re-renders.
    detach = attachPanelPointerOverlaySession(overlay, {
      onMove: (move) => applyWidth(clampWidth(startWidth + move.clientX - startX), false),
      onRelease: finish,
      onAbort: finish,
    });
  };

  // The Layers tab names its shortcut (⌥1) in its tooltip.
  const layersShortcut = canvasShortcutLabelFor({ id: "show-layers" });
  const tabs: ReadonlyArray<readonly [CanvasSideTab, string, string | null]> = [
    ["chat", t("workspace:canvasChat"), null],
    ["layers", t("workspace:canvasLayers"), layersShortcut],
    ["comments", t("workspace:canvasComments"), null],
  ];
  return (
    <aside
      ref={aside}
      data-canvas-side-panel={tab}
      className={cn("relative flex shrink-0 flex-col border-e border-border", hidden && "hidden")}
      style={{ width }}
    >
      <SurfaceTabStrip
        role="tablist"
        aria-label={t("workspace:canvasSidePanel")}
        activeKey={tab}
        className="shrink-0 px-2 py-1.5"
      >
        {tabs.map(([value, label, shortcut]) => (
          <SurfaceTabChip
            key={value}
            // Text-only chips, so the three tabs fit the 240px panel.
            icon={null}
            label={label}
            tooltip={shortcut ? <ShortcutTooltip label={label} shortcut={shortcut} /> : undefined}
            active={tab === value}
            selectionAria="tab"
            tabId={`${tabsId}-${value}`}
            // Only the chat panel stays mounted while its tab is closed.
            tabPanelId={value === "chat" || tab === value ? `${tabsId}-${value}-panel` : undefined}
            trailing={
              value === "comments" && commentCount > 0 ? (
                <span className="shrink-0 text-ui-2xs text-muted-foreground tabular-nums">
                  {commentCount}
                </span>
              ) : undefined
            }
            onSelect={() => onTab(value)}
          />
        ))}
      </SurfaceTabStrip>
      {CANVAS_SIDE_TABS.map((value) =>
        value === "chat" || tab === value ? (
          <div
            key={value}
            role="tabpanel"
            id={`${tabsId}-${value}-panel`}
            aria-labelledby={`${tabsId}-${value}`}
            className={cn("min-h-0 flex-1 flex-col", tab === value ? "flex" : "hidden")}
          >
            {panels[value]}
          </div>
        ) : null,
      )}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={t("workspace:canvasResizeSidePanel")}
        aria-valuenow={width}
        aria-valuemin={MIN_WIDTH}
        aria-valuemax={MAX_WIDTH}
        tabIndex={0}
        className="absolute inset-y-0 -end-1 z-20 w-2 cursor-col-resize outline-none before:absolute before:inset-y-0 before:start-1/2 before:w-px before:-translate-x-1/2 before:bg-transparent hover:before:bg-ring focus-visible:before:w-0.5 focus-visible:before:bg-ring"
        onPointerDown={startResize}
        onDoubleClick={() => settle(DEFAULT_WIDTHS[tab])}
        onKeyDown={(event) => {
          const step =
            event.key === "ArrowLeft"
              ? -KEYBOARD_STEP
              : event.key === "ArrowRight"
                ? KEYBOARD_STEP
                : 0;
          if (step === 0) return;
          event.preventDefault();
          settle(clampWidth(shown.current + step));
        }}
      />
    </aside>
  );
}
