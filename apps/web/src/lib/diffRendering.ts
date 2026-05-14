// FILE: diffRendering.ts
// Purpose: Shared helpers for rendering, caching, copying, and summarizing git patches.
// Layer: Web diff utilities
// Depends on: @pierre/diffs patch parsing

import { parsePatchFiles } from "@pierre/diffs";
import type { Hunk } from "@pierre/diffs";
import type { FileDiffMetadata } from "@pierre/diffs/react";

export const DIFF_THEME_NAMES = {
  // Keep diff syntax highlighting on the bundled GitHub themes for better parity with git tooling.
  light: "github-light",
  dark: "github-dark",
} as const;

export type DiffThemeName = (typeof DIFF_THEME_NAMES)[keyof typeof DIFF_THEME_NAMES];

export function resolveDiffThemeName(theme: "light" | "dark"): DiffThemeName {
  return theme === "dark" ? DIFF_THEME_NAMES.dark : DIFF_THEME_NAMES.light;
}

const FNV_OFFSET_BASIS_32 = 0x811c9dc5;
const FNV_PRIME_32 = 0x01000193;
const SECONDARY_HASH_SEED = 0x9e3779b9;
const SECONDARY_HASH_MULTIPLIER = 0x85ebca6b;

export function fnv1a32(
  input: string,
  seed = FNV_OFFSET_BASIS_32,
  multiplier = FNV_PRIME_32,
): number {
  let hash = seed >>> 0;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, multiplier) >>> 0;
  }
  return hash >>> 0;
}

export function buildPatchCacheKey(patch: string, scope = "diff-panel"): string {
  const normalizedPatch = patch.trim();
  const primary = fnv1a32(normalizedPatch, FNV_OFFSET_BASIS_32, FNV_PRIME_32).toString(36);
  const secondary = fnv1a32(
    normalizedPatch,
    SECONDARY_HASH_SEED,
    SECONDARY_HASH_MULTIPLIER,
  ).toString(36);
  return `${scope}:${normalizedPatch.length}:${primary}:${secondary}`;
}

// Returns copyable source text for diff surfaces without depending on virtualized DOM rows.
export function resolveDiffCopyText(patch: string | undefined): string | null {
  if (typeof patch !== "string") {
    return null;
  }
  return patch.trim().length > 0 ? patch : null;
}

export type RenderablePatch =
  | {
      kind: "files";
      files: FileDiffMetadata[];
    }
  | {
      kind: "raw";
      text: string;
      reason: string;
    };

export function getRenderablePatch(
  patch: string | undefined,
  cacheScope = "diff-panel",
): RenderablePatch | null {
  if (!patch) return null;
  const normalizedPatch = patch.trim();
  if (normalizedPatch.length === 0) return null;

  try {
    const parsedPatches = parsePatchFiles(
      normalizedPatch,
      buildPatchCacheKey(normalizedPatch, cacheScope),
    );
    const files = parsedPatches.flatMap((parsedPatch) => parsedPatch.files);
    if (files.length > 0) {
      return { kind: "files", files };
    }

    return {
      kind: "raw",
      text: normalizedPatch,
      reason: "Unsupported diff format. Showing raw patch.",
    };
  } catch {
    return {
      kind: "raw",
      text: normalizedPatch,
      reason: "Failed to parse patch. Showing raw patch.",
    };
  }
}

// @pierre/diffs leaves trailing newlines on parsed lines; drop them so the `\n` join below doesn't add blank lines.
function stripLineBreak(line: string): string {
  return line.replace(/\r?\n$/, "");
}

function serializeHunkHeader(hunk: Hunk): string {
  const specs = stripLineBreak(
    hunk.hunkSpecs ??
      `@@ -${hunk.deletionStart},${hunk.deletionCount} +${hunk.additionStart},${hunk.additionCount} @@`,
  );
  const context = hunk.hunkContext ? stripLineBreak(hunk.hunkContext) : "";
  return context ? `${specs} ${context}` : specs;
}

// Rebuild the unified-diff text for one parsed file from the @pierre/diffs model.
export function serializeFileDiffMetadata(file: FileDiffMetadata): string {
  const newPath = file.name;
  const oldPath = file.prevName ?? file.name;
  const lines: string[] = [`diff --git a/${oldPath} b/${newPath}`];

  if (file.type === "new") {
    lines.push(`new file mode ${file.mode ?? "100644"}`);
  } else if (file.type === "deleted") {
    lines.push(`deleted file mode ${file.prevMode ?? file.mode ?? "100644"}`);
  } else if (file.type === "rename-pure" || file.type === "rename-changed") {
    lines.push(`rename from ${oldPath}`, `rename to ${newPath}`);
  }

  lines.push(
    `--- ${file.type === "new" ? "/dev/null" : `a/${oldPath}`}`,
    `+++ ${file.type === "deleted" ? "/dev/null" : `b/${newPath}`}`,
  );

  for (const hunk of file.hunks) {
    lines.push(serializeHunkHeader(hunk));
    for (const segment of hunk.hunkContent) {
      if (segment.type === "context") {
        for (let offset = 0; offset < segment.lines; offset += 1) {
          const content =
            file.additionLines[segment.additionLineIndex + offset] ??
            file.deletionLines[segment.deletionLineIndex + offset] ??
            "";
          lines.push(` ${stripLineBreak(content)}`);
        }
        continue;
      }
      for (let offset = 0; offset < segment.deletions; offset += 1) {
        lines.push(
          `-${stripLineBreak(file.deletionLines[segment.deletionLineIndex + offset] ?? "")}`,
        );
      }
      for (let offset = 0; offset < segment.additions; offset += 1) {
        lines.push(
          `+${stripLineBreak(file.additionLines[segment.additionLineIndex + offset] ?? "")}`,
        );
      }
    }
  }

  return lines.join("\n");
}

// Serialize an entire renderable patch (every file, every line) for clipboard writes.
export function serializeRenderablePatchText(renderable: RenderablePatch | null): string | null {
  if (!renderable) {
    return null;
  }
  if (renderable.kind === "raw") {
    return renderable.text.length > 0 ? renderable.text : null;
  }
  if (renderable.files.length === 0) {
    return null;
  }
  const serialized = renderable.files.map(serializeFileDiffMetadata).join("\n");
  return serialized.length > 0 ? serialized : null;
}

// Summarize parsed hunks for compact, consistent diff stats across panel chrome.
export function summarizeFileDiffStats(files: ReadonlyArray<FileDiffMetadata>): {
  additions: number;
  deletions: number;
} {
  return files.reduce(
    (total, file) => {
      for (const hunk of file.hunks) {
        total.additions += hunk.additionLines;
        total.deletions += hunk.deletionLines;
      }
      return total;
    },
    { additions: 0, deletions: 0 },
  );
}

export function summarizePatchStats(
  patch: string | undefined,
): { additions: number; deletions: number } | null {
  const renderable = getRenderablePatch(patch, "diff-panel:stats");
  if (renderable?.kind !== "files") return null;
  return summarizeFileDiffStats(renderable.files);
}
