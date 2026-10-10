import type { ComputerBrowserToolName } from "@synara/contracts";

import type { ComputerBrowserCallResult } from "../computer/ComputerBackend.ts";
import type { ComputerAuditEffect } from "../computer/computerAuditLog.ts";

interface BrowserEffectProof {
  readonly effect: ComputerAuditEffect;
  readonly code?: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Classify only evidence produced by the pinned driver's implementation.
 * A dispatch acknowledgement, character count or changed page is not proof.
 * The closed ActionResult used by click/type/pointer has no legacy status or
 * refusal code; its refusal still needs to survive in the audit history.
 */
export function computerBrowserEffect(
  name: ComputerBrowserToolName,
  args: Record<string, unknown>,
  result: ComputerBrowserCallResult,
): BrowserEffectProof {
  const structured = record(result.structuredContent);
  const refusal = record(structured?.refusal);
  const detail = record(refusal?.detail);
  if (
    structured?.effect === "partial" ||
    (structured?.status === "refused" &&
      refusal?.code === "browser_input_incomplete" &&
      typeof detail?.delivered_chars === "number" &&
      detail.delivered_chars > 0)
  ) {
    // Older driver replies put a delivered prefix inside a refusal. Some
    // input already ran, so this is not a pre-dispatch rejection.
    return { effect: "dispatched-unknown" };
  }
  if (structured?.status === "refused" || structured?.effect === "refused") {
    return {
      effect: "refused",
      code:
        typeof refusal?.code === "string"
          ? refusal.code
          : typeof structured.code === "string"
            ? structured.code
            : "browser_refused",
    };
  }
  if (result.isError === true) {
    return {
      effect: "error",
      code: typeof structured?.error === "string" ? structured.error : "browser_error",
    };
  }
  if (
    name === "computer_browser_download" &&
    structured?.status === "completed" &&
    typeof structured.download_id === "string" &&
    structured.download_id.length > 0 &&
    typeof structured.bytes === "number" &&
    Number.isSafeInteger(structured.bytes) &&
    structured.bytes >= 0
  ) {
    // The driver waits for the matching download-completed event, then proves
    // a canonical regular file exists directly inside the approved directory.
    return { effect: "verified" };
  }
  const verification = record(structured?.verification);
  if (
    name === "computer_browser_navigate" &&
    structured?.status === "ok" &&
    typeof args.target_id === "string" &&
    structured.target_id === args.target_id &&
    typeof args.tab_id === "string" &&
    structured.tab_id === args.tab_id &&
    typeof args.url === "string" &&
    structured.url === args.url &&
    verification?.scope === "navigation" &&
    verification.method === "page_frame_tree" &&
    verification.status === "confirmed"
  ) {
    // One bounded native read compares the committed frame, document loader
    // and destination. Redirects, old documents and unavailable reads stay
    // unknown; this proves the destination, never the page's business result.
    return { effect: "verified" };
  }
  // Even value_readback on DOM typing proves only the field content. It does
  // not prove a search, form submission or application-level acceptance.
  return { effect: "dispatched-unknown" };
}

/** Keep field evidence useful without presenting it as application success. */
export function computerBrowserFieldReadback(
  name: ComputerBrowserToolName,
  args: Record<string, unknown>,
  result: ComputerBrowserCallResult,
): boolean {
  const structured = record(result.structuredContent);
  return (
    name === "computer_browser_type" &&
    typeof args.text === "string" &&
    (args.mode === undefined || args.mode === "insert_text") &&
    args.replace === true &&
    args.input_route === "dom_event" &&
    result.isError !== true &&
    structured?.effect === "unverifiable" &&
    structured.route === "dom" &&
    Array.isArray(structured.evidence) &&
    structured.evidence.some((item) => record(item)?.kind === "value_readback")
  );
}
