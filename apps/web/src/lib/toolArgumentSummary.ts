// FILE: toolArgumentSummary.ts
// Purpose: Single source of truth for the provider `ToolName: {json}` tool argument-summary wire format.
// Layer: UI utility
// Exports: isPrefixedToolArgumentSummary, parseToolArgumentSummary, extractToolArgumentField, toolArgumentSummaryToolName

// Providers report dynamic/MCP tool calls with a detail string of the form
// `ToolName: {jsonArgs}` (Claude), `ToolName {jsonArgs}` (some ACP agents), or
// bare `{jsonArgs}`. Every consumer of that format — raw-preview suppression,
// web-fetch URL extraction, file-path extraction — goes through this module so
// the format is recognized identically everywhere.

const PREFIXED_SUMMARY_PATTERN = /^[\w.-]+:\s*[{[]/;

// Whether the detail is a `ToolName: {json}` / `ToolName: [json]` argument
// summary — transport detail rather than a human-readable summary.
export function isPrefixedToolArgumentSummary(detail: string): boolean {
  return PREFIXED_SUMMARY_PATTERN.test(detail.trim());
}

// Lenient tool-name extraction from a `ToolName: ...` prefix, for callers that
// only need the tool identity and don't care whether JSON args follow (e.g.
// recognizing `ExitPlanMode:` plan-boundary details).
export function toolArgumentSummaryToolName(detail: string): string | null {
  return /^([\w.-]+):/.exec(detail.trim())?.[1] ?? null;
}

export interface ToolArgumentSummary {
  // Identifier prefix before the JSON args; null for bare `{json}` details or
  // prose prefixes (e.g. `Read {json}` without a colon keeps toolName null).
  readonly toolName: string | null;
  // Parsed top-level args, or null when the JSON slice doesn't parse.
  readonly args: Record<string, unknown> | null;
}

// Decomposes an argument summary around its outermost `{...}` slice. Returns
// null when the detail carries no JSON-like object at all.
export function parseToolArgumentSummary(detail: string): ToolArgumentSummary | null {
  const trimmed = detail.trim();
  const jsonStart = trimmed.indexOf("{");
  if (jsonStart < 0) {
    return null;
  }
  const jsonEnd = trimmed.lastIndexOf("}");
  if (jsonEnd <= jsonStart) {
    return null;
  }
  const toolName = /^([\w.-]+):$/.exec(trimmed.slice(0, jsonStart).trim())?.[1] ?? null;
  let args: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(trimmed.slice(jsonStart, jsonEnd + 1));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      args = parsed as Record<string, unknown>;
    }
  } catch {
    // Truncated or malformed JSON — callers fall back to regex extraction.
  }
  return { toolName, args };
}

export interface ExtractToolArgumentFieldOptions {
  // Controls the regex fallback that scans the raw detail when the parsed
  // top-level args don't yield a match. "always" (default) also scans nested
  // fields of successfully parsed args — right for URLs, where a nested
  // `"url"` is still the fetch target. "whenUnparsed" only scans when the
  // JSON failed to parse (truncated stream), so a parsed object without a
  // matching top-level key returns null — right for generic keys like
  // `"path"`, where a nested match may not represent the tool's subject.
  readonly fallbackScan?: "always" | "whenUnparsed";
}

// Pulls the first non-empty string field matching one of `keys` out of an
// argument summary. Prefers the parsed top-level args; falls back to a regex
// scan per `fallbackScan` so truncated JSON (and, by default, nested fields)
// still resolve.
export function extractToolArgumentField(
  detail: string,
  keys: ReadonlyArray<string>,
  options?: ExtractToolArgumentFieldOptions,
): string | null {
  const summary = parseToolArgumentSummary(detail);
  if (!summary) {
    return null;
  }
  if (summary.args) {
    for (const key of keys) {
      const value = summary.args[key];
      if (typeof value === "string" && value.trim().length > 0) {
        return value.trim();
      }
    }
    if (options?.fallbackScan === "whenUnparsed") {
      return null;
    }
  }
  const escapedKeys = keys.map((key) => key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const fieldPattern = new RegExp(`"(?:${escapedKeys.join("|")})"\\s*:\\s*"([^"]+)"`, "i");
  const fallback = fieldPattern.exec(detail)?.[1]?.trim();
  return fallback && fallback.length > 0 ? fallback : null;
}
