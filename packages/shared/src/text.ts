// workspace buffers use LF — retain the on-disk format metadata when used for editing/comparison
export function normalizeLineEndings(contents: string): string {
  return contents.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

// JS string lengths count UTF-16 code units — bounded text must account for the surrogate boundary explicitly
export function splitsSurrogatePair(text: string, offsetChars: number): boolean {
  if (offsetChars <= 0 || offsetChars >= text.length) return false;
  const previousCodeUnit = text.charCodeAt(offsetChars - 1);
  const nextCodeUnit = text.charCodeAt(offsetChars);
  return (
    previousCodeUnit >= 0xd800 &&
    previousCodeUnit <= 0xdbff &&
    nextCodeUnit >= 0xdc00 &&
    nextCodeUnit <= 0xdfff
  );
}

// keep a prefix within its UTF-16 budget without leaving an unpaired high surrogate — at most one code unit removed
export function unicodeSafeEndOffset(text: string, requestedEndOffsetChars: number): number {
  return splitsSurrogatePair(text, requestedEndOffsetChars)
    ? requestedEndOffsetChars - 1
    : requestedEndOffsetChars;
}

// `??` only falls back on null/undefined — a blank string slips through every fallback chain and a TrimmedNonEmptyString boundary rejects it at decode
export function nonEmptyTrimmed(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

// removes real terminal control sequences while preserving ordinary brackets and hyperlink labels
export function stripTerminalControlSequences(value: string): string {
  return value
    .replace(/(?:\u001B\[|\u009B)[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/(?:\u001B\]|\u009D)[^\u0007\u001B\u009C]*(?:\u0007|\u001B\\|\u009C)/gu, "");
}

export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return count === 1 ? singular : plural;
}
