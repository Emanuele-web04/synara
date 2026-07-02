// FILE: toolCallDetailsFormatting.ts
// Purpose: Format captured tool-call commands and output for transcript detail views.
// Layer: Web transcript presentation utility
// Exports: formatShellCommand, formatShellTranscript, formatToolOutputText,
//          createMarkdownCodeFence
// Depends on: WorkLogToolOutputDetails shape from toolCallDetails

import type { WorkLogToolOutputDetails } from "./toolCallDetails";

export function formatShellCommand(command: string): string {
  return command
    .split(/\r?\n/)
    .map((line, index) => (index === 0 ? `$ ${line}` : line))
    .join("\n");
}

export function formatShellTranscript(
  command: string,
  output: WorkLogToolOutputDetails | undefined,
): string {
  const outputText = formatToolOutputText(output);
  return outputText
    ? `${formatShellCommand(command)}\n\n${outputText}`
    : formatShellCommand(command);
}

export function formatToolOutputText(output: WorkLogToolOutputDetails | undefined): string | null {
  if (!output) {
    return null;
  }
  const parts = [output.output, output.stdout, output.stderr]
    .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
    .map((part) => part.trimEnd());
  return parts.length > 0 ? parts.join("\n\n") : null;
}

export function createMarkdownCodeFence(language: string, code: string): string {
  const longestBacktickRun = Math.max(
    0,
    ...Array.from(code.matchAll(/`+/g), (match) => match[0].length),
  );
  const fence = "`".repeat(Math.max(3, longestBacktickRun + 1));
  return `${fence}${language}\n${code}\n${fence}`;
}
