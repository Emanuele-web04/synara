// FILE: ServerConnectionIndicator.tsx
// Purpose: Says the socket to the Synara server dropped and is reconnecting, the one state
//          that explains why threads stop updating. Desktop shows a small dot in the app rail
//          with the details in a hover card, so nothing covers the app's own menus. Phones,
//          whose rail lives inside the sidebar sheet, keep a floating notice.
// Layer: App shell component
// Depends on: the transport state events.

import { useEffect, useState } from "react";

import { useIsMobile } from "~/hooks/useMediaQuery";
import { cn } from "~/lib/utils";
import { addWsTransportStateListener } from "../wsTransportEvents";
import { appRailButtonClassName } from "./AppRail";
import {
  SIDEBAR_HOVER_CARD_POPUP_PROPS,
  SIDEBAR_HOVER_CARD_SURFACE_CLASS_NAME,
  SIDEBAR_HOVER_CARD_TRIGGER_PROPS,
} from "./sidebarHoverCardStyles";
import { PreviewCard, PreviewCardPopup, PreviewCardTrigger } from "./ui/preview-card";
import { StatusChip, StatusDot } from "./ui/status-chip";

const RECONNECTING_TITLE = "Reconnecting to Synara server";
const RECONNECTING_DETAIL =
  "The connection was interrupted. Thread updates will resume automatically when it recovers.";

/** True once a socket that had opened is connecting or closed again; never during startup. */
function useServerReconnecting(): boolean {
  const [reconnecting, setReconnecting] = useState(false);
  useEffect(() => {
    let hasConnected = false;
    return addWsTransportStateListener(
      (state) => {
        if (state === "open") hasConnected = true;
        setReconnecting(hasConnected && (state === "connecting" || state === "closed"));
      },
      { replayCurrent: true },
    );
  }, []);
  return reconnecting;
}

/** Title and detail; the surface around it (hover card or floating notice) owns the chrome. */
export function ServerReconnectingNotice({ className }: { className?: string }) {
  return (
    <div className={cn("text-ui", className)}>
      <StatusChip dotClassName="bg-amber-500" className="font-medium">
        {RECONNECTING_TITLE}
      </StatusChip>
      <p className="mt-1 text-ui-xs leading-relaxed text-muted-foreground">{RECONNECTING_DETAIL}</p>
    </div>
  );
}

/** Rail dot above the usage rings; hovering or focusing it shows the details. */
export function ServerConnectionRailButton() {
  const reconnecting = useServerReconnecting();
  if (!reconnecting) return null;
  return (
    <>
      <span role="status" aria-live="polite" className="sr-only">
        {RECONNECTING_TITLE}
      </span>
      <PreviewCard>
        <PreviewCardTrigger
          {...SIDEBAR_HOVER_CARD_TRIGGER_PROPS}
          render={
            <button
              type="button"
              aria-label={`${RECONNECTING_TITLE}. ${RECONNECTING_DETAIL}`}
              className={cn(
                appRailButtonClassName(false),
                "flex shrink-0 items-center justify-center",
              )}
            />
          }
        >
          <StatusDot pulse className="size-2 bg-amber-500" />
        </PreviewCardTrigger>
        <PreviewCardPopup
          {...SIDEBAR_HOVER_CARD_POPUP_PROPS}
          // The dot sits at the rail's foot, so the card grows upward from it.
          align="end"
          sideOffset={6}
          className={SIDEBAR_HOVER_CARD_SURFACE_CLASS_NAME}
        >
          <ServerReconnectingNotice className="p-2.5" />
        </PreviewCardPopup>
      </PreviewCard>
    </>
  );
}

/** Phones only: their rail is inside the closed sidebar sheet, so the status floats instead. */
export function ServerConnectionMobileNotice() {
  const isMobile = useIsMobile();
  const reconnecting = useServerReconnecting();
  if (!isMobile || !reconnecting) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed top-12 left-1/2 z-50 max-w-[calc(100vw-2rem)] -translate-x-1/2"
    >
      <ServerReconnectingNotice className="max-w-sm rounded-lg border border-border bg-popover px-3 py-2 text-popover-foreground shadow-md" />
    </div>
  );
}
