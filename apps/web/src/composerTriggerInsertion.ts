// FILE: composerTriggerInsertion.ts
// Purpose: Pure helpers that normalise the text around a composer trigger replacement
//          so back-to-back chips stay separated and a trailing space is never doubled.
// Layer: Composer logic utilities (no DOM, no React)
// Exports: ensureLeadingSpaceForReplacement, extendReplacementRangeForTrailingSpace

// If the replacement ends with a trailing space and the character at `rangeEnd`
// is already a space, swallow it so the composer never ends up with two spaces
// after the chip.
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

// Guarantees a whitespace separator between chips when the trigger starts
// directly after a non-whitespace character (e.g. the user typed `@bar` right
// after an existing `@foo` chip). Without this, the two mentions render as
// plain text because the segment parser requires whitespace on both sides.
// An empty replacement is a pure clear, so we never prepend a stray space.
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
