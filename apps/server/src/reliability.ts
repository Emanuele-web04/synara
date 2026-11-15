import { Schema } from "effect";
import { ReliabilityInput, type ReliabilityCode } from "@synara/contracts";

const lastSocketReport = new Map<ReliabilityCode, number>();
const SOCKET_REPORT_INTERVAL_MS = 30_000;

/** Local IPC only. The desktop owns consent, persistence and network delivery. */
export function reportReliabilityIssue(code: ReliabilityCode): void {
  try {
    if (!Schema.is(ReliabilityInput)({ code }) || !process.connected || !process.send) return;
    if (code === "remote.ingress_socket_error" || code === "remote.tunnel_socket_error") {
      // Unauthenticated connection churn must not flood desktop IPC or its
      // durable spool. Only these two peer-driven categories share this bound.
      const now = performance.now();
      const previous = lastSocketReport.get(code);
      if (previous !== undefined && now - previous < SOCKET_REPORT_INTERVAL_MS) return;
      lastSocketReport.set(code, now);
    }
    process.send({ type: "synara:reliability", issue: { code } }, () => {
      // A retiring parent must never turn reporting into an uncaught IPC error.
    });
  } catch {
    // Headless servers and a closed desktop keep ordinary local logging.
  }
}
