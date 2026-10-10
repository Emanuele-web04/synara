// providers report dynamic/MCP calls as `ToolName: {json}` (Claude), `ToolName {json}` (some ACP), or bare `{json}` — every consumer goes through here so the format is recognized identically everywhere

const PREFIXED_SUMMARY_PATTERN = /^[\w.-]+:\s*[{[]/;

export function isPrefixedToolArgumentSummary(detail: string): boolean {
  return PREFIXED_SUMMARY_PATTERN.test(detail.trim());
}

export function toolArgumentSummaryToolName(detail: string): string | null {
  return /^([\w.-]+):/.exec(detail.trim())?.[1] ?? null;
}

export interface ToolArgumentSummary {
  readonly toolName: string | null;
  readonly args: Record<string, unknown> | null;
}

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
  // "always" also scans nested fields of parsed args — right for URLs where a nested "url" is the fetch target; "whenUnparsed" only scans on parse failure so a parsed object without the key returns null — right for "path" where a nested match may not be the subject
  readonly fallbackScan?: "always" | "whenUnparsed";
}

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
