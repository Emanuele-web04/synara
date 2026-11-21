/**
 * Picks the base direction of markdown prose from its dominant script.
 *
 * The browser primitive (`dir="auto"`) decides from the first strong character,
 * so a Persian paragraph that opens with a product name, a bold English label,
 * or a link label resolves LTR and the rest of the paragraph is laid out in
 * logical LTR order — upside down for an RTL reader. Technical Persian writing
 * opens paragraphs that way constantly, and whether the leading token is plain
 * text or an isolated `code` span changed the outcome, so the transcript flipped
 * block by block.
 *
 * Counting strong letters instead makes the decision about the whole block, not
 * its first word. The transcript applies it per block, because a bilingual reply
 * genuinely contains Persian and English paragraphs side by side; the message as
 * a whole gets the same treatment as the inherited default.
 *
 * Code, math, link targets, bare URLs, HTML tags, and image alt text never count:
 * they are either LTR by definition or metadata, not prose.
 */

export type MarkdownDirection = "rtl" | "ltr";

export interface StrongLetterCounts {
  readonly rtl: number;
  readonly ltr: number;
}

/** Hebrew, Arabic, Syriac, Thaana, NKo, and their presentation forms. */
const RTL_LETTER = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/u;
const LETTER = /\p{L}/u;

/** Counts strong letters without touching markup. Code and math are not here; callers skip them. */
export function countStrongLetters(text: string): StrongLetterCounts {
  let rtl = 0;
  let ltr = 0;

  for (const character of text) {
    if (!LETTER.test(character)) continue;
    if (RTL_LETTER.test(character)) rtl += 1;
    else ltr += 1;
  }

  return { rtl, ltr };
}

/**
 * Counts words by script. Letters alone overweight Latin identifiers: a Persian
 * sentence that mentions `src/app/layout.tsx`, `provider`, `useEffect`, and a few
 * more tokens can hold more Latin letters than Persian ones, yet it is still a
 * Persian sentence. Each whitespace-separated token counts once, whichever
 * script holds its letters, so identifiers stay one vote apiece.
 */
export function countStrongWords(text: string): StrongLetterCounts {
  let rtl = 0;
  let ltr = 0;

  for (const token of text.split(/\s+/)) {
    if (token.length === 0) continue;
    const counts = countStrongLetters(token);
    if (counts.rtl === 0 && counts.ltr === 0) continue;
    if (counts.rtl > counts.ltr) rtl += 1;
    else ltr += 1;
  }

  return { rtl, ltr };
}

/** `null` when the text holds no letters, so the caller can leave direction to inheritance. */
export function directionFromCounts(counts: StrongLetterCounts): MarkdownDirection | null {
  if (counts.rtl + counts.ltr === 0) return null;
  return counts.rtl > counts.ltr ? "rtl" : "ltr";
}

/**
 * Words decide first; a tie falls back to letters, so a two-word block with one
 * word per script still lands on the script that actually carries the text.
 */
export function scriptDirection(text: string): MarkdownDirection | null {
  const words = countStrongWords(text);
  if (words.rtl !== words.ltr) {
    return words.rtl > words.ltr ? "rtl" : "ltr";
  }
  return directionFromCounts(countStrongLetters(text));
}

function stripNonProse(text: string): string {
  const lines = text.split("\n");
  const prose: string[] = [];
  let openFence: string | null = null;

  for (const line of lines) {
    const fence = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (openFence) {
      // The closing fence repeats the marker character at least as many times.
      if (fence && fence[0] === openFence[0] && fence.length >= openFence.length) {
        openFence = null;
      }
      prose.push("");
      continue;
    }
    if (fence) {
      openFence = fence;
      prose.push("");
      continue;
    }
    prose.push(line);
  }

  return prose
    .join("\n")
    .replace(/`+[^`]*`+/g, " ")
    .replace(/\$\$[\s\S]*?\$\$/g, " ")
    .replace(/\$[^$\n]*\$/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\]\([^)]*\)/g, "]")
    .replace(/<https?:\/\/[^>]*>/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/<\/?[a-z][^>]*>/gi, " ");
}

/** `rtl` when the message holds more right-to-left words than other words. */
export function resolveMarkdownTextDirection(text: string): MarkdownDirection {
  return scriptDirection(stripNonProse(text)) ?? "ltr";
}
