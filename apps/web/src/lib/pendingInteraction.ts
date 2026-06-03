// FILE: pendingInteraction.ts
// Purpose: Shared predicates for pending approval / user-input request lifecycle.
// Layer: Domain helper (consumed by store read-model normalization + session-logic)
// Exports: isStalePendingRequestFailureDetail

/** Provider "respond failed" details that mean the targeted request is already gone
 *  (stale or unknown), so the matching pending prompt should be cleared rather than
 *  kept open. Centralized so the store hot path and session derivations stay in sync. */
const STALE_PENDING_REQUEST_FAILURE_PHRASES = [
  "stale pending approval request",
  "stale pending user-input request",
  "unknown pending approval request",
  "unknown pending permission request",
  "unknown pending user-input request",
] as const;

export function isStalePendingRequestFailureDetail(detail: unknown): boolean {
  if (typeof detail !== "string") {
    return false;
  }
  const normalized = detail.toLowerCase();
  return STALE_PENDING_REQUEST_FAILURE_PHRASES.some((phrase) => normalized.includes(phrase));
}
