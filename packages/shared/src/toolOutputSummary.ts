// FILE: toolOutputSummary.ts
// Purpose: Produces compact display summaries from provider tool rawOutput payloads.
// Layer: Shared runtime utility
// Exports: summarizeToolRawOutput, countTextLines

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return count === 1 ? singular : plural;
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
  const totalFiles = rawOutput.totalFiles;
  if (typeof totalFiles === "number" && Number.isInteger(totalFiles) && totalFiles >= 0) {
    const suffix = rawOutput.truncated === true ? " (truncated)" : "";
    return `${totalFiles} ${pluralize(totalFiles, "file")} found${suffix}`;
  }
  if (typeof rawOutput.content === "string") {
    const lineCount = countTextLines(rawOutput.content);
    return `Read ${lineCount} ${pluralize(lineCount, "line")}`;
  }
  const stdout = typeof rawOutput.stdout === "string" ? rawOutput.stdout.trim() : "";
  return stdout ? (stdout.split(/\r?\n/, 1)[0]?.trim() ?? undefined) : undefined;
}
