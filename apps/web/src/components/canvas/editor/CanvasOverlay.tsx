// FILE: CanvasOverlay.tsx
// Purpose: The canvas's selection chrome: selection and hover outlines in the canvas accent,
//          four 7×7 corner handles that turn with
//          a rotated layer and invisible edge hit zones, the W × H badge, multi-selection bounds,
//          flex padding and gap handles, the hover chip, ⌥ measurements and agent-activity
//          outlines. Boxes are
//          kept in world pixels and placed with the viewport's live camera variables, so a pan
//          or zoom moves them without a render. A gesture previews moves and resizes through
//          the handle; the next measurement replaces the preview.
// Layer: Canvas editor UI
// Exports: CanvasOverlay, CanvasOverlayHandle, CANVAS_GESTURE_ATTRIBUTE

import type { DesignFrame } from "@synara/contracts";
import {
  Fragment,
  memo,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";
import { useTranslation } from "~/i18n";
import { cn } from "~/lib/utils";
import { sizingModeOf } from "../inspector/layoutPatches";
import { readTarget } from "../inspector/useInspectorModel";
import { selectionKey, useCanvasEditorStore, type CanvasSelectionItem } from "../canvasStores";
import { CanvasMeasureChip, CHIP_META_ATTRIBUTE } from "./CanvasMeasureChip";
import {
  elementBox,
  isFreePositioned,
  layoutSize,
  measureDistances,
  screenToWorldRect,
  sizeBadgeText,
  type MeasureLine,
  type WorldRect,
} from "./canvasMeasure";
import { DESIGN_LAYER_ATTRIBUTE } from "@synara/shared/designCanvasLayers";
import { CanvasAgentOutlines } from "./CanvasAgentActivity";
import { scheduleCommentPinClearance } from "./canvasPinPlacement";
import { useCanvasEditor, type CanvasEditorApi } from "./CanvasEditorContext";
import type { SpacingHandle } from "./canvasGestures";
import { isLayerLocked, layerLabel, parentSelection } from "./canvasSelection";

/** Set on the viewport while a gesture runs: `pan`, `press`, `drag`, `resize`, `marquee`, `draw`. */
export const CANVAS_GESTURE_ATTRIBUTE = "data-canvas-gesture";

/** The 7×7 white corner handle; the pseudo-element widens what the pointer can grab. */
const HANDLE_CLASS_NAME =
  "pointer-events-auto absolute size-[7px] -translate-1/2 border border-(--canvas-accent) bg-white after:absolute after:-inset-1 after:content-['']";
/** The circular flex padding and gap handles. */
const SPACING_HANDLE_CLASS_NAME =
  "pointer-events-auto absolute size-[9px] -translate-1/2 rounded-full border border-(--canvas-accent) bg-white";
/** A flex container needs this much room on screen before its spacing handles show. */
const SPACING_HANDLE_MIN = 40;
/** Below this on-screen size an edge keeps its middle for dragging: only corners resize. */
const EDGE_HANDLE_MIN = 24;
/** The hover chip and measurements belong to an idle canvas. */
const HIDDEN_IN_GESTURE = "[[data-canvas-gesture]_&]:hidden";
/** A layer being dragged is not also outlined as hovered. */
const HIDDEN_IN_DRAG = "[[data-canvas-gesture=drag]_&]:hidden";

// World → screen, with the camera the viewport keeps in these variables.
const X = "var(--canvas-x)";
const Y = "var(--canvas-y)";
const Z = "var(--canvas-zoom)";
const screenX = (x: number) => `calc(${X} + ${x}px * ${Z})`;
const screenY = (y: number) => `calc(${Y} + ${y}px * ${Z})`;
const screenLength = (length: number) => `calc(${length}px * ${Z})`;

/** A box that a gesture can shift by `--canvas-box-dx/-dy` (world pixels). */
const boxStyle = (rect: WorldRect): CSSProperties => ({
  left: `calc(${X} + (${rect.x}px + var(--canvas-box-dx, 0px)) * ${Z})`,
  top: `calc(${Y} + (${rect.y}px + var(--canvas-box-dy, 0px)) * ${Z})`,
  width: screenLength(rect.width),
  height: screenLength(rect.height),
});

/** The single selection's box as `--sel-*`, which a move or resize preview offsets. */
const selectionVars = (rect: WorldRect) =>
  ({
    "--sel-l": `calc(${X} + (${rect.x}px + var(--sel-dx, 0px)) * ${Z})`,
    "--sel-t": `calc(${Y} + (${rect.y}px + var(--sel-dy, 0px)) * ${Z})`,
    "--sel-w": `calc((${rect.width}px + var(--sel-dw, 0px)) * ${Z})`,
    "--sel-h": `calc((${rect.height}px + var(--sel-dh, 0px)) * ${Z})`,
  }) as CSSProperties;
const SEL = { l: "var(--sel-l)", t: "var(--sel-t)", w: "var(--sel-w)", h: "var(--sel-h)" };
const LIVE_PROPERTIES = [
  "--canvas-box-dx",
  "--canvas-box-dy",
  "--sel-dx",
  "--sel-dy",
  "--sel-dw",
  "--sel-dh",
];

/**
 * A measured item. `rect` is its own box in world pixels; for a rotated layer that is the
 * unrotated box around the same centre, turned by `angle`, and `bounds` the box on screen.
 */
type Measured = {
  key: string;
  rect: WorldRect;
  bounds: WorldRect;
  angle: number;
  item: CanvasSelectionItem;
};
type SpacingHandleBox = { handle: SpacingHandle; x: number; y: number; axis: "x" | "y" };
type Geometry = {
  selection: Measured[];
  hover: WorldRect | null;
  parent: WorldRect | null;
  /** The flex container a single selected layer sits in, outlined dashed. */
  flexParent: WorldRect | null;
  /** The other children of a selected flex container while one of them is hovered. */
  flexSiblings: { key: string; rect: WorldRect }[];
  /** The flex padding and gap handles of a single selected flex container. */
  spacing: SpacingHandleBox[];
  /** The corner radius of each agent-active frame, so its outline follows it. */
  radii: Readonly<Record<string, string>>;
};

export type CanvasOverlayHandle = {
  /**
   * Shows a gesture's move or resize before it is saved: the boxes of `keys` shift by a world
   * delta, and the single selection's box (handles and chip with it) also grows by `dw`/`dh`.
   */
  preview: (change: {
    keys: ReadonlySet<string>;
    dx: number;
    dy: number;
    dw?: number;
    dh?: number;
  }) => void;
  /** The gesture ended: measure again; the preview stays until that measurement shows. */
  settle: () => void;
};

const designSize = (rect: WorldRect) => sizeBadgeText(rect);

export const CanvasOverlay = memo(function CanvasOverlay({
  root,
  handle,
  frames,
  hover,
  altHeld,
  agentFrames,
}: {
  root: RefObject<HTMLElement | null>;
  handle: RefObject<CanvasOverlayHandle | null>;
  /** The page's frames as shown, with unsaved move and resize results. */
  frames: readonly DesignFrame[];
  hover: CanvasSelectionItem | null;
  altHeld: boolean;
  agentFrames: ReadonlySet<string>;
}) {
  const editor = useCanvasEditor();
  const { selection, editingText, readOnly, domVersion, page, camera, viewport } = editor;
  const tool = useCanvasEditorStore((state) => state.tool);
  const panelHover = useCanvasEditorStore((state) => state.panelHover);
  const container = useRef<HTMLDivElement>(null);
  const [nonce, setNonce] = useState(0);
  const [geometry, setGeometry] = useState<Geometry>({
    selection: [],
    hover: null,
    parent: null,
    flexParent: null,
    flexSiblings: [],
    spacing: [],
    radii: {},
  });

  // Boxes are measured in world pixels, so the camera moving never needs a new measurement.
  useLayoutEffect(() => {
    const id = requestAnimationFrame(() => {
      const element = root.current;
      if (!element) return;
      const origin = element.getBoundingClientRect();
      const view = camera.get();
      const byId = new Map(frames.map((frame) => [frame.id, frame]));
      const rectOf = (item: CanvasSelectionItem): WorldRect | null => {
        if (item.kind === "frame") {
          const frame = byId.get(item.frameId);
          return frame
            ? { x: frame.x, y: frame.y, width: frame.width, height: frame.height }
            : null;
        }
        const node = editor.elementFor(item);
        const box = node ? elementBox(node, origin) : null;
        return box ? screenToWorldRect(box, view) : null;
      };
      const measure = (item: CanvasSelectionItem): Measured | null => {
        const bounds = rectOf(item);
        if (!bounds) return null;
        const node = item.kind === "layer" ? editor.elementFor(item) : null;
        const angle = node ? layerAngle(node) : 0;
        const size = node && angle ? layoutSize(node) : null;
        const rect = size
          ? {
              x: bounds.x + bounds.width / 2 - size.width / 2,
              y: bounds.y + bounds.height / 2 - size.height / 2,
              width: size.width,
              height: size.height,
            }
          : bounds;
        return { key: selectionKey(item), rect, bounds, angle, item };
      };
      const target = panelHover ?? hover;
      const only = selection.length === 1 ? selection[0]! : null;
      const parent = only && altHeld ? parentSelection(editor.layers(only.frameId), only) : null;
      const measured = selection.flatMap((item) => {
        const box = measure(item);
        return box ? [box] : [];
      });
      // Flex layouts show their structure: a selected layer's flex parent, and while a child of
      // a selected flex container is hovered, that child's siblings.
      const isFlex = (item: CanvasSelectionItem | null): item is CanvasSelectionItem => {
        const node = item?.kind === "layer" ? editor.elementFor(item) : null;
        return node !== null && getComputedStyle(node).display.includes("flex");
      };
      const onlyParent = only ? parentSelection(editor.layers(only.frameId), only) : null;
      const flexParent = isFlex(onlyParent) ? rectOf(onlyParent) : null;
      const flexSiblings: Geometry["flexSiblings"] = [];
      const index = only ? editor.layers(only.frameId) : undefined;
      if (
        only?.kind === "layer" &&
        target?.kind === "layer" &&
        target.frameId === only.frameId &&
        index?.parent.get(target.layerId) === only.layerId &&
        isFlex(only)
      ) {
        const container = index.nodes.get(only.layerId);
        for (const id of container?.type === "element" ? container.children : []) {
          if (id === target.layerId || index.nodes.get(id)?.type !== "element") continue;
          const rect = rectOf({ kind: "layer", frameId: only.frameId, layerId: id });
          if (rect) flexSiblings.push({ key: id, rect });
        }
      }
      setGeometry({
        selection: measured,
        hover:
          target && !selection.some((item) => selectionKey(item) === selectionKey(target))
            ? rectOf(target)
            : null,
        parent: parent ? rectOf(parent) : null,
        flexParent,
        flexSiblings,
        spacing:
          only && measured.length === 1 && !measured[0]!.angle
            ? spacingHandles(editor, only, measured[0]!.rect, origin, view)
            : [],
        radii: Object.fromEntries(
          [...agentFrames].map((frameId) => [
            frameId,
            editor.elementFor({ kind: "frame", frameId })
              ? getComputedStyle(editor.elementFor({ kind: "frame", frameId })!).borderRadius
              : "0px",
          ]),
        ),
      });
    });
    return () => cancelAnimationFrame(id);
    // `page` and `domVersion` signal new layers and re-rendered DOM; the editor's functions
    // are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    altHeld,
    agentFrames,
    camera,
    frames,
    hover,
    nonce,
    page,
    panelHover,
    root,
    selection,
    domVersion,
  ]);

  const single = geometry.selection.length === 1 ? geometry.selection[0]! : null;
  const singleIndex =
    single?.item.kind === "layer" ? editor.layers(single.item.frameId) : undefined;
  // The badge: the selection's W × H, each led by its sizing mode when it is not fixed.
  const { t } = useTranslation();
  const singleModes = useMemo(() => {
    if (single?.item.kind !== "layer") return null;
    const target = readTarget(editor, single.item);
    return target
      ? { width: sizingModeOf(target, "width"), height: sizingModeOf(target, "height") }
      : null;
    // `domVersion` is the signal for a changed layout.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [single?.key, domVersion]);
  const sizingNames = useMemo(
    () => ({
      fit: t("workspace:canvasInspectorSizingFit"),
      fill: t("workspace:canvasInspectorSizingFill"),
      relative: t("workspace:canvasInspectorSizingRelative"),
    }),
    [t],
  );
  const chipMeta = (rect: WorldRect) => [sizeBadgeText(rect, singleModes, sizingNames)];
  const latest = useRef({ single, chipMeta });
  latest.current = { single, chipMeta };

  useImperativeHandle(
    handle,
    () => ({
      preview: ({ keys, dx, dy, dw = 0, dh = 0 }) => {
        const overlay = container.current;
        if (!overlay) return;
        for (const box of overlay.querySelectorAll<HTMLElement>("[data-canvas-box]")) {
          if (!keys.has(box.dataset.canvasBox!)) continue;
          box.style.setProperty("--canvas-box-dx", `${dx}px`);
          box.style.setProperty("--canvas-box-dy", `${dy}px`);
        }
        const group = overlay.querySelector<HTMLElement>("[data-canvas-selection-group]");
        const { single: current, chipMeta: meta } = latest.current;
        if (!group || !current || !keys.has(current.key)) return;
        group.style.setProperty("--sel-dx", `${dx}px`);
        group.style.setProperty("--sel-dy", `${dy}px`);
        group.style.setProperty("--sel-dw", `${dw}px`);
        group.style.setProperty("--sel-dh", `${dh}px`);
        const values = meta({
          x: current.rect.x + dx,
          y: current.rect.y + dy,
          width: current.rect.width + dw,
          height: current.rect.height + dh,
        });
        for (const span of group.querySelectorAll<HTMLElement>(`[${CHIP_META_ATTRIBUTE}]`)) {
          const value = values[Number(span.getAttribute(CHIP_META_ATTRIBUTE))];
          if (value !== undefined) span.textContent = value;
        }
      },
      settle: () => setNonce((value) => value + 1),
    }),
    [],
  );

  // A new measurement replaces whatever a gesture previewed, its chip text included, and moves
  // the size badge: comment pins step off it.
  useLayoutEffect(() => {
    const overlay = container.current;
    if (!overlay) return;
    scheduleCommentPinClearance(root.current);
    for (const element of overlay.querySelectorAll<HTMLElement>(
      "[data-canvas-box],[data-canvas-selection-group]",
    ))
      for (const property of LIVE_PROPERTIES) element.style.removeProperty(property);
    const { single: current, chipMeta: meta } = latest.current;
    if (!current) return;
    const values = meta(current.rect);
    for (const span of overlay.querySelectorAll<HTMLElement>(
      `[data-canvas-selection-group] [${CHIP_META_ATTRIBUTE}]`,
    )) {
      const value = values[Number(span.getAttribute(CHIP_META_ATTRIBUTE))];
      if (value !== undefined && span.textContent !== value) span.textContent = value;
    }
  }, [geometry, root]);

  // A zoom moves the badge (screen-sized, under the selection) against the pins it may cover.
  useLayoutEffect(() => {
    let zoom = camera.get().zoom;
    return camera.subscribe((view) => {
      if (view.zoom === zoom) return;
      zoom = view.zoom;
      scheduleCommentPinClearance(root.current);
    });
  }, [camera, root]);

  const hoverTarget = panelHover ?? hover;
  const hoverIndex = hoverTarget?.kind === "layer" ? editor.layers(hoverTarget.frameId) : undefined;
  // Measured at the zoom it is drawn with, so lines shorter than half a screen pixel drop out.
  const zoom = viewport.zoom;
  const measureTarget =
    altHeld && single && !editingText && tool === "move"
      ? (geometry.hover ?? geometry.parent)
      : null;
  const measures: MeasureLine[] =
    single && measureTarget
      ? measureDistances(scaled(single.bounds, zoom), scaled(measureTarget, zoom), zoom).map(
          ({ axis, value, x, y, from, to }) => ({
            axis,
            value,
            x: x / zoom,
            y: y / zoom,
            from: from / zoom,
            to: to / zoom,
          }),
        )
      : [];
  // The badge sits under the selection, below a measure line that leaves its bottom edge.
  const singleBottom = single ? single.bounds.y + single.bounds.height : 0;
  const chipBottom = single
    ? Math.max(
        singleBottom,
        ...measures
          .filter((line) => line.axis === "y" && line.from >= singleBottom - 1 / zoom)
          .map((line) => line.to),
      )
    : 0;
  const chipTop =
    single && (chipBottom > singleBottom || single.angle)
      ? `calc(${screenY(chipBottom)} + 7px)`
      : `calc(${SEL.t} + ${SEL.h} + 7px)`;
  // The hovered layer, or the parent the ⌥ measurement falls back to, in the hover accent.
  const outlined = geometry.hover ?? (measures.length ? geometry.parent : null);
  const singleLocked =
    single?.item.kind === "layer" && isLayerLocked(singleIndex, single.item.layerId);
  const showHandles = single && !editingText && !readOnly && !singleLocked;
  // Several items: each keeps its outline, and their bounds get the badge.
  const bounds =
    geometry.selection.length > 1 ? unionRect(geometry.selection.map((item) => item.bounds)) : null;

  return (
    <div ref={container} className="pointer-events-none absolute inset-0" aria-hidden>
      <CanvasAgentOutlines frames={frames} agentFrames={agentFrames} radii={geometry.radii} />
      {!editingText && geometry.flexParent && (
        <div
          data-canvas-flex-parent=""
          className={cn(
            "absolute border border-dashed border-(--canvas-accent)",
            HIDDEN_IN_GESTURE,
          )}
          style={boxStyle(geometry.flexParent)}
        />
      )}
      {!editingText &&
        geometry.flexSiblings.map(({ key, rect }) => (
          <div
            key={key}
            data-canvas-flex-sibling=""
            className={cn(
              "absolute border border-dashed border-(--canvas-hover)",
              HIDDEN_IN_GESTURE,
            )}
            style={boxStyle(rect)}
          />
        ))}
      {outlined && (
        <div
          data-canvas-hover-outline=""
          className={cn("absolute border-2 border-(--canvas-hover)", HIDDEN_IN_DRAG)}
          style={boxStyle(outlined)}
        />
      )}
      {!single &&
        geometry.selection.map(({ key, bounds: rect }) => (
          <div
            key={key}
            data-canvas-box={key}
            className="absolute border border-(--canvas-accent)"
            style={boxStyle(rect)}
          />
        ))}
      {bounds && !editingText && (
        <>
          <div
            data-canvas-selection-bounds=""
            className={cn("absolute border border-(--canvas-accent)/60", HIDDEN_IN_GESTURE)}
            style={boxStyle(bounds)}
          />
          <CanvasMeasureChip
            variant="badge"
            meta={[designSize(bounds)]}
            className={HIDDEN_IN_GESTURE}
            style={{
              left: screenX(bounds.x + bounds.width / 2),
              top: `calc(${screenY(bounds.y + bounds.height)} + 7px)`,
              transform: "translateX(-50%)",
            }}
          />
        </>
      )}
      {single && (
        <div
          data-canvas-selection-group={single.key}
          className="absolute inset-0"
          style={selectionVars(single.rect)}
        >
          <div
            className="absolute inset-0"
            style={
              single.angle
                ? {
                    transform: `rotate(${single.angle}deg)`,
                    transformOrigin: `calc(${SEL.l} + ${SEL.w} / 2) calc(${SEL.t} + ${SEL.h} / 2)`,
                  }
                : undefined
            }
          >
            <div
              data-canvas-selection-outline=""
              className="absolute border border-(--canvas-accent)"
              style={{ left: SEL.l, top: SEL.t, width: SEL.w, height: SEL.h }}
            />
            {showHandles && (
              <>
                {(["n", "s", "e", "w"] as const).map((side) => {
                  const horizontal = side === "n" || side === "s";
                  // Small layers keep their middle for dragging; only the corners resize them.
                  if (
                    (horizontal ? single.rect.height : single.rect.width) * zoom <
                    EDGE_HANDLE_MIN
                  )
                    return null;
                  const edgeX =
                    side === "w" ? SEL.l : side === "e" ? `(${SEL.l} + ${SEL.w})` : null;
                  const edgeY =
                    side === "n" ? SEL.t : side === "s" ? `(${SEL.t} + ${SEL.h})` : null;
                  // The edges are invisible hit zones; only the corners are drawn.
                  return (
                    <div
                      key={side}
                      data-canvas-ui=""
                      data-canvas-handle={side}
                      data-canvas-item={single.key}
                      className={cn(
                        "pointer-events-auto absolute",
                        horizontal ? "cursor-ns-resize" : "cursor-ew-resize",
                      )}
                      style={
                        horizontal
                          ? {
                              left: `calc(${SEL.l} + 6px)`,
                              top: `calc(${edgeY} - 3px)`,
                              width: `max(0px, calc(${SEL.w} - 12px))`,
                              height: 6,
                            }
                          : {
                              left: `calc(${edgeX} - 3px)`,
                              top: `calc(${SEL.t} + 6px)`,
                              width: 6,
                              height: `max(0px, calc(${SEL.h} - 12px))`,
                            }
                      }
                    />
                  );
                })}
                {(["nw", "ne", "sw", "se"] as const).map((corner) => (
                  <div
                    key={corner}
                    data-canvas-ui=""
                    data-canvas-handle={corner}
                    data-canvas-item={single.key}
                    className={cn(
                      HANDLE_CLASS_NAME,
                      corner === "nw" || corner === "se"
                        ? "cursor-nwse-resize"
                        : "cursor-nesw-resize",
                    )}
                    style={{
                      left: corner.includes("w") ? SEL.l : `calc(${SEL.l} + ${SEL.w})`,
                      top: corner.includes("n") ? SEL.t : `calc(${SEL.t} + ${SEL.h})`,
                    }}
                  />
                ))}
              </>
            )}
          </div>
          {showHandles &&
            single.rect.width * zoom >= SPACING_HANDLE_MIN &&
            single.rect.height * zoom >= SPACING_HANDLE_MIN &&
            geometry.spacing.map((spacing) => (
              <div
                key={`${spacing.handle}:${spacing.x}:${spacing.y}`}
                data-canvas-ui=""
                data-canvas-spacing={spacing.handle}
                data-canvas-item={single.key}
                className={cn(
                  SPACING_HANDLE_CLASS_NAME,
                  spacing.axis === "x" ? "cursor-ew-resize" : "cursor-ns-resize",
                  HIDDEN_IN_GESTURE,
                )}
                style={{
                  left: `calc(${X} + (${spacing.x}px + var(--sel-dx, 0px)) * ${Z})`,
                  top: `calc(${Y} + (${spacing.y}px + var(--sel-dy, 0px)) * ${Z})`,
                }}
              />
            ))}
          {!editingText && (
            <CanvasMeasureChip
              variant="badge"
              meta={chipMeta(single.rect)}
              style={{
                left: single.angle
                  ? screenX(single.bounds.x + single.bounds.width / 2)
                  : `calc(${SEL.l} + ${SEL.w} / 2)`,
                top: chipTop,
                transform: "translateX(-50%)",
              }}
            />
          )}
        </div>
      )}
      {measures.map((line) => (
        <Fragment key={`${line.axis}:${line.from}:${line.to}`}>
          <div
            className={cn("absolute bg-(--canvas-measure)", HIDDEN_IN_GESTURE)}
            style={
              line.axis === "y"
                ? {
                    left: `round(${screenX(line.x)}, 1px)`,
                    top: screenY(line.from),
                    width: 1,
                    height: screenLength(line.to - line.from),
                  }
                : {
                    left: screenX(line.from),
                    top: `round(${screenY(line.y)}, 1px)`,
                    width: screenLength(line.to - line.from),
                    height: 1,
                  }
            }
          />
          <CanvasMeasureChip
            variant="distance"
            label={String(line.value)}
            className={HIDDEN_IN_GESTURE}
            style={
              line.axis === "y"
                ? {
                    left: `calc(round(${screenX(line.x)}, 1px) + 5px)`,
                    top: screenY((line.from + line.to) / 2),
                    transform: "translateY(-50%)",
                  }
                : {
                    left: screenX((line.from + line.to) / 2),
                    top: `calc(round(${screenY(line.y)}, 1px) + 4px)`,
                    transform: "translateX(-50%)",
                  }
            }
          />
        </Fragment>
      ))}
      {!editingText && geometry.hover && hoverIndex && hoverTarget?.kind === "layer" && (
        <CanvasMeasureChip
          label={layerLabel(hoverIndex, hoverTarget.layerId)}
          meta={[designSize(geometry.hover)]}
          className={HIDDEN_IN_GESTURE}
          style={{
            left: screenX(geometry.hover.x),
            top: `max(0px, calc(${screenY(geometry.hover.y)} - 16px))`,
          }}
        />
      )}
    </div>
  );
});

const px = (value: string) => Number.parseFloat(value) || 0;

const unionRect = (rects: readonly WorldRect[]): WorldRect => {
  const left = Math.min(...rects.map((rect) => rect.x));
  const top = Math.min(...rects.map((rect) => rect.y));
  const right = Math.max(...rects.map((rect) => rect.x + rect.width));
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
};

/** A layer's own rotation in degrees (`rotate` plus the rotation in its `transform`). */
export function layerAngle(element: Element): number {
  const style = getComputedStyle(element);
  let angle = Number.parseFloat(style.rotate) || 0;
  const match = /^matrix\(([^)]+)\)$/.exec(style.transform);
  if (match) {
    const [a = 1, b = 0] = match[1]!.split(",").map(Number);
    angle += (Math.atan2(b, a) * 180) / Math.PI;
  }
  return Math.round(angle * 100) / 100;
}

/**
 * The flex handles: one in the middle of each padding band and one in each
 * gap between laid-out children, in world pixels. Only for a flex container.
 */
function spacingHandles(
  editor: Pick<CanvasEditorApi, "elementFor">,
  item: CanvasSelectionItem,
  rect: WorldRect,
  origin: DOMRect,
  view: { x: number; y: number; zoom: number },
): SpacingHandleBox[] {
  const element = editor.elementFor(item);
  if (!element) return [];
  const style = getComputedStyle(element);
  if (!style.display.includes("flex")) return [];
  const [top, right, bottom, left] = [
    px(style.paddingTop),
    px(style.paddingRight),
    px(style.paddingBottom),
    px(style.paddingLeft),
  ];
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  const handles: SpacingHandleBox[] = [
    { handle: "padding-top", x: cx, y: rect.y + top / 2, axis: "y" },
    { handle: "padding-bottom", x: cx, y: rect.y + rect.height - bottom / 2, axis: "y" },
    { handle: "padding-left", x: rect.x + left / 2, y: cy, axis: "x" },
    { handle: "padding-right", x: rect.x + rect.width - right / 2, y: cy, axis: "x" },
  ];
  const row = style.flexDirection.startsWith("row");
  const children = [...element.children]
    .filter(
      (child): child is HTMLElement =>
        child instanceof HTMLElement &&
        child.hasAttribute(DESIGN_LAYER_ATTRIBUTE) &&
        !isFreePositioned(child) &&
        child.getClientRects().length > 0,
    )
    .map((child) => screenToWorldRect(elementBox(child, origin)!, view))
    .toSorted((a, b) => (row ? a.x - b.x : a.y - b.y));
  for (let at = 1; at < children.length; at++) {
    const before = children[at - 1]!;
    const after = children[at]!;
    handles.push(
      row
        ? { handle: "gap", x: (before.x + before.width + after.x) / 2, y: cy, axis: "x" }
        : { handle: "gap", x: cx, y: (before.y + before.height + after.y) / 2, axis: "y" },
    );
  }
  return handles;
}

const scaled = (rect: WorldRect, zoom: number): WorldRect => ({
  x: rect.x * zoom,
  y: rect.y * zoom,
  width: rect.width * zoom,
  height: rect.height * zoom,
});
