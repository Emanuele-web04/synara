// FILE: fontFamily.ts
// Purpose: Convert user-entered font family names into valid CSS font-family values.
// Layer: Web appearance utilities
// Exports: normalizeFontFamilyCssValue

const CSS_WIDE_KEYWORDS = new Set(["inherit", "initial", "revert", "revert-layer", "unset"]);

const GENERIC_FONT_FAMILIES = new Set([
  "cursive",
  "emoji",
  "fangsong",
  "fantasy",
  "math",
  "monospace",
  "sans-serif",
  "serif",
  "system-ui",
  "ui-monospace",
  "ui-rounded",
  "ui-sans-serif",
  "ui-serif",
]);

function splitFontFamilyList(value: string): string[] {
  const families: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let parenDepth = 0;

  for (const character of value) {
    if (quote) {
      current += character;
      if (character === quote) {
        quote = null;
      }
      continue;
    }

    if (character === '"' || character === "'") {
      quote = character;
      current += character;
      continue;
    }

    if (character === "(") {
      parenDepth += 1;
      current += character;
      continue;
    }

    if (character === ")") {
      parenDepth = Math.max(0, parenDepth - 1);
      current += character;
      continue;
    }

    if (character === "," && parenDepth === 0) {
      families.push(current.trim());
      current = "";
      continue;
    }

    current += character;
  }

  families.push(current.trim());
  return families.filter((family) => family.length > 0);
}

function quoteFontFamily(family: string): string {
  return `"${family.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function normalizeSingleFontFamily(family: string): string {
  const trimmedFamily = family.trim();
  const lowerFamily = trimmedFamily.toLowerCase();

  if (
    trimmedFamily.startsWith('"') ||
    trimmedFamily.startsWith("'") ||
    trimmedFamily.includes("(") ||
    CSS_WIDE_KEYWORDS.has(lowerFamily) ||
    GENERIC_FONT_FAMILIES.has(lowerFamily)
  ) {
    return trimmedFamily;
  }

  return /\s/.test(trimmedFamily) ? quoteFontFamily(trimmedFamily) : trimmedFamily;
}

export function normalizeFontFamilyCssValue(value: string | null | undefined): string | null {
  const trimmedValue = value?.trim() ?? "";
  if (trimmedValue.length === 0) {
    return null;
  }

  return splitFontFamilyList(trimmedValue).map(normalizeSingleFontFamily).join(", ");
}
