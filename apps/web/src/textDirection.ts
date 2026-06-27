export type ResolvedTextDirection = "ltr" | "rtl";
export type TextDirectionAttribute = ResolvedTextDirection | "auto";

const LETTER_PATTERN = /\p{Letter}/u;

const RTL_CODE_POINT_RANGES: readonly (readonly [number, number])[] = [
  [0x0590, 0x08ff],
  [0xfb1d, 0xfdff],
  [0xfe70, 0xfeff],
  [0x10800, 0x10fff],
  [0x1e800, 0x1eeff],
];

function isRtlCodePoint(codePoint: number): boolean {
  return RTL_CODE_POINT_RANGES.some(([start, end]) => codePoint >= start && codePoint <= end);
}

export function resolveTextDirectionForContent(
  text: string,
  fallback: ResolvedTextDirection = "ltr",
): ResolvedTextDirection {
  for (const character of text) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) {
      continue;
    }
    if (isRtlCodePoint(codePoint)) {
      return "rtl";
    }
    if (LETTER_PATTERN.test(character)) {
      return "ltr";
    }
  }
  return fallback;
}
