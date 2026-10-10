import type { DesktopDiagnosticIssue } from "@synara/contracts";

/** Classify locally; the original exception never crosses the issue bridge. */
export function diagnosticIssueReason(error: unknown): DesktopDiagnosticIssue["reason"] {
  try {
    const message = typeof error === "string" ? error : error instanceof Error ? error.message : "";
    if (
      /unauthorized|authentication|auth.*expired|session expired|\bsign[ -]?in\b|\b401\b/i.test(
        message,
      )
    )
      return "auth";
    if (/json|invalid.*(?:response|transcript)|unexpected token/i.test(message))
      return "invalid-response";
    if (/output.*(?:limit|exceed)|maxBuffer|buffer.*exceed/i.test(message)) return "output-limit";
    if (/timed?\s*out|timeout/i.test(message)) return "timeout";
  } catch {
    /* Error getters may be hostile. */
  }
  return "unknown";
}
