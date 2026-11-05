// FILE: modelName.ts
// Purpose: Turns raw model slugs and provider labels into Synara's canonical display names
// ("gpt-6-astra" → "GPT-6 Astra", "claude-opus-4-8" → "Claude Opus 4.8"). Dependency-free so
// surfaces that avoid the contracts package (the public profile app) share the exact same
// naming as the desktop; model.ts layers the built-in catalog names on top.
// Layer: Shared domain helpers (no I/O)

const MODEL_TOKEN_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  deepseek: "DeepSeek",
  glm: "GLM",
  gpt: "GPT",
  minimax: "MiniMax",
  openai: "OpenAI",
  opencode: "OpenCode",
  swe: "SWE",
  xai: "xAI",
  xhigh: "XHigh",
};

// First tokens that mark a provider-supplied label as a model-family name
// worth normalizing: the brand tokens plus families whose casing is already
// title-case. Anything else (custom names like "MyModel", "K2P6") keeps its
// original casing untouched.
const MODEL_FAMILY_TOKENS: ReadonlySet<string> = new Set([
  ...Object.keys(MODEL_TOKEN_DISPLAY_NAMES),
  "adaptive",
  "auto",
  "claude",
  "codex",
  "composer",
  "cursor",
  "devin",
  "gemini",
  "grok",
  "inkling",
  "kimi",
  "nemotron",
]);

function humanizeModelToken(token: string): string {
  const key = token.toLowerCase();
  const displayName = Object.prototype.hasOwnProperty.call(MODEL_TOKEN_DISPLAY_NAMES, key)
    ? MODEL_TOKEN_DISPLAY_NAMES[key]
    : undefined;
  return displayName ?? token.charAt(0).toUpperCase() + token.slice(1);
}

const MODEL_DATE_OR_BUILD_TOKEN_PATTERN = /^\d{8}$/u;

// Rejoins version fragments split on "-"/"_": a pure-digit token merges onto a
// preceding token that already ends in a digit, so "swe-1-6" reads as 1.6,
// "claude-opus-4-8" as 4.8, and "kimi-k2-6" as K2.6. Zero-prefixed tokens and
// eight-digit provider date/build stamps stay separate, never version minors.
function joinModelVersionTokens(tokens: string[]): string[] {
  const merged: string[] = [];
  for (const token of tokens) {
    const previous = merged[merged.length - 1];
    if (
      /^\d+$/u.test(token) &&
      (token === "0" || !token.startsWith("0")) &&
      !MODEL_DATE_OR_BUILD_TOKEN_PATTERN.test(token) &&
      previous !== undefined &&
      /\d$/u.test(previous)
    ) {
      merged[merged.length - 1] = `${previous}.${token}`;
    } else {
      merged.push(token);
    }
  }
  return merged;
}

// Canonical brand shapes that differ from plain space-joined words.
function restoreModelNameSeparators(name: string): string {
  return name.replace(/\bGPT (\d)/gu, "GPT-$1");
}

// Turns a raw model slug into a readable label when no built-in name exists.
// Provider-scoped custom ids ("vendor/model") stay verbatim; everything else is
// tokenized on -/_, version fragments rejoined with ".", known model-family
// brands restored to their canonical casing, and GPT versions rehyphenated.
export function humanizeModelSlug(slug: string): string {
  if (slug.includes("/")) {
    return slug;
  }
  const tokens = joinModelVersionTokens(slug.split(/[-_]+/g)).map(humanizeModelToken);
  return restoreModelNameSeparators(tokens.join(" "));
}

/**
 * Normalizes a provider-supplied display name to Synara's canonical casing:
 * known brand tokens are re-cased ("Swe" → "SWE", "Deepseek" → "DeepSeek"),
 * slug separators become spaces ("GLM-5.3-Flash" → "GLM 5.3 Flash"), digit
 * fragments rejoin as versions, and GPT versions keep their hyphen. Gated on a
 * known family first token so freeform names keep their casing; non-brand
 * tokens and a parenthesized tail pass through unchanged.
 */
export function normalizeModelDisplayName(name: string): string {
  const trimmed = name.trim();
  const parenIndex = trimmed.indexOf("(");
  const head = parenIndex >= 0 ? trimmed.slice(0, parenIndex).trimEnd() : trimmed;
  const tail = parenIndex >= 0 ? trimmed.slice(parenIndex) : "";
  const tokens = head.split(/[-_\s]+/u).filter(Boolean);
  const [firstToken] = tokens;
  if (firstToken === undefined || !MODEL_FAMILY_TOKENS.has(firstToken.toLowerCase())) {
    return trimmed;
  }
  const normalized = joinModelVersionTokens(tokens)
    .map((token) => {
      const displayName = Object.prototype.hasOwnProperty.call(
        MODEL_TOKEN_DISPLAY_NAMES,
        token.toLowerCase(),
      )
        ? MODEL_TOKEN_DISPLAY_NAMES[token.toLowerCase()]
        : undefined;
      return displayName ?? token;
    })
    .join(" ");
  return `${restoreModelNameSeparators(normalized)}${tail ? ` ${tail}` : ""}`;
}
