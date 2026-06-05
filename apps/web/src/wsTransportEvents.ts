// FILE: wsTransportEvents.ts
// Purpose: Publish renderer-local WebSocket transport state changes to UI runtimes.
// Layer: Web transport utility
// Exports: event helpers used by wsNativeApi and terminal runtime recovery.

export type WsTransportState = "connecting" | "open" | "closed" | "disposed";

export const SYNARA_WS_TRANSPORT_STATE_EVENT = "synara:ws-transport-state";

export interface WsTransportStateEventDetail {
  state: WsTransportState;
}

// Emits a browser-local event without leaking transport internals into UI code.
export function emitWsTransportState(state: WsTransportState): void {
  if (
    typeof window === "undefined" ||
    typeof window.dispatchEvent !== "function" ||
    typeof CustomEvent === "undefined"
  ) {
    return;
  }

  window.dispatchEvent(
    new CustomEvent<WsTransportStateEventDetail>(SYNARA_WS_TRANSPORT_STATE_EVENT, {
      detail: { state },
    }),
  );
}

// Subscribes to the shared transport state event. Returns an idempotent cleanup.
export function addWsTransportStateListener(
  listener: (state: WsTransportState) => void,
): () => void {
  if (typeof window === "undefined" || typeof window.addEventListener !== "function") {
    return () => undefined;
  }

  const handleStateChange = (event: Event) => {
    const detail = (event as CustomEvent<WsTransportStateEventDetail>).detail;
    if (!detail) return;
    listener(detail.state);
  };

  window.addEventListener(SYNARA_WS_TRANSPORT_STATE_EVENT, handleStateChange);
  return () => {
    window.removeEventListener(SYNARA_WS_TRANSPORT_STATE_EVENT, handleStateChange);
  };
}
