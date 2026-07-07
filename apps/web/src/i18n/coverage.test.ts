// FILE: coverage.test.ts
// Purpose: Verifies that en.json and zh-CN.json are in sync — every key present
//   in English has a corresponding key in Chinese, and interpolation variables match.
// Layer: Web i18n coverage
// Depends on: Vitest, locale JSON files

import { describe, expect, it } from "vitest";
import en from "./locales/en.json";
import zhCN from "./locales/zh-CN.json";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type NestedDict = Record<string, any>;

/**
 * Flatten a nested JSON object into dot-separated keys.
 * e.g. { a: { b: "c" } } → { "a.b": "c" }
 */
function flattenKeys(obj: NestedDict, prefix = ""): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") {
      result[fullKey] = value;
    } else if (value !== null && typeof value === "object") {
      Object.assign(result, flattenKeys(value, fullKey));
    }
  }
  return result;
}

/**
 * Extract interpolation variable names from a string (i18next {{...}} syntax).
 * Handles standard {{var}} and extended {{count, plural, one {x} other {y}}} formats.
 */
function extractInterpolations(str: string): string[] {
  const matches = str.match(/\{\{(.+?)\}\}/g);
  if (!matches) return [];
  return matches
    .map((m) => {
      const inner = m.slice(2, -2).trim();
      // For extended i18next format like "count, plural, one {x} other {y}",
      // extract just the variable name (before the first comma or space).
      const varName = inner.split(/[, ]/)[0];
      return varName ?? inner;
    })
    .sort();
}

/**
 * Recursively collect all top-level section names from a locale file.
 */
function getTopLevelSections(obj: Record<string, unknown>): string[] {
  return Object.keys(obj).filter((key) => {
    const val = obj[key];
    return typeof val === "object" && val !== null && !Array.isArray(val);
  });
}

describe("i18n locale coverage", () => {
  const enFlat = flattenKeys(en as NestedDict);
  const zhFlat = flattenKeys(zhCN as NestedDict);
  const enKeys = Object.keys(enFlat).sort();
  const zhKeys = Object.keys(zhFlat).sort();

  it("en.json and zh-CN.json have the same number of top-level sections", () => {
    const enSections = getTopLevelSections(en as Record<string, unknown>);
    const zhSections = getTopLevelSections(zhCN as Record<string, unknown>);
    expect(enSections.sort()).toEqual(zhSections.sort());
  });

  it("every key in en.json exists in zh-CN.json", () => {
    const enOnly = enKeys.filter((k) => !zhKeys.includes(k));
    expect(enOnly).toEqual([]);
  });

  it("every key in zh-CN.json exists in en.json (no orphaned keys)", () => {
    const zhOnly = zhKeys.filter((k) => !enKeys.includes(k));
    expect(zhOnly).toEqual([]);
  });

  it("interpolation variables match between en and zh-CN for every key", () => {
    const mismatches: string[] = [];
    for (const key of enKeys) {
      const enVars = extractInterpolations(enFlat[key] ?? "");
      const zhVars = extractInterpolations(zhFlat[key] ?? "");
      if (JSON.stringify(enVars) !== JSON.stringify(zhVars)) {
        mismatches.push(`${key}: en={${enVars.join(", ")}} zh-CN={${zhVars.join(", ")}}`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it("has roughly the same total key count between locales", () => {
    // Exclude _meta section which has locale-specific metadata
    const enKeysFiltered = enKeys.filter((k) => !k.startsWith("_meta."));
    const zhKeysFiltered = zhKeys.filter((k) => !k.startsWith("_meta."));
    const diff = Math.abs(enKeysFiltered.length - zhKeysFiltered.length);
    // Allow a small tolerance for work-in-progress translations
    expect(diff).toBeLessThanOrEqual(10);
  });

  it("all interpolation values in en.json use the standard {{var}} syntax", () => {
    const badPatterns: string[] = [];
    for (const [key, value] of Object.entries(enFlat)) {
      if (/_plural$/.test(key)) continue; // i18next plural keys can use # shortcut
      // Check for unbalanced braces or non-standard syntax
      const openCount = (value.match(/\{\{/g) ?? []).length;
      const closeCount = (value.match(/\}\}/g) ?? []).length;
      if (openCount !== closeCount) {
        badPatterns.push(`${key}: unbalanced {{ }} braces`);
      }
    }
    expect(badPatterns).toEqual([]);
  });
});
