// FILE: fontFamily.test.ts
// Purpose: Verifies CSS-safe font-family normalization for user and theme settings.
// Layer: Web appearance utility tests
// Exports: Vitest coverage for fontFamily helpers.

import { describe, expect, it } from "vitest";
import {
  DEFAULT_MONOSPACE_FONT_FAMILY_STACK,
  normalizeFontFamilyCssValue,
  normalizeMonospaceFontFamilyCssValue,
} from "./fontFamily";

describe("normalizeFontFamilyCssValue", () => {
  it("quotes multi-word family names inside a stack", () => {
    expect(normalizeFontFamilyCssValue("Fira Code, Menlo")).toBe('"Fira Code", Menlo');
  });
});

describe("normalizeMonospaceFontFamilyCssValue", () => {
  it("appends the default mono stack when a code font has no fallback", () => {
    expect(normalizeMonospaceFontFamilyCssValue("Jetbrains Mono")).toBe(
      `"Jetbrains Mono", ${DEFAULT_MONOSPACE_FONT_FAMILY_STACK}`,
    );
  });

  it("keeps existing generic mono fallbacks intact", () => {
    expect(normalizeMonospaceFontFamilyCssValue('"Geist Mono", ui-monospace')).toBe(
      '"Geist Mono", ui-monospace',
    );
  });

  it("preserves CSS-wide keywords as single values", () => {
    expect(normalizeMonospaceFontFamilyCssValue("inherit")).toBe("inherit");
  });
});
