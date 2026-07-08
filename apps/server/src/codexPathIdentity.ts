// FILE: codexPathIdentity.ts
// Purpose: Canonicalizes Codex home paths for account-boundary comparisons.
// Layer: Server filesystem utility.
// Exports: resolveCodexPathIdentity, codexPathsReferenceSameLocation.

import { realpathSync } from "node:fs";
import path from "node:path";

function normalizeIdentity(value: string): string {
  const normalized = path.normalize(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

// Resolve symlinks in every existing path component while preserving a missing tail.
export function resolveCodexPathIdentity(inputPath: string): string {
  const resolvedInput = path.resolve(inputPath);
  const missingSegments: string[] = [];
  let candidate = resolvedInput;

  while (true) {
    try {
      const realCandidate = realpathSync(candidate);
      const rebuilt =
        missingSegments.length > 0 ? path.join(realCandidate, ...missingSegments) : realCandidate;
      return normalizeIdentity(rebuilt);
    } catch {
      const parent = path.dirname(candidate);
      if (parent === candidate) {
        return normalizeIdentity(resolvedInput);
      }
      missingSegments.unshift(path.basename(candidate));
      candidate = parent;
    }
  }
}

// Compare filesystem identity rather than spelling, including parent-component aliases.
export function codexPathsReferenceSameLocation(left: string, right: string): boolean {
  return resolveCodexPathIdentity(left) === resolveCodexPathIdentity(right);
}
