import type { DesignFrame } from "@synara/contracts";
import { memo, useLayoutEffect, useRef } from "react";
import { useTranslation } from "~/i18n";
import {
  attachDesignFrameRenderer,
  type DesignFrameRenderer,
  type DesignRenderContext,
} from "~/lib/designCanvas";
import { ImageIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { TreeRowRenameInput } from "../../ui/TreeRow";
import { CanvasAgentRain, rememberRemovedLayers, useFadePresence } from "./CanvasAgentActivity";
import type { FrameDom } from "./CanvasEditorContext";
import { FRAME_HOST_ATTRIBUTE } from "./canvasSelection";

/** Screen pixels the label row reaches past the frame's sides, so its title lines up with the edge. */
const LABEL_INSET = 6;
/** The label row's height on screen (22px row and 3px gap), for the room it needs above a frame. */
export const CANVAS_FRAME_LABEL_HEIGHT = 25;
/** Below this on-screen width the label keeps its room for the title and drops the size. */
const LABEL_SIZE_MIN_WIDTH = 160;

/**
 * One design frame. Its content lives in an open shadow root built from the layer model; there
 * is no iframe, so the editor can hit-test, measure and edit layers directly. Updates patch
 * that DOM by layer ID, so one changed layer changes one element.
 */
export const CanvasFrameView = memo(function CanvasFrameView({
  frame,
  context,
  zoom,
  selected,
  hovered,
  agentActive,
  agentName = null,
  cover = false,
  labelHidden = false,
  canRename = false,
  editingLayerId = null,
  renaming = false,
  onRename,
  onRenameDone,
  onRegister,
}: {
  frame: DesignFrame;
  context: DesignRenderContext;
  zoom: number;
  selected: boolean;
  hovered: boolean;
  agentActive: boolean;
  /** Who is writing this frame (the chat's provider), shown beside the label's status dot. */
  agentName?: string | null;
  /** The work's cover (its library thumbnail): a marker leads the label. */
  cover?: boolean;
  /** Another frame sits where the label would go: the label stays out of its way. */
  labelHidden?: boolean;
  /** The label hints that a double-click renames the frame. */
  canRename?: boolean;
  /** The layer the user is typing in: it keeps its content while the rest of the frame updates. */
  editingLayerId?: string | null;
  /** The frame is renamed in its label: the title becomes a field. */
  renaming?: boolean;
  /** The renamed title, or null when renaming was cancelled. */
  onRename?: (frameId: string, title: string | null) => void;
  /** After Enter or Escape ended a rename: the canvas takes the keyboard back. */
  onRenameDone?: () => void;
  onRegister: (frameId: string, dom: FrameDom | null) => void;
}) {
  const { t } = useTranslation();
  const host = useRef<HTMLDivElement>(null);
  const renderer = useRef<{ shadow: ShadowRoot; frame: DesignFrameRenderer } | null>(null);
  const registered = useRef<string | null>(null);
  useLayoutEffect(() => {
    const element = host.current!;
    const shadow = element.shadowRoot ?? element.attachShadow({ mode: "open" });
    if (renderer.current?.shadow !== shadow)
      renderer.current = { shadow, frame: attachDesignFrameRenderer(shadow) };
    return () => {
      registered.current = null;
      onRegister(frame.id, null);
    };
  }, [frame.id, onRegister]);
  const previousLayers = useRef(frame.layers);
  useLayoutEffect(() => {
    const current = renderer.current;
    if (!current) return;
    // Where removed layers were, for the agent's delete flash, before they leave the DOM.
    if (previousLayers.current !== frame.layers) {
      const kept = new Set(frame.layers.nodes.map((node) => node.id));
      const gone = previousLayers.current.nodes.flatMap((node) => {
        if (node.type !== "element" || kept.has(node.id)) return [];
        const element = current.frame.element(node.id);
        return element ? [[node.id, element] as const] : [];
      });
      if (gone.length) rememberRemovedLayers(frame, current.frame.root, gone);
      previousLayers.current = frame.layers;
    }
    const changed = current.frame.update(frame, context, { skipLayerId: editingLayerId });
    // Registering bumps the editor's DOM version, so measurements follow real changes only.
    if (!changed && registered.current === frame.id) return;
    registered.current = frame.id;
    onRegister(frame.id, {
      host: host.current!,
      shadow: current.shadow,
      root: current.frame.root,
      layer: current.frame.element,
      restore: current.frame.restore,
    });
    // Layers and style are the content; position and size are applied by the wrapper.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frame.layers, frame.style, frame.id, context, editingLayerId, onRegister]);
  // The label is drawn at screen size: scaled back by the zoom, offsets converted to world units.
  // The viewport's live `--canvas-zoom` keeps it right while a pan or zoom has not settled yet,
  // and `100%` follows the frame's width while it is being resized.
  const labelWidth = frame.width * zoom;
  const liveZoom = `var(--canvas-zoom, ${zoom})`;
  const rain = useFadePresence(agentActive);
  return (
    <div
      className="absolute"
      style={{ left: frame.x, top: frame.y, width: frame.width, height: frame.height }}
    >
      <div
        data-canvas-frame-label={frame.id}
        className={cn(
          "group/frame-label absolute bottom-full flex origin-bottom-left cursor-default items-center pb-[3px] whitespace-nowrap select-none",
          labelHidden && !selected && !renaming && "hidden",
        )}
        style={{
          left: `calc(${-LABEL_INSET}px / ${liveZoom})`,
          width: `calc(100% * ${liveZoom} + ${LABEL_INSET * 2}px)`,
          transform: `scale(calc(1 / ${liveZoom}))`,
        }}
      >
        <div
          // The frame label: the title muted on the canvas, full ink on hover, in the accent
          // while selected; no fill of its own.
          className={cn(
            "flex h-[22px] min-w-0 items-center gap-1.5 rounded-md px-1.5 text-ui-sm",
            selected
              ? "text-(--canvas-accent)"
              : hovered
                ? "text-foreground"
                : "text-muted-foreground hover:text-foreground",
          )}
        >
          {cover && (
            <span
              role="img"
              aria-label={t("workspace:canvasCoverMarker")}
              data-canvas-cover-marker=""
              className="flex shrink-0"
            >
              <ImageIcon aria-hidden className="size-3" />
            </span>
          )}
          {renaming && onRename ? (
            <span data-canvas-ui="" className="flex w-40 min-w-0">
              <TreeRowRenameInput
                defaultValue={frame.title}
                label={t("workspace:canvasRenameFrame")}
                maxLength={120}
                onCancel={() => onRename(frame.id, null)}
                onCommit={(value) => onRename(frame.id, value)}
                onDone={onRenameDone}
              />
            </span>
          ) : (
            <span className="truncate">{frame.title}</span>
          )}
          {agentName && agentActive && (
            <span className="min-w-0 shrink-0 truncate text-ui-xs text-muted-foreground">
              {agentName}
            </span>
          )}
          {canRename && !renaming && (
            <span className="ms-0.5 hidden shrink-0 text-ui-xs text-muted-foreground/72 group-hover/frame-label:inline">
              {t("workspace:canvasFrameRenameHint")}
            </span>
          )}
        </div>
        {/* The rain runs leftward from the frame's top-right corner up to the label. */}
        {rain.mounted ? (
          <CanvasAgentRain visible={rain.visible} className="ms-auto flex-1 pe-1" />
        ) : (
          !selected &&
          labelWidth >= LABEL_SIZE_MIN_WIDTH && (
            <span className="ms-auto shrink-0 pe-1.5 text-ui-xs text-muted-foreground/72 tabular-nums group-hover/frame-label:hidden">
              {Math.round(frame.width)} × {Math.round(frame.height)}
            </span>
          )
        )}
      </div>
      {/* Frames sit edge to edge on the canvas: no shadow or outline of their own. */}
      <div ref={host} {...{ [FRAME_HOST_ATTRIBUTE]: frame.id }} className="size-full" />
    </div>
  );
});
