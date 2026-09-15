// FILE: ComputerPreviewPopover.tsx
// Purpose: Ambient in-chat mini preview of the desktop an agent is driving.
// Layer: Chat surface UI
// Depends on: computerPreviewStore session machine, computerStateStore thread
//             state, useComputerImageStream, ComputerPanel.logic helpers.
//
// View-only: the card shows the live desktop stills for the thread whose agent
// is driving, plus Stop (same interrupt as the pane), expand (the detailed
// right-dock Computer pane), and close (hides for the rest of the task). It
// mounts wherever the owning thread's transcript is on screen and self-hides
// when that thread has no live preview session.

import type { ThreadId } from "@synara/contracts";
import { useEffect, useMemo, useRef, useState } from "react";

import { useAppSettings } from "../../appSettings";
import {
  selectThreadComputerPreviewSession,
  useComputerPreviewStore,
} from "../../computerPreviewStore";
import {
  selectThreadComputerAction,
  selectThreadComputerState,
  useComputerStateStore,
} from "../../computerStateStore";
import { useComputerDesktopControl } from "../../hooks/useComputerDesktopControl";
import { useThreadComputerStateSeed } from "../../hooks/useThreadComputerStateSeed";
import { DISCLOSURE_CONTENT_MOTION_CLASS } from "../../lib/disclosureMotion";
import { MonitorIcon, PanelRightCloseIcon, StopIcon, XIcon } from "../../lib/icons";
import { cn } from "../../lib/utils";
import {
  computerActionStatusLabel,
  computerCanvasLabel,
  computerContainRect,
  computerCursorPosition,
  computerStopControlLabel,
  shouldSubscribeToComputerStream,
} from "../ComputerPanel.logic";
import { useComputerImageStream } from "../computer/useComputerImageStream";
import { useComputerPreviewTap } from "../computer/useComputerPreviewTap";
import { Button } from "../ui/button";
import {
  computerPreviewCardOpen,
  computerPreviewFrameSource,
  computerPreviewStatusLabel,
  type ComputerPreviewSession,
} from "./ComputerPreviewPopover.logic";

const PREVIEW_MAX_HEIGHT_PX = 220;
const FALLBACK_ASPECT_RATIO = "16 / 10";

export function ComputerPreviewPopover(props: {
  readonly threadId: ThreadId;
  /** Opens the detailed Computer surface for this thread (the dock pane path). */
  readonly onExpand: () => void;
  /**
   * The dock already shows this thread's Computer pane. Mirrors the floating
   * browser's rule: the ambient surface yields instead of doubling the stream.
   */
  readonly dockComputerPaneVisible?: boolean;
}) {
  const session = useComputerPreviewStore(selectThreadComputerPreviewSession(props.threadId));
  // The "Open automatically" preference now governs the ambient preview, which
  // is what replaced the pane's auto-open. Manual opens are unaffected.
  const { settings } = useAppSettings();
  if (!settings.autoOpenComputerPane || session === undefined || props.dockComputerPaneVisible) {
    return null;
  }
  return (
    <ComputerPreviewPopoverCard
      threadId={props.threadId}
      session={session}
      onExpand={props.onExpand}
    />
  );
}

function ComputerPreviewPopoverCard(props: {
  readonly threadId: ThreadId;
  readonly session: ComputerPreviewSession;
  readonly onExpand: () => void;
}) {
  const { threadId, session } = props;
  const open = computerPreviewCardOpen(session.phase);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const threadState = useComputerStateStore(selectThreadComputerState(threadId));
  const lastAction = useComputerStateStore(selectThreadComputerAction(threadId));
  const markPreviewLive = useComputerPreviewStore((store) => store.markPreviewLive);
  const hidePreviewForTask = useComputerPreviewStore((store) => store.hidePreviewForTask);
  const desktopControl = useComputerDesktopControl(threadId);
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });

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
      setViewportSize({ width: viewport.clientWidth, height: viewport.clientHeight });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(viewport);
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

  const screenSize = threadState?.screenSize ?? dimensions ?? undefined;
  const containRect = useMemo(
    () =>
      screenSize
        ? computerContainRect({
            source: screenSize,
            containerWidth: viewportSize.width,
            containerHeight: viewportSize.height,
          })
        : null,
    [screenSize, viewportSize.width, viewportSize.height],
  );
  const cursorPosition = computerCursorPosition({
    cursor: threadState?.cursor,
    screenSize,
    containRect,
  });
  const lastActionLabel =
    computerActionStatusLabel(lastAction, threadState?.windows) ?? session.lastActionLabel ?? null;
  const statusLabel = computerPreviewStatusLabel({
    agentActive: desktopControl.agentActive,
    lastActionLabel,
  });
  const stopControlLabel = computerStopControlLabel({
    agentActive: desktopControl.agentActive,
    visibleDesktop: desktopControl.visibleDesktop,
  });

  return (
    <div
      role="region"
      aria-label="Computer preview"
      data-computer-preview-popover={threadId}
      className={cn(
        DISCLOSURE_CONTENT_MOTION_CLASS,
        "absolute bottom-4 right-4 z-30 flex w-[300px] flex-col overflow-hidden rounded-xl border border-border bg-background text-foreground shadow-2xl ring-1 ring-black/10",
        open ? "translate-y-0 opacity-100" : "pointer-events-none translate-y-1 opacity-0",
      )}
    >
      <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-border px-2">
        <MonitorIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="shrink-0 font-medium text-xs">Computer</span>
        <span className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground">
          {statusLabel}
        </span>
        <div className="flex shrink-0 items-center gap-0.5">
          {stopControlLabel ? (
            <Button
              variant="ghost"
              size="icon-sm"
              className="size-6 text-destructive"
              disabled={desktopControl.stopRequested}
              onClick={desktopControl.stop}
              title={stopControlLabel}
              aria-label={stopControlLabel}
            >
              <StopIcon />
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="icon-sm"
            className="size-6"
            onClick={() => {
              // The dock pane takes over while open: the popover yields
              // via dockComputerPaneVisible and returns when the pane
              // closes, so the session must NOT hide for the task here.
              props.onExpand();
            }}
            title="Open the Computer pane"
            aria-label="Open the Computer pane"
          >
            <PanelRightCloseIcon />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            className="size-6"
            onClick={() => hidePreviewForTask(threadId)}
            title="Hide the preview for the rest of this task"
            aria-label="Hide the computer preview for the rest of this task"
          >
            <XIcon />
          </Button>
        </div>
      </div>
      <div
        ref={viewportRef}
        className="relative w-full overflow-hidden bg-black/90"
        style={{
          aspectRatio: screenSize
            ? `${screenSize.width} / ${screenSize.height}`
            : FALLBACK_ASPECT_RATIO,
          maxHeight: PREVIEW_MAX_HEIGHT_PX,
        }}
      >
        <canvas
          ref={canvasRef}
          aria-label={computerCanvasLabel({
            availability: threadState?.availability,
            visibleDesktop: desktopControl.visibleDesktop,
          })}
          tabIndex={-1}
          className="absolute inset-0 h-full w-full object-contain"
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
      </div>
    </div>
  );
}

function ComputerPreviewStreamStatus(props: {
  status: ReturnType<typeof useComputerImageStream>["status"];
}) {
  if (props.status.kind === "connecting") {
    return (
      <span className="text-[10px] text-white/65" role="status">
        Connecting to the desktop…
      </span>
    );
  }
  if (props.status.kind === "unsupported") {
    return (
      <span className="text-[10px] text-white/65">This browser cannot decode desktop frames.</span>
    );
  }
  if (props.status.kind === "error") {
    return <span className="text-[10px] text-white/70">{props.status.message}</span>;
  }
  return <span className="text-[10px] text-white/50">Waiting for the desktop…</span>;
}
