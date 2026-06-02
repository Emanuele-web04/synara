// FILE: persistedRecord.ts
// Purpose: Shared helpers for validating untrusted persisted (localStorage) state.
// Layer: Web UI state utilities
// Exports: plain-object guard and a string-keyed record sanitizer used by stores.

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Rebuilds a `Record<string, T>` from untrusted persisted input: keeps only own
// string keys whose value survives `sanitizeEntry`, dropping anything that maps
// to `null`. Returns an empty record when the input is not a plain object, so a
// corrupt blob can never reach consumers as a malformed map.
export function sanitizeStringKeyedRecord<T>(
  value: unknown,
  sanitizeEntry: (rawEntry: unknown) => T | null,
): Record<string, T> {
  if (!isPlainObject(value)) {
    return {};
  }

  const result: Record<string, T> = {};
  for (const [key, rawEntry] of Object.entries(value)) {
    const sanitized = sanitizeEntry(rawEntry);
    if (sanitized !== null) {
      result[key] = sanitized;
    }
  }
  return result;
}
