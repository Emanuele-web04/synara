// FILE: text.ts
// Purpose: Small, dependency-free text helpers shared across server and web so
// repeated string semantics (count pluralization, etc.) live in one place.
// Layer: Shared runtime utility
// Exports: pluralize

import { isChineseLocale } from "./i18n.js";

// Returns the singular or plural form of a noun based on `count`. The plural
// defaults to `${singular}s`; pass an explicit plural for irregular forms or
// when a verb travels with the noun (e.g. "thread is" / "threads are").
//
// In Chinese locales, always returns the singular (Chinese doesn't pluralize).
export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  if (isChineseLocale()) {
    return singular;
  }
  return count === 1 ? singular : plural;
}
