// FILE: requestOutcome.ts
// Purpose: Tells a request the server refused from one whose outcome is unknown because
//          the connection went (timeout, reconnect) while it was in flight: the server may
//          have applied it, so callers must reconcile instead of treating it as refused.
// Layer: Web RPC helper
// Exports: isRequestOutcomeUnknown

/** wsTransport's WsTransportRequestInterruptedError for a timeout or reconnect; a cancel is the caller's own. */
export function isRequestOutcomeUnknown(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    error._tag === "WsTransportRequestInterruptedError" &&
    "code" in error &&
    error.code !== "WS_REQUEST_ABORTED"
  );
}
