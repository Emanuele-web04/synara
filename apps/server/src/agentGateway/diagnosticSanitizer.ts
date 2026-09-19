import { redactSensitiveProcessArgs } from "../processArgumentRedaction.ts";

const SENSITIVE_KEY = /(?:authorization|cookie|credential|password|secret|token|api[-_]?key)/i;
const MAX_STRING_CHARS = 4_000;
const MAX_ARRAY_ITEMS = 50;
const MAX_OBJECT_KEYS = 50;
/**
 * Tool payloads nest deeper than ordinary diagnostics: a projected activity
 * carries `data.rawOutput.details.structuredContent` before the driver's own
 * result begins (browser bind results put the `tabs` inventory one level
 * below that). At the former 5 the packaged E2E's own `synara_read_thread_*`
 * reads returned `"[depth limit]"` for exactly the tab list the model needed
 * to recover its target/tab ids. 12 clears every projected tool envelope with
 * room to spare; the item/key/string caps still bound the output, and secret
 * redaction runs at every level.
 */
const MAX_DEPTH = 12;

function redactSensitiveDiagnosticString(value: string): string {
  return redactSensitiveProcessArgs(value)
    .replace(
      /\b((?:authorization|proxy-authorization)\s*:\s*)(?:(?:basic|bearer)\s+)?[^\s,;]+/giu,
      "$1[redacted]",
    )
    .replace(
      /([?&](?:access[-_]?token|api[-_]?key|auth|authorization|cookie|credential|password|secret|token)=)[^&#\s]*/giu,
      "$1[redacted]",
    )
    .replace(
      /\b((?:access[-_]?token|api[-_]?key|auth|authorization|cookie|credential|password|secret|token)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&]+)/giu,
      "$1[redacted]",
    );
}

export function sanitizeDiagnosticValue(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") {
    const redacted = redactSensitiveDiagnosticString(value);
    return redacted.length <= MAX_STRING_CHARS
      ? redacted
      : `${redacted.slice(0, MAX_STRING_CHARS)}… [truncated ${redacted.length - MAX_STRING_CHARS} chars]`;
  }
  if (depth >= MAX_DEPTH) return "[depth limit]";
  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_ARRAY_ITEMS)
      .map((entry) => sanitizeDiagnosticValue(entry, depth + 1));
  }
  if (typeof value !== "object") return String(value);
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .slice(0, MAX_OBJECT_KEYS)
      .map(([key, entry]) => [
        key,
        SENSITIVE_KEY.test(key) ? "[redacted]" : sanitizeDiagnosticValue(entry, depth + 1),
      ]),
  );
}
