// FILE: CanvasAgentActivity.tsx
// Purpose: What an agent's work looks like on the canvas: a pulsing outline that
//          follows the frame's corner radius, a strip of "rain" dots in the frame's label row,
//          both fading in and out over 400 ms, and per-layer reveal flashes for reads, writes,
//          edits and deletes. Reveals are drawn outside React from the activity store, so an
//          agent's edits never re-render the canvas; reduced motion turns them off.
// Layer: Canvas editor UI
// Exports: CanvasAgentOutlines, CanvasAgentRain, CanvasAgentReveals, useFadePresence,
//          rememberRemovedLayers, AGENT_FADE_MS, REVEAL_DURATIONS

import type { DesignFrame } from "@synara/contracts";
import { memo, useEffect, useRef, useState, type CSSProperties, type RefObject } from "react";
import { useTranslation } from "~/i18n";
import { cn } from "~/lib/utils";
import {
  canvasActivityKey,
  FRAME_ACTIVITY_KEY,
  useCanvasActivityStore,
  type CanvasAgentActivityKind,
} from "../canvasStores";
import type { CanvasEditorApi } from "./CanvasEditorContext";
import { elementBox, screenToWorldRect, type WorldRect } from "./canvasMeasure";

/** The outline and the rain fade in and out over this long (not a disclosure motion). */
export const AGENT_FADE_MS = 400;
/** How long each reveal flash lasts (read 1.5 s, write as read, edit 1.0 s, delete 0.8 s). */
export const REVEAL_DURATIONS: Readonly<Record<CanvasAgentActivityKind, number>> = {
  read: 1500,
  write: 1500,
  edit: 1000,
  delete: 800,
};
/** The rain strip: two rows of at most 32 columns. */
const RAIN_COLUMNS = 32;
const RAIN_ROWS = 2;

const reducedMotion = () =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Keeps something mounted while it fades out: `mounted` stays true for `ms` after `active`
 * turns false, and `visible` drives the opacity.
 */
export function useFadePresence(active: boolean, ms = AGENT_FADE_MS) {
  const [mounted, setMounted] = useState(active);
  const [visible, setVisible] = useState(active);
  useEffect(() => {
    if (active) {
      setMounted(true);
      // One frame at opacity 0 first, so the fade in runs.
      const id = requestAnimationFrame(() => setVisible(true));
      return () => cancelAnimationFrame(id);
    }
    setVisible(false);
    const timer = setTimeout(() => setMounted(false), ms);
    return () => clearTimeout(timer);
  }, [active, ms]);
  return { mounted: mounted || active, visible: visible && active };
}

const fadeStyle = (visible: boolean): CSSProperties => ({ opacity: visible ? 1 : 0 });
/** The 400 ms fade; reduced motion shows and hides at once. */
const FADE_CLASS_NAME = "transition-opacity duration-400 ease-out motion-reduce:transition-none";

// World → screen through the viewport's live camera variables.
const boxStyle = (rect: WorldRect): CSSProperties => ({
  left: `calc(var(--canvas-x) + (${rect.x}px + var(--canvas-box-dx, 0px)) * var(--canvas-zoom))`,
  top: `calc(var(--canvas-y) + (${rect.y}px + var(--canvas-box-dy, 0px)) * var(--canvas-zoom))`,
  width: `calc(${rect.width}px * var(--canvas-zoom))`,
  height: `calc(${rect.height}px * var(--canvas-zoom))`,
});

function AgentOutline({
  frame,
  active,
  radius,
}: {
  frame: DesignFrame;
  active: boolean;
  radius: string;
}) {
  const { mounted, visible } = useFadePresence(active);
  if (!mounted) return null;
  return (
    <div
      data-canvas-box={`frame:${frame.id}`}
      data-canvas-agent-outline={frame.id}
      className={cn("absolute", FADE_CLASS_NAME)}
      style={{ ...boxStyle(frame), ...fadeStyle(visible) }}
    >
      <div
        className="absolute -inset-px animate-[canvas-agent-pulse_1.6s_ease-in-out_infinite] border-[1.5px] border-(--canvas-agent) motion-reduce:animate-none"
        // The frame's corner radius, scaled to the screen like the frame itself.
        style={{ borderRadius: `calc(${radius} * var(--canvas-zoom))` }}
      />
    </div>
  );
}

/** Pulsing outlines on the frames an agent is working on, fading in and out. */
export const CanvasAgentOutlines = memo(function CanvasAgentOutlines({
  frames,
  agentFrames,
  radii,
}: {
  frames: readonly DesignFrame[];
  agentFrames: ReadonlySet<string>;
  radii: Readonly<Record<string, string>>;
}) {
  // Frames stay listed while their outline fades out.
  const [listed, setListed] = useState<ReadonlySet<string>>(agentFrames);
  useEffect(() => {
    setListed((current) => {
      const missing = [...agentFrames].filter((id) => !current.has(id));
      return missing.length ? new Set([...current, ...missing]) : current;
    });
    const timer = setTimeout(
      () =>
        setListed((current) => {
          const kept = [...current].filter((id) => agentFrames.has(id));
          return kept.length === current.size ? current : new Set(kept);
        }),
      AGENT_FADE_MS,
    );
    return () => clearTimeout(timer);
  }, [agentFrames]);
  return (
    <>
      {[...listed].map((frameId) => {
        const frame = frames.find((item) => item.id === frameId);
        return frame ? (
          <AgentOutline
            key={frameId}
            frame={frame}
            active={agentFrames.has(frameId)}
            radius={radii[frameId] ?? "0px"}
          />
        ) : null;
      })}
    </>
  );
});

/**
 * The rain: two rows of up to 32 dots that run leftward from the right edge, cut off on the
 * left where the space ends. `muted` is the grayscale indicator of the pages list.
 */
export function CanvasAgentRain({
  muted = false,
  visible = true,
  className,
}: {
  muted?: boolean;
  visible?: boolean;
  className?: string;
}) {
  const dots = [];
  for (let column = 0; column < RAIN_COLUMNS; column++)
    for (let row = 0; row < RAIN_ROWS; row++)
      dots.push(
        <span
          key={`${column}:${row}`}
          className={cn(
            "size-[2px] animate-[canvas-agent-rain_1.2s_linear_infinite] rounded-full motion-reduce:animate-none motion-reduce:opacity-60",
            muted ? "bg-muted-foreground" : "bg-(--canvas-agent)",
          )}
          // A column's two dots fall a beat apart; columns run leftward from the right edge.
          style={{ animationDelay: `${-((column * 7 + row * 5) % 12) / 10}s` }}
        />,
      );
  return (
    <span
      aria-hidden
      data-canvas-agent-rain=""
      className={cn("flex min-w-0 shrink justify-end overflow-hidden", FADE_CLASS_NAME, className)}
      style={fadeStyle(visible)}
    >
      <span
        className="grid shrink-0 grid-flow-col gap-[2px]"
        style={{
          gridTemplateRows: `repeat(${RAIN_ROWS}, 2px)`,
          direction: "rtl",
        }}
      >
        {dots}
      </span>
    </span>
  );
}

/** In the pages list, a page with agent activity shows grayscale rain instead of its icon. */
export function CanvasAgentPageIndicator() {
  const { t } = useTranslation();
  return (
    <span
      role="img"
      aria-label={t("workspace:canvasAgentWorking")}
      data-canvas-page-activity=""
      className="flex w-3.5 shrink-0"
    >
      <CanvasAgentRain muted className="w-full" />
    </span>
  );
}

/* ---------------------------------------------------------------- reveals */

/** Boxes of layers a frame update just removed (frame pixels), for the delete flash. */
const removed = new Map<string, { rect: WorldRect; at: number }>();
const REMOVED_TTL_MS = 5000;
const removedKey = (frameId: string, layerId: string) => `${frameId}/${layerId}`;

/**
 * Called before a frame's DOM drops layers: remembers where they were (in frame pixels), so a
 * delete event arriving after the change can still flash where the layer was.
 */
export function rememberRemovedLayers(
  frame: Pick<DesignFrame, "id" | "width">,
  root: HTMLElement,
  elements: Iterable<readonly [string, Element]>,
) {
  const now = Date.now();
  for (const [key, entry] of removed) if (now - entry.at > REMOVED_TTL_MS) removed.delete(key);
  const origin = root.getBoundingClientRect();
  const scale = origin.width > 0 ? origin.width / frame.width : 1;
  let count = 0;
  for (const [layerId, element] of elements) {
    if (++count > 200) break;
    const box = elementBox(element, origin);
    if (!box) continue;
    removed.set(removedKey(frame.id, layerId), {
      at: now,
      rect: {
        x: box.x / scale,
        y: box.y / scale,
        width: box.width / scale,
        height: box.height / scale,
      },
    });
  }
}

const REVEAL_TINT: Readonly<Record<CanvasAgentActivityKind, string>> = {
  read: "color-mix(in oklch, var(--canvas-agent) 12%, transparent)",
  write: "color-mix(in oklch, var(--canvas-agent) 22%, transparent)",
  edit: "color-mix(in oklch, var(--canvas-agent) 22%, transparent)",
  delete: "color-mix(in oklch, var(--destructive) 22%, transparent)",
};

const clip = (rect: WorldRect, outer: WorldRect): WorldRect | null => {
  const x = Math.max(rect.x, outer.x);
  const y = Math.max(rect.y, outer.y);
  const right = Math.min(rect.x + rect.width, outer.x + outer.width);
  const bottom = Math.min(rect.y + rect.height, outer.y + outer.height);
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
};

/**
 * Per-layer reveal flashes from `useCanvasActivityStore.layers`: each new entry flashes an
 * overlay over its layer (or frame), clipped to the frame; a written layer stays hidden until
 * halfway through. Drawn into `container` outside React.
 */
export function CanvasAgentReveals({
  editor,
  container,
  viewport,
}: {
  editor: Pick<CanvasEditorApi, "work" | "page" | "elementFor" | "frame" | "camera">;
  container: RefObject<HTMLElement | null>;
  viewport: RefObject<HTMLElement | null>;
}) {
  const latest = useRef(editor);
  latest.current = editor;
  useEffect(() => {
    const seen = new Map<string, number>();
    const flash = (frameId: string, layerId: string, kind: CanvasAgentActivityKind) => {
      const host = container.current;
      const element = viewport.current;
      const { elementFor, frame: frameOf, camera } = latest.current;
      const frame = frameOf(frameId);
      if (!host || !element || !frame) return;
      const frameRect = { x: frame.x, y: frame.y, width: frame.width, height: frame.height };
      let rect: WorldRect | null = null;
      if (layerId === FRAME_ACTIVITY_KEY) rect = frameRect;
      else if (kind === "delete") {
        const known = removed.get(removedKey(frameId, layerId));
        if (known)
          rect = {
            x: frame.x + known.rect.x,
            y: frame.y + known.rect.y,
            width: known.rect.width,
            height: known.rect.height,
          };
      } else {
        const layer = elementFor({ kind: "layer", frameId, layerId });
        const box = layer ? elementBox(layer, element.getBoundingClientRect()) : null;
        rect = box ? screenToWorldRect(box, camera.get()) : null;
        if (layer && kind === "write")
          layer.animate([{ opacity: 0 }, { opacity: 0, offset: 0.5 }, { opacity: 1 }], {
            duration: REVEAL_DURATIONS.write,
            easing: "ease-out",
          });
      }
      const shown = rect ? clip(rect, frameRect) : null;
      if (!shown) return;
      const overlay = host.ownerDocument.createElement("div");
      overlay.dataset.canvasReveal = kind;
      overlay.className = "pointer-events-none absolute";
      Object.assign(overlay.style, boxStyle(shown), { background: REVEAL_TINT[kind] });
      host.append(overlay);
      const animation = overlay.animate(
        [{ opacity: 0 }, { opacity: 1, offset: 0.15 }, { opacity: 0 }],
        {
          duration: REVEAL_DURATIONS[kind],
          easing: "ease-out",
        },
      );
      animation.addEventListener("finish", () => overlay.remove());
      animation.addEventListener("cancel", () => overlay.remove());
    };
    const run = (state: ReturnType<typeof useCanvasActivityStore.getState>) => {
      if (reducedMotion()) return;
      const { work, page } = latest.current;
      const frames = state.layers[canvasActivityKey(work.id, page.id)] ?? {};
      for (const [frameId, layers] of Object.entries(frames))
        for (const [layerId, entry] of Object.entries(layers)) {
          const key = `${frameId}/${layerId}`;
          if ((seen.get(key) ?? 0) >= entry.at) continue;
          seen.set(key, entry.at);
          // Only what arrives while the canvas is open flashes.
          if (Date.now() - entry.at > 1000) continue;
          // After the frame has rendered the change the event follows.
          requestAnimationFrame(() => flash(frameId, layerId, entry.kind));
        }
    };
    // What was already there when the canvas opened does not flash.
    const initial = useCanvasActivityStore.getState();
    const { work, page } = latest.current;
    for (const [frameId, layers] of Object.entries(
      initial.layers[canvasActivityKey(work.id, page.id)] ?? {},
    ))
      for (const [layerId, entry] of Object.entries(layers))
        seen.set(`${frameId}/${layerId}`, entry.at);
    return useCanvasActivityStore.subscribe(run);
  }, [container, viewport]);
  return null;
}
