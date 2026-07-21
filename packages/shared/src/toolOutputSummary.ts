// FILE: toolOutputSummary.ts
// Purpose: Produces compact display summaries from provider tool rawOutput payloads.
// Layer: Shared runtime utility
// Exports: summarizeToolRawOutput, countTextLines

import { pluralize } from "./text";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstTextLine(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const firstLine = value.trim().split(/\r?\n/, 1)[0]?.trim();
  return firstLine || undefined;
}

export function countTextLines(content: string): number {
  if (content.length === 0) {
    return 0;
  }
  return content.replace(/\r?\n$/, "").split(/\r?\n/).length;
}

export function summarizeToolRawOutput(rawOutput: unknown): string | undefined {
  if (!isRecord(rawOutput)) {
    return undefined;
  }
  const isError =
    rawOutput.isError === true ||
    rawOutput.is_error === true ||
    rawOutput.is_error === 1 ||
    rawOutput.is_error === "true";
  if (isError) {
    const output = isRecord(rawOutput.output) ? rawOutput.output : null;
    const errorSummary = firstTextLine(
      output?.Error ?? output?.error ?? rawOutput.error ?? rawOutput.message,
    );
    if (errorSummary) return errorSummary;
  }
  const totalFiles = rawOutput.totalFiles;
  if (typeof totalFiles === "number" && Number.isInteger(totalFiles) && totalFiles >= 0) {
    const suffix = rawOutput.truncated === true ? " (truncated)" : "";
    return `${totalFiles} ${pluralize(totalFiles, "file")} found${suffix}`;
  }
  if (typeof rawOutput.content === "string") {
    const lineCount = countTextLines(rawOutput.content);
    return `Read ${lineCount} ${pluralize(lineCount, "line")}`;
  }
  return firstTextLine(rawOutput.stdout);
}
