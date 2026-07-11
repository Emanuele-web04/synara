// FILE: providerAccountHomePath.ts
// Purpose: Expand account home shorthand consistently on Unix and Windows.
// Layer: Shared server path utility for provider-instance homes.

import { homedir } from "node:os";
import path from "node:path";

/** Expands both `~/account` and Windows-native `~\account` spellings. */
export function expandProviderAccountHomePath(input: string, homeDir: string = homedir()): string {
  if (input === "~") {
    return homeDir;
  }
  if (!input.startsWith("~/") && !input.startsWith("~\\")) {
    return input;
  }

  const segments = input
    .slice(2)
    .split(/[\\/]+/u)
    .filter((segment) => segment.length > 0);
  return segments.length === 0 ? homeDir : path.join(homeDir, ...segments);
}
