// FILE: ServerBusyIndicator.tsx
// Purpose: Server liveness status (busy, recovered, reconnecting). Desktop shows a small dot in
//          the app rail with the details in a hover card, so nothing covers the app's own menus.
//          Phones, whose rail lives inside the sidebar sheet, keep a floating notice.
// Layer: App shell component
// Depends on: serverBusyState (heartbeat + pending count) and the transport state events.

import { useEffect, useState, useSyncExternalStore } from "react";

import { useIsMobile } from "~/hooks/useMediaQuery";
import { cn } from "~/lib/utils";
import {
  getServerBusySnapshot,
  subscribeServerBusy,
  type ServerBusySnapshot,
} from "../serverBusyState";
import { addWsTransportStateListener, type WsTransportState } from "../wsTransportEvents";
import { appRailButtonClassName } from "./AppRail";
import {
  SIDEBAR_HOVER_CARD_POPUP_PROPS,
  SIDEBAR_HOVER_CARD_SURFACE_CLASS_NAME,
  SIDEBAR_HOVER_CARD_TRIGGER_PROPS,
} from "./sidebarHoverCardStyles";
import { PreviewCard, PreviewCardPopup, PreviewCardTrigger } from "./ui/preview-card";
import { StatusChip, StatusDot } from "./ui/status-chip";

interface ServerBusyDescription {
  readonly title: string;
  readonly detail: string;
  readonly recovered: boolean;
}

/**
 * Null unless the server itself misses its heartbeat, has just recovered from a stall, or the
 * socket is reconnecting — never for one slow request on a server that still answers.
 */
function describeServerBusy(
  snapshot: ServerBusySnapshot,
  reconnecting: boolean,
): ServerBusyDescription | null {
  if (!reconnecting && !snapshot.reason) return null;
  const waiting =
    snapshot.pendingRequests === 1
      ? "1 request is still waiting."
      : `${snapshot.pendingRequests} requests are still waiting.`;
  if (reconnecting) {
    return {
      title: "Reconnecting to Synara server",
      detail: `The connection was interrupted. Thread updates will resume automatically when it recovers.${snapshot.pendingRequests ? ` ${waiting}` : ""}`,
      recovered: false,
    };
  }
  if (snapshot.reason === "unresponsive") {
    return {
      title: "Synara server is busy",
      detail: `The server is not answering. Heavy load or a connection delay may be the cause.${snapshot.pendingRequests ? ` ${waiting}` : " Updates will resume when it responds."}`,
      recovered: false,
    };
  }
  return {
    title: "Synara server recovered",
    detail: `The server paused for ${((snapshot.lastStallMs ?? 0) / 1000).toFixed(1)} s and is responding again.${snapshot.pendingRequests ? ` ${waiting}` : ""}`,
    recovered: true,
  };
}

interface ServerBusyStatus {
  readonly snapshot: ServerBusySnapshot;
  readonly reconnecting: boolean;
  readonly description: ServerBusyDescription;
}

function useServerBusyStatus(): ServerBusyStatus | null {
  const [transportState, setTransportState] = useState<WsTransportState | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  useEffect(() => {
    let hasConnected = false;
    return addWsTransportStateListener(
      (state) => {
        setTransportState(state);
        if (state === "open") hasConnected = true;
        setReconnecting(hasConnected && (state === "connecting" || state === "closed"));
      },
      { replayCurrent: true },
    );
  }, []);
  const snapshot = useSyncExternalStore(
    subscribeServerBusy,
    getServerBusySnapshot,
    getServerBusySnapshot,
  );
  if (!reconnecting && transportState !== "open") return null;
  const description = describeServerBusy(snapshot, reconnecting);
  return description ? { snapshot, reconnecting, description } : null;
}

function serverBusyDotClassName(description: ServerBusyDescription): string {
  return description.recovered ? "bg-emerald-500" : "bg-amber-500";
}

/** Title and detail; the surface around it (hover card or floating notice) owns the chrome. */
export function ServerBusyNotice({
  snapshot,
  reconnecting = false,
  className,
}: {
  snapshot: ServerBusySnapshot;
  reconnecting?: boolean;
  className?: string;
}) {
  const description = describeServerBusy(snapshot, reconnecting);
  if (!description) return null;
  return (
    <div className={cn("text-ui", className)}>
      <StatusChip dotClassName={serverBusyDotClassName(description)} className="font-medium">
        {description.title}
      </StatusChip>
      <p className="mt-1 text-ui-xs leading-relaxed text-muted-foreground">{description.detail}</p>
    </div>
  );
}

/** Rail dot above the usage rings; hovering or focusing it shows the details. */
export function ServerBusyRailButton() {
  const status = useServerBusyStatus();
  if (!status) return null;
  const { description } = status;
  return (
    <>
      <span role="status" aria-live="polite" className="sr-only">
        {description.title}
      </span>
      <PreviewCard>
        <PreviewCardTrigger
          {...SIDEBAR_HOVER_CARD_TRIGGER_PROPS}
          render={
            <button
              type="button"
              aria-label={`${description.title}. ${description.detail}`}
              className={cn(
                appRailButtonClassName(false),
                "flex shrink-0 items-center justify-center",
              )}
            />
          }
        >
          <StatusDot
            pulse={!description.recovered}
            className={cn("size-2", serverBusyDotClassName(description))}
          />
        </PreviewCardTrigger>
        <PreviewCardPopup
          {...SIDEBAR_HOVER_CARD_POPUP_PROPS}
          // The dot sits at the rail's foot, so the card grows upward from it.
          align="end"
          sideOffset={6}
          className={SIDEBAR_HOVER_CARD_SURFACE_CLASS_NAME}
        >
          <ServerBusyNotice
            snapshot={status.snapshot}
            reconnecting={status.reconnecting}
            className="p-2.5"
          />
        </PreviewCardPopup>
      </PreviewCard>
    </>
  );
}

/** Phones only: their rail is inside the closed sidebar sheet, so the status floats instead. */
export function ServerBusyMobileNotice() {
  const isMobile = useIsMobile();
  const status = useServerBusyStatus();
  if (!isMobile || !status) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed top-12 left-1/2 z-50 max-w-[calc(100vw-2rem)] -translate-x-1/2"
    >
      <ServerBusyNotice
        snapshot={status.snapshot}
        reconnecting={status.reconnecting}
        className="max-w-sm rounded-lg border border-border bg-popover px-3 py-2 text-popover-foreground shadow-md"
      />
    </div>
  );
}
