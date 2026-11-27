import type { DesignFrame } from "@synara/contracts";
import { useMemo } from "react";
import { useTranslation } from "~/i18n";
import type { DesignRenderContext } from "~/lib/designCanvas";
import { CanvasIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { CanvasFramePreview } from "./editor/CanvasFramePreview";

/**
 * The canvas backdrop (the app's background with the muted tint), so frames shown outside the
 * editor sit on the same ground and an empty work still reads as a well on its card.
 */
export const CANVAS_SURFACE_CLASS_NAME = "bg-(--canvas-backdrop)";

const THUMB_HEIGHT = 112;
const FRAME_GAP = 18;
/** A 300px card less the strip's 16px side padding. */
const INNER_WIDTH = 268;
const MAX_FRAMES = 4;
/** Past MAX_FRAMES the last place shows "+N" for the rest, in a tile this wide. */
const MORE_TILE_WIDTH = 36;
/** Pages taller than a phone are fitted like one; the rest runs off the bottom, as on the canvas. */
const MAX_FITTED_ASPECT = 2.2;

/**
 * One scale for every frame, so their relative sizes read as they do on the canvas; `reserved`
 * px of the strip's width are taken by something else (the "+N" tile and its gap).
 */
export function canvasFrameStripScale(
  frames: readonly Pick<DesignFrame, "width" | "height">[],
  reserved = 0,
) {
  if (frames.length === 0) return 1;
  const totalWidth = frames.reduce((sum, frame) => sum + frame.width, 0);
  const tallest = Math.max(
    ...frames.map((frame) => Math.min(frame.height, frame.width * MAX_FITTED_ASPECT)),
  );
  return Math.min(
    THUMB_HEIGHT / tallest,
    (INNER_WIDTH - reserved - FRAME_GAP * (frames.length - 1)) / totalWidth,
  );
}

/**
 * Frames in miniature on the canvas backdrop with their names above, the way they sit on the
 * canvas. With `onOpenFrame`, each frame is a button.
 */
export function CanvasFrameStrip({
  frames,
  context,
  onOpenFrame,
  frameLabel,
  className,
}: {
  frames: readonly DesignFrame[];
  /** The work's fonts and images, so the miniatures match the frames on the canvas. */
  context?: DesignRenderContext;
  onOpenFrame?: (frame: DesignFrame) => void;
  /** Accessible name of a frame button; defaults to the frame title. */
  frameLabel?: (frame: DesignFrame) => string;
  className?: string;
}) {
  // More frames than fit: the last place says how many more there are.
  const more = frames.length > MAX_FRAMES ? frames.length - (MAX_FRAMES - 1) : 0;
  const shown = frames.slice(0, more ? MAX_FRAMES - 1 : MAX_FRAMES);
  const scale = canvasFrameStripScale(shown, more ? MORE_TILE_WIDTH + FRAME_GAP : 0);
  const firstMore = frames[shown.length];
  return (
    <div
      className={cn(
        "flex h-32 shrink-0 items-start justify-center-safe gap-[18px] overflow-clip px-4 pt-3",
        CANVAS_SURFACE_CLASS_NAME,
        className,
      )}
    >
      {shown.length === 0 ? (
        <CanvasIcon className="m-auto size-6 text-muted-foreground/50" aria-hidden />
      ) : (
        shown.map((frame) => (
          <StripFrame
            key={frame.id}
            frame={frame}
            scale={scale}
            context={context}
            {...(onOpenFrame
              ? { onOpen: () => onOpenFrame(frame), label: frameLabel?.(frame) ?? frame.title }
              : {})}
          />
        ))
      )}
      {more > 0 && firstMore && (
        <MoreFramesTile
          count={more}
          height={Math.min(THUMB_HEIGHT, Math.max(...shown.map((frame) => frame.height * scale)))}
          {...(onOpenFrame ? { onOpen: () => onOpenFrame(firstMore) } : {})}
        />
      )}
    </div>
  );
}

/** "+N" for the frames past the strip's room, in a strip frame's place and outline. */
function MoreFramesTile({
  count,
  height,
  onOpen,
}: {
  count: number;
  height: number;
  onOpen?: () => void;
}) {
  const { t } = useTranslation();
  const label = t("workspace:canvasMoreFrames", { count });
  const content = (
    <>
      {/* An empty title line, so the tile lines up with the frames' thumbnails. */}
      <span className="invisible text-ui-2xs leading-tight" aria-hidden>
        {"\u00a0"}
      </span>
      <span
        className="flex shrink-0 items-center justify-center rounded-sm text-ui-xs text-muted-foreground tabular-nums ring-1 ring-foreground/6 group-hover/frame:font-semibold group-hover/frame:text-foreground group-hover/frame:ring-[1.5px] group-hover/frame:ring-foreground/22 group-focus-visible/frame:ring-[1.5px] group-focus-visible/frame:ring-foreground/22"
        style={{ width: MORE_TILE_WIDTH, height }}
      >
        +{count}
      </span>
    </>
  );
  const shell = "group/frame flex shrink-0 flex-col gap-1 text-start";
  return onOpen ? (
    <button
      type="button"
      data-canvas-strip-more={count}
      className={cn(shell, "cursor-pointer outline-none")}
      aria-label={label}
      onClick={onOpen}
    >
      {content}
    </button>
  ) : (
    <div data-canvas-strip-more={count} role="img" aria-label={label} className={shell}>
      {content}
    </div>
  );
}

function StripFrame({
  frame,
  scale,
  context,
  onOpen,
  label,
}: {
  frame: DesignFrame;
  scale: number;
  context: DesignRenderContext | undefined;
  onOpen?: () => void;
  label?: string;
}) {
  const preview = useMemo(() => ({ ...frame, style: frame.style ?? "" }), [frame]);
  const width = frame.width * scale;
  const content = (
    <>
      {/* The hidden semibold copy reserves the hover weight's width, so labels never shift. */}
      <span className="grid max-w-32 text-ui-2xs leading-tight">
        <span className="invisible col-start-1 row-start-1 truncate font-semibold" aria-hidden>
          {frame.title}
        </span>
        <span className="col-start-1 row-start-1 truncate text-muted-foreground group-hover/frame:font-semibold group-hover/frame:text-foreground group-focus-visible/frame:font-semibold group-focus-visible/frame:text-foreground">
          {frame.title}
        </span>
      </span>
      <span
        className="block shrink-0 overflow-hidden rounded-sm ring-1 ring-foreground/6 group-hover/frame:ring-[1.5px] group-hover/frame:ring-foreground/22 group-focus-visible/frame:ring-[1.5px] group-focus-visible/frame:ring-foreground/22"
        style={{ width, height: frame.height * scale }}
      >
        <span className="block origin-top-left" style={{ transform: `scale(${scale})` }}>
          <CanvasFramePreview frame={preview} {...(context ? { context } : {})} />
        </span>
      </span>
    </>
  );
  const shell = "group/frame flex shrink-0 flex-col gap-1 text-start";
  return onOpen ? (
    <button
      type="button"
      className={cn(shell, "cursor-pointer outline-none")}
      style={{ minWidth: width }}
      aria-label={label}
      onClick={onOpen}
    >
      {content}
    </button>
  ) : (
    <div className={shell} style={{ minWidth: width }}>
      {content}
    </div>
  );
}
