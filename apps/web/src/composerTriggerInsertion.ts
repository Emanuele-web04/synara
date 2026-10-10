// swallow an existing space at rangeEnd so a chip replacement never produces two spaces
export function extendReplacementRangeForTrailingSpace(
  text: string,
  rangeEnd: number,
  replacement: string,
): number {
  if (!replacement.endsWith(" ")) {
    return rangeEnd;
  }
  return text[rangeEnd] === " " ? rangeEnd + 1 : rangeEnd;
}

// guarantee a whitespace separator between adjacent chips — the parser requires it; an empty replacement is a pure clear so never prepend a stray space
export function ensureLeadingSpaceForReplacement(
  text: string,
  rangeStart: number,
  replacement: string,
): string {
  if (replacement.length === 0) return replacement;
  if (rangeStart === 0) return replacement;
  const precedingChar = text[rangeStart - 1];
  if (!precedingChar || /\s/.test(precedingChar)) return replacement;
  return ` ${replacement}`;
}
