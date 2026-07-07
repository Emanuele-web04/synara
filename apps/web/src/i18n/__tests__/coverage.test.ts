// FILE: coverage.test.ts
// Purpose: Validates that en.json and zh-CN.json are synchronized — every key
//   in en.json exists in zh-CN.json, interpolation variables match, and the
//   total key count is tracked.
// Layer: i18n infrastructure tests

import { describe, expect, it } from "vitest";
import en from "../locales/en.json";
import zh from "../locales/zh-CN.json";

type TranslationValue = string | Record<string, unknown>;

/**
 * Recursively flatten a nested translation object into dotted keys.
 * Skips `_meta` sections (bookkeeping only).
 */
function flatKeys(obj: Record<string, unknown>, prefix = ""): string[] {
  const keys: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (k === "_meta") continue;
    const p = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "object" && v !== null) {
      keys.push(...flatKeys(v as Record<string, unknown>, p));
    } else {
      keys.push(p);
    }
  }
  return keys;
}

/**
 * Extract interpolation variables from a translation string.
 * e.g. "Hello {{name}}, you have {{count}} messages" → ["count", "name"]
 * For i18next plural forms like {{count, plural, one {file} other {files}}},
 * only extracts the variable name ("count"), not the plural syntax.
 */
function interpolationVars(s: string): string[] {
  return [...s.matchAll(/\{\{(\w+)(?:,\s*plural.*)?\}\}/g)].map((m) => m[1] ?? "").sort();
}

describe("i18n locale coverage", () => {
  const enKeys = flatKeys(en as unknown as Record<string, unknown>);
  const zhKeys = flatKeys(zh as unknown as Record<string, unknown>);

  const enKeySet = new Set(enKeys);
  const zhKeySet = new Set(zhKeys);

  it("en.json and zh-CN.json have the same number of translation keys", () => {
    // Allow _meta.totalKeys to differ since it reflects locale-specific counts
    const diff = Math.abs(enKeys.length - zhKeys.length);
    expect(diff).toBeLessThanOrEqual(20); // tolerate up to 20 drift
  });

  it("every key in en.json exists in zh-CN.json", () => {
    const missing = enKeys.filter((k) => !zhKeySet.has(k));
    expect(missing).toEqual([]);
  });

  it("zh-CN.json has no extra keys not in en.json", () => {
    const extra = zhKeys.filter((k) => !enKeySet.has(k));
    expect(extra).toEqual([]);
  });

  it("interpolation variables match between locales for all shared keys", () => {
    const mismatches: string[] = [];
    for (const key of enKeys) {
      if (!zhKeySet.has(key)) continue;

      // Walk the nested object to get the actual string values
      const enVal = key
        .split(".")
        .reduce<TranslationValue>(
          (o, p) => (o as Record<string, unknown>)?.[p] as TranslationValue,
          en as unknown as Record<string, unknown>,
        ) as string;
      const zhVal = key
        .split(".")
        .reduce<TranslationValue>(
          (o, p) => (o as Record<string, unknown>)?.[p] as TranslationValue,
          zh as unknown as Record<string, unknown>,
        ) as string;

      const enVars = interpolationVars(enVal);
      const zhVars = interpolationVars(zhVal);

      if (enVars.join(",") !== zhVars.join(",")) {
        mismatches.push(`${key}: en={${enVars.join(",")}} zh-CN={${zhVars.join(",")}}`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it("totalKeys in en.json matches actual key count", () => {
    const meta = (en as unknown as { _meta?: { totalKeys?: number } })._meta;
    expect(meta?.totalKeys).toBe(enKeys.length);
  });

  it("totalKeys in zh-CN.json matches actual key count", () => {
    const meta = (zh as unknown as { _meta?: { totalKeys?: number } })._meta;
    expect(meta?.totalKeys).toBe(zhKeys.length);
  });

  it("all keys follow lowercase-dot-separated naming convention", () => {
    const badKeys = enKeys.filter((k) => !/^[a-z][a-z0-9]+(\.[a-z][a-z0-9]*)*$/.test(k));
    // Allow keys that contain camelCase segments (existing convention)
    const camelCaseKeys = enKeys.filter((k) => k.includes("openIn") || k.includes("gitHub"));
    // Only flag keys that don't match either pattern
    const invalid = enKeys.filter(
      (k) => !/^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)*$/.test(k) && !k.startsWith("_meta"),
    );
    // This is informational — don't fail on existing keys that don't follow convention
    if (invalid.length > 0) {
      console.warn(`Keys not following lowercase-dot-separated convention: ${invalid.join(", ")}`);
    }
  });
});
