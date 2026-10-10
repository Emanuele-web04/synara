import { DESKTOP_DIAGNOSTIC_ISSUE_PREFIX, DesktopDiagnosticIssue } from "@synara/contracts";
import { Schema } from "effect";
import { SERVER_DESKTOP_FLAVOR } from "./betaFeatureGate";

/** The owning Beta desktop relays fixed issue fields through its existing queue. */
export function reportBetaOperationalIssue(issue: DesktopDiagnosticIssue): void {
  if (SERVER_DESKTOP_FLAVOR !== "beta") return;
  try {
    if (!Schema.is(DesktopDiagnosticIssue)(issue)) return;
    const safe = {
      code: issue.code,
      ...(issue.reason ? { reason: issue.reason } : {}),
      ...(issue.durationMs !== undefined &&
      Number.isFinite(issue.durationMs) &&
      issue.durationMs >= 0
        ? { durationMs: Math.min(Math.round(issue.durationMs), 604_800_000) }
        : {}),
    };
    process.stdout.write(`${DESKTOP_DIAGNOSTIC_ISSUE_PREFIX}${JSON.stringify(safe)}\n`);
  } catch {
    /* Telemetry cannot change a command's result. */
  }
}
