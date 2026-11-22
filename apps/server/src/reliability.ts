import { Schema } from "effect";
import { ReliabilityInput, type ReliabilityCode } from "@synara/contracts";

const lastReport = new Map<ReliabilityCode, number>();
const PEER_REPORT_INTERVAL_MS = 30_000;
const HOST_STATE_REPORT_INTERVAL_MS = 10 * 60_000;
/**
 * Codes a retry loop or unauthenticated peer can repeat. Each is limited to one
 * report per window so churn cannot flood desktop IPC or its durable spool; the
 * totals count reporting windows, not every occurrence.
 */
const REPORT_INTERVAL_MS: ReadonlyMap<ReliabilityCode, number> = new Map([
  ["remote.ingress_socket_error", PEER_REPORT_INTERVAL_MS],
  ["remote.tunnel_socket_error", PEER_REPORT_INTERVAL_MS],
  ["remote.admission_refused", PEER_REPORT_INTERVAL_MS],
  ["remote.authorization_failed", HOST_STATE_REPORT_INTERVAL_MS],
  ["remote.authorization_denied", HOST_STATE_REPORT_INTERVAL_MS],
  ["remote.authorization_subscription_required", HOST_STATE_REPORT_INTERVAL_MS],
  ["remote.tunnel_provision_failed", HOST_STATE_REPORT_INTERVAL_MS],
  ["remote.connector_exited", HOST_STATE_REPORT_INTERVAL_MS],
]);

/** Local IPC only. The desktop owns consent, persistence and network delivery. */
export function reportReliabilityIssue(code: ReliabilityCode): void {
  try {
    if (!Schema.is(ReliabilityInput)({ code }) || !process.connected || !process.send) return;
    const interval = REPORT_INTERVAL_MS.get(code);
    if (interval !== undefined) {
      const now = performance.now();
      const previous = lastReport.get(code);
      if (previous !== undefined && now - previous < interval) return;
      lastReport.set(code, now);
    }
    process.send({ type: "synara:reliability", issue: { code } }, () => {
      // A retiring parent must never turn reporting into an uncaught IPC error.
    });
  } catch {
    // Headless servers and a closed desktop keep ordinary local logging.
  }
}
