/**
 * DevinModelSlugParser - extracts base family from Devin model slugs.
 *
 * Devin ACP returns ~105 flat model slugs. Each slug encodes a base model
 * family plus variant dimensions (effort, fast mode, context window, thinking)
 * in the slug string itself. This parser collapses variants into a common
 * base family so the model picker can group them.
 *
 * Grouping only — does NOT populate variant capability fields. Devin slugs are
 * fixed configurations, not runtime-toggleable variants.
 *
 * @module DevinModelSlugParser
 */

const MODE_VALUES = new Set(["accept-edits", "ask", "bypass", "plan"]);

const SLUG_VARIANT_TOKENS = new Set([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "none",
  "minimal",
  "slow",
  "fast",
  "priority",
  "thinking",
  "1m",
]);

const EFFORT_TOKENS = new Set(["low", "medium", "high", "xhigh", "max", "none", "minimal", "slow"]);

const FAST_TOKENS = new Set(["fast", "priority"]);

const DISPLAY_VARIANT_WORDS = new Set([
  "fast",
  "low",
  "medium",
  "high",
  "xhigh",
  "x-high",
  "max",
  "none",
  "minimal",
  "slow",
  "thinking",
  "1m",
]);

export interface ParsedDevinSlug {
  readonly baseSlug: string;
  readonly baseName: string;
  readonly effort: string | null;
  readonly fast: boolean;
  readonly thinking: boolean;
  readonly contextWindow: string | null;
}

function titleCaseWord(word: string): string {
  // ponytail: ≤3-char heuristic preserves acronyms (GPT, SWE, GLM) while title-casing
  // longer words (Claude, Opus). Upgrade to an explicit acronym set if a long acronym
  // (e.g. LLAMA) appears in a legacy MODEL_* slug and gets wrongly title-cased.
  if (word.length <= 3) return word.toUpperCase();
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

function formatBaseSlug(baseSlug: string): string {
  const isModelPrefix = baseSlug.startsWith("MODEL_");
  const stripped = isModelPrefix ? baseSlug.slice("MODEL_".length) : baseSlug;
  const sep = isModelPrefix ? "_" : "-";
  const parts = stripped.split(sep).filter((p) => p.length > 0);
  const formatted: string[] = [];
  let numericRun: string[] = [];
  const flushNumeric = () => {
    if (numericRun.length > 0) {
      formatted.push(numericRun.join("."));
      numericRun = [];
    }
  };
  for (const part of parts) {
    if (/^\d+$/.test(part)) {
      numericRun.push(part);
    } else {
      flushNumeric();
      formatted.push(titleCaseWord(part));
    }
  }
  flushNumeric();
  return formatted.join(" ");
}

export function parseDevinModelSlug(slug: string, displayName: string): ParsedDevinSlug | null {
  const trimmedSlug = slug.trim();
  if (!trimmedSlug) return null;
  if (MODE_VALUES.has(trimmedSlug)) return null;

  const isModelPrefix = trimmedSlug.startsWith("MODEL_");
  const sep = isModelPrefix ? "_" : "-";

  // Strip variant suffixes from the right to get baseSlug (guard: keep >= 1 part).
  // Capture what was stripped into variant dimensions (first occurrence wins).
  const parts = trimmedSlug.split(sep);
  let effort: string | null = null;
  let fast = false;
  let thinking = false;
  let contextWindow: string | null = null;
  while (parts.length > 1) {
    const last = parts[parts.length - 1];
    if (!last || !SLUG_VARIANT_TOKENS.has(last.toLowerCase())) break;
    const token = last.toLowerCase();
    if (EFFORT_TOKENS.has(token) && effort === null) {
      effort = token;
    } else if (FAST_TOKENS.has(token) && !fast) {
      fast = true;
    } else if (token === "thinking" && !thinking) {
      thinking = true;
    } else if (token === "1m" && contextWindow === null) {
      contextWindow = "1m";
    }
    parts.pop();
  }
  const baseSlug = parts.join(sep);

  // Strip variant words from the right of the display name to get baseName.
  const trimmedName = displayName.trim();
  let baseName: string | undefined;
  if (trimmedName) {
    const tokens = trimmedName.split(/\s+/);
    while (tokens.length > 0) {
      const last = tokens[tokens.length - 1];
      if (!last || !DISPLAY_VARIANT_WORDS.has(last.toLowerCase())) break;
      tokens.pop();
    }
    const stripped = tokens.join(" ").trim();
    if (stripped && stripped !== trimmedSlug) {
      baseName = stripped;
    }
  }

  if (!baseName) {
    baseName = formatBaseSlug(baseSlug);
  }

  return { baseSlug, baseName, effort, fast, thinking, contextWindow };
}
