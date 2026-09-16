// FILE: ComputerPreviewPopover.tsx
// Purpose: Ambient in-chat mini preview of the desktop an agent is driving.
// Layer: Chat surface UI
// Depends on: computerPreviewStore session machine, computerStateStore thread
//             state, useComputerImageStream, ComputerPanel.logic helpers.
//
// View-only: the card is a pure scaled replica of the driven content — no
// header, no status text, no badges. Presence is the live indicator. Close
// lives in a hover/focus-reveal cluster (the composer's stop stays the
// always-visible safety net). It mounts wherever the owning thread's transcript is on
// screen and self-hides when that thread has no live preview session. Size is
// dynamic: the card fits the space its slot offers while keeping the live
// content's aspect, never a fixed box.

import type { ThreadId } from "@synara/contracts";
import { useEffect, useMemo, useRef, useState } from "react";

import { useAppSettings } from "../../appSettings";
import {
  selectThreadComputerPreviewSession,
  useComputerPreviewStore,
} from "../../computerPreviewStore";
import { selectThreadComputerState, useComputerStateStore } from "../../computerStateStore";
import { useComputerDesktopControl } from "../../hooks/useComputerDesktopControl";
import { useThreadComputerStateSeed } from "../../hooks/useThreadComputerStateSeed";
import { disclosurePopClassName } from "../../lib/disclosureMotion";
import { XIcon } from "../../lib/icons";
import { cn } from "../../lib/utils";
import {
  computerCanvasLabel,
  computerContainRect,
  computerCursorPosition,
  shouldSubscribeToComputerStream,
} from "../ComputerPanel.logic";
import { useComputerImageStream } from "../computer/useComputerImageStream";
import { useComputerPreviewTap } from "../computer/useComputerPreviewTap";
import {
  computerPreviewCardCaps,
  computerPreviewCardOpen,
  computerPreviewFrameSource,
  computerPreviewStatusLabel,
  type ComputerPreviewCardSize,
  type ComputerPreviewSession,
} from "./ComputerPreviewPopover.logic";

const FALLBACK_ASPECT_RATIO = "16 / 10";
// Slot fallbacks for the first paint (and server markup), before the slot is
// measured. The live card always fits its measured slot instead.
const SLOT_FALLBACK_WIDTH_PX = 320;
const SLOT_FALLBACK_HEIGHT_PX = 616;
const SLOT_MARGIN_X_PX = 32;
const SLOT_TOP_PX = 16;
const SLOT_BOTTOM_RESERVE_PX = 120;

export function ComputerPreviewPopover(props: {
  readonly threadId: ThreadId;
  /**
   * Rail budget: the widest the card may grow, set by the host ChatView from
   * the gutter it freed via content inset. Defaults to the size cap;
   * the card never exceeds it regardless of slot or aspect.
   */
  readonly maxWidthPx?: number | undefined;
  /**
   * Footprint from Settings (compact default). Picks the fit bounds; the
   * host ChatView applies the same cap to the gutter it frees.
   */
  readonly size?: ComputerPreviewCardSize | undefined;
}) {
  const session = useComputerPreviewStore(selectThreadComputerPreviewSession(props.threadId));
  // The "Open automatically" preference now governs the ambient preview, which
  // is what replaced the pane's auto-open. Manual opens are unaffected.
  const { settings } = useAppSettings();
  if (!settings.autoOpenComputerPane || session === undefined) {
    return null;
  }
  return (
    <ComputerPreviewPopoverCard
      threadId={props.threadId}
      session={session}
      maxWidthPx={props.maxWidthPx}
      size={props.size ?? "compact"}
    />
  );
}

function ComputerPreviewPopoverCard(props: {
  readonly threadId: ThreadId;
  readonly session: ComputerPreviewSession;
  readonly maxWidthPx?: number | undefined;
  readonly size?: ComputerPreviewCardSize | undefined;
}) {
  const { threadId, session } = props;
  const caps = computerPreviewCardCaps(props.size ?? "compact");
  const cardMaxWidth = Math.min(props.maxWidthPx ?? caps.maxWidthPx, caps.maxWidthPx);
  const open = computerPreviewCardOpen(session.phase);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const threadState = useComputerStateStore(selectThreadComputerState(threadId));
  const markPreviewLive = useComputerPreviewStore((store) => store.markPreviewLive);
  const hidePreviewForTask = useComputerPreviewStore((store) => store.hidePreviewForTask);
  const notePreviewLayout = useComputerPreviewStore((store) => store.notePreviewLayout);
  const desktopControl = useComputerDesktopControl(threadId);
  const statusLabel = computerPreviewStatusLabel({
    agentActive: desktopControl.agentActive,
    currentActivity: threadState?.activity ?? null,
    lastActionLabel: session.lastActionLabel ?? null,
  });
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const [slotSize, setSlotSize] = useState({ width: 0, height: 0 });

  useThreadComputerStateSeed(threadId);

  // Mounting means the owning thread is on screen: an armed session goes live
  // here, which is also what animates the card in from its closed state.
  useEffect(() => {
    if (session.phase === "armed") {
      markPreviewLive(threadId);
    }
  }, [markPreviewLive, session.phase, threadId]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const update = () => {
      setViewportSize((previous) => {
        const width = viewport.clientWidth;
        const height = viewport.clientHeight;
        return previous.width === width && previous.height === height
          ? previous
          : { width, height };
      });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  // The card fits the space its slot offers: measure the positioned ancestor
  // so window resizes, sidebar toggles, and split leaves all re-fit the card
  // instead of it overflowing or floating in dead space. In the env rail the
  // offset parent is the full-height rail wrapper, so its height is the
  // container height; width comes from the rail budget prop instead, because
  // the shrink-fit wrapper cannot measure what the freed gutter will be.
  useEffect(() => {
    const parent = cardRef.current?.offsetParent as HTMLElement | null;
    if (!parent) return;
    const update = () => {
      setSlotSize((previous) => {
        const width = parent.clientWidth;
        const height = parent.clientHeight;
        return previous.width === width && previous.height === height
          ? previous
          : { width, height };
      });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(parent);
    return () => observer.disconnect();
  }, []);

  const streamWanted = shouldSubscribeToComputerStream({
    runtimeMode: "live",
    isVisible: open,
    threadState,
  });
  // The desktop app's native tap is the preferred source while it keeps
  // delivering frames; the stills stream owns the canvas only while the tap
  // is quiet or absent, so the two never draw at the same time.
  const tap = useComputerPreviewTap({ canvasRef, threadId, enabled: streamWanted });
  const frameSource = computerPreviewFrameSource({
    streamWanted,
    tapActive: tap.active,
  });
  const { status: streamStatus, dimensions } = useComputerImageStream({
    canvasRef,
    computerId: streamWanted && threadState ? threadState.computerId : null,
    enabled: frameSource === "stills",
  });

  const frameSignal = tap.active || tap.frameSize !== null || streamStatus.kind === "streaming";
  // Delayed appearance: the card stays visually closed until the first real
  // frame lands, so it materializes with content instead of an empty box.
  // Crucially the (hidden) canvas stays mounted throughout: both frame
  // sources decode into canvasRef, so unmounting it would starve the very
  // signal the latch waits for. The latch survives quiet fallbacks and stills
  // reconnects within one mount; a remount (new thread) starts over. It seeds
  // from the render-time signal so server markup matches a live frame.
  const [hasFrame, setHasFrame] = useState(() => frameSignal);
  useEffect(() => {
    if (frameSignal) setHasFrame(true);
  }, [frameSignal]);
  // Closed until content exists: invisible and inert, but present for decode.
  const visuallyOpen = open && hasFrame;

  // Publish the live footprint for the rail: the chat reserves gutter space
  // only for a card that actually has content, at its fitted width.

  // Aspect follows the live content, not the desktop: tap frames are
  // window-cropped (often portrait) while stills cover the full workspace.
  const frameDims = tap.frameSize ?? threadState?.screenSize ?? dimensions ?? undefined;
  const frameAspect =
    frameDims && frameDims.height > 0 ? frameDims.width / frameDims.height : 16 / 10;
  const slotWidth = slotSize.width > 0 ? slotSize.width : SLOT_FALLBACK_WIDTH_PX;
  const slotHeight = slotSize.height > 0 ? slotSize.height : SLOT_FALLBACK_HEIGHT_PX;
  // Dynamic fit: fill the slot's width and height budget at the content
  // aspect, clamped to sane bounds. A tall phone-shaped window narrows the
  // card instead of growing past the chat; a wide desktop caps at the max.
  // The width basis is the rail budget when provided: the rail wrapper
  // shrink-fits the card, so measuring it would feed the card its own width
  // back and pin it small forever.
  const slotWidthBasis = props.maxWidthPx ?? slotWidth - SLOT_MARGIN_X_PX;
  const fitWidth = Math.max(
    caps.minWidthPx,
    Math.min(
      cardMaxWidth,
      slotWidthBasis,
      (slotHeight - SLOT_TOP_PX - SLOT_BOTTOM_RESERVE_PX) * frameAspect,
    ),
  );
  const containRect = useMemo(
    () =>
      frameDims
        ? computerContainRect({
            source: frameDims,
            containerWidth: viewportSize.width,
            containerHeight: viewportSize.height,
          })
        : null,
    [frameDims, viewportSize.width, viewportSize.height],
  );
  const cursorPosition = computerCursorPosition({
    cursor: threadState?.cursor,
    screenSize: frameDims,
    containRect,
  });
  // The card (and its canvas) stays mounted from arm through task end so both
  // frame sources always have a decode target; visibility alone is gated on
  // content, and hidden/ended keep rendering closed for the exit animation.
  useEffect(() => {
    notePreviewLayout(threadId, { hasFrame, width: fitWidth });
  }, [notePreviewLayout, threadId, hasFrame, fitWidth]);
  return (
    <div
      ref={cardRef}
      role="region"
      aria-label="Computer preview"
      data-computer-preview-popover={threadId}
      className={cn(
        "group pointer-events-auto flex flex-col overflow-hidden rounded-2xl border border-white/10 bg-popover/95 text-foreground shadow-[0_16px_56px_-16px_rgb(0_0_0/0.5),0_2px_12px_-2px_rgb(0_0_0/0.3)] backdrop-blur-xl",
        disclosurePopClassName(visuallyOpen),
      )}
      style={{ width: fitWidth, maxWidth: "calc(100vw - 2rem)" }}
    >
      <div
        ref={viewportRef}
        className="relative w-full overflow-hidden bg-muted/60"
        style={{
          aspectRatio: frameDims
            ? `${frameDims.width} / ${frameDims.height}`
            : FALLBACK_ASPECT_RATIO,
        }}
      >
        <canvas
          ref={canvasRef}
          aria-label={computerCanvasLabel({
            availability: threadState?.availability,
            visibleDesktop: desktopControl.visibleDesktop,
          })}
          tabIndex={-1}
          className="absolute inset-0 h-full w-full"
        />
        {/* Masks the captured window's antialiased edge fringe (the pale
            corner specks) with a 1px inner stroke, so the image meets the
            card with a finished edge. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 shadow-[inset_0_0_0_1px_rgb(0_0_0/0.45)]"
        />
        {/* Glass sheen: a faint top-down gloss over the live image. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-0 h-[45%] bg-gradient-to-b from-white/[0.09] via-white/[0.02] to-transparent"
        />
        {frameSource !== "tap" && streamStatus.kind !== "streaming" ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-3 text-center">
            <ComputerPreviewStreamStatus status={streamStatus} />
          </div>
        ) : null}
        {cursorPosition && frameSource !== "tap" ? (
          // The dot stands in for the pane's ghost cursor at this scale; the
          // violet halo is the same "this is the agent's" signal. It maps
          // desktop coordinates, so it is suppressed while the tap's
          // window-cropped frames own the canvas.
          <div
            aria-hidden="true"
            className="pointer-events-none absolute size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow-[0_0_3px_rgba(124,58,237,0.9),0_0_7px_rgba(124,58,237,0.65)]"
            style={{ left: cursorPosition.left, top: cursorPosition.top }}
          />
        ) : null}
        {statusLabel ? (
          <div className="pointer-events-none absolute bottom-2 left-2 flex max-w-[calc(100%_-_1rem)] items-center gap-1.5 rounded-full border border-white/15 bg-black/55 px-2.5 py-1 text-[10px] font-medium text-white shadow-sm backdrop-blur-md">
            <span
              aria-hidden="true"
              className={cn(
                "size-1.5 shrink-0 rounded-full bg-violet-300",
                desktopControl.agentActive && "animate-pulse motion-reduce:animate-none",
              )}
            />
            <span className="truncate">{statusLabel}</span>
          </div>
        ) : null}
        <div className="pointer-events-none absolute inset-0">
          <div className="absolute top-2 right-2 translate-y-1 opacity-0 transition-[opacity,transform] duration-200 ease-out group-focus-within:translate-y-0 group-focus-within:opacity-100 group-hover:translate-y-0 group-hover:opacity-100 motion-reduce:translate-y-0 motion-reduce:transition-none pointer-coarse:translate-y-0 pointer-coarse:opacity-100">
            <div className="pointer-events-auto flex items-center gap-1 rounded-full border border-white/20 bg-gradient-to-b from-white/25 via-white/10 to-white/[0.06] p-1 shadow-[inset_0_1px_0_rgb(255_255_255/0.28),0_8px_24px_-8px_rgb(0_0_0/0.45)] backdrop-blur-md backdrop-saturate-150">
              <button
                type="button"
                onClick={() => hidePreviewForTask(threadId)}
                title="Hide the preview for the rest of this task"
                aria-label="Hide the computer preview for the rest of this task"
                className="grid size-7 place-items-center rounded-full text-white drop-shadow-[0_1px_2px_rgb(0_0_0/0.6)] transition-colors duration-150 hover:bg-white/20 focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:outline-none"
              >
                <XIcon className="size-4" />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function ComputerPreviewStreamStatus(props: {
  status: ReturnType<typeof useComputerImageStream>["status"];
}) {
  if (props.status.kind === "connecting") {
    return (
      <span className="text-[10px] text-muted-foreground" role="status">
        Connecting to the desktop…
      </span>
    );
  }
  if (props.status.kind === "unsupported") {
    return (
      <span className="text-[10px] text-muted-foreground">
        This browser cannot decode desktop frames.
      </span>
    );
  }
  if (props.status.kind === "error") {
    return <span className="text-[10px] text-muted-foreground">{props.status.message}</span>;
  }
  return <span className="text-[10px] text-muted-foreground">Waiting for the desktop…</span>;
}
