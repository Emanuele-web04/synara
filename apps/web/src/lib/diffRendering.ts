// FILE: diffRendering.ts
// Purpose: Shared helpers for rendering, caching, copying, and summarizing git patches.
// Layer: Web diff utilities
// Depends on: @pierre/diffs patch parsing

import { parsePatchFiles } from "@pierre/diffs";
import type { FileDiffMetadata } from "@pierre/diffs/react";

export type FileDiffStat = { additions: number; deletions: number };

export const DIFF_THEME_NAMES = {
  // Keep diff syntax highlighting on the bundled GitHub themes for better parity with git tooling.
  light: "github-light",
  dark: "github-dark",
} as const;

export type DiffThemeName = (typeof DIFF_THEME_NAMES)[keyof typeof DIFF_THEME_NAMES];

export function resolveDiffThemeName(theme: "light" | "dark"): DiffThemeName {
  return theme === "dark" ? DIFF_THEME_NAMES.dark : DIFF_THEME_NAMES.light;
}

// The `unsafeCSS` payload is identical per theme and only ever has two values,
// so cache it instead of rebuilding the (large) template string per file/render.
const diffPanelUnsafeCssCache = new Map<"light" | "dark", string>();

// Themed CSS injected into the @pierre/diffs shadow markup so the diff viewer
// adopts the app's chat code font and themed addition/deletion backgrounds.
// Shared by every diff surface (turn diffs, repo diffs, the git pane) so they
// render consistently — previously the git pane omitted this entirely.
export function buildDiffPanelUnsafeCSS(theme: "light" | "dark"): string {
  const cached = diffPanelUnsafeCssCache.get(theme);
  if (cached) {
    return cached;
  }
  const css = `
:host {
  /* Route diff hunks through the chat code font; keep file headers on the UI stack. */
  --diffs-font-family: var(--font-chat-code-family);
  --diffs-header-font-family: var(--font-ui-family);
  /* Honor the user-chosen chat code font size from settings instead of the library default (13px). */
  --diffs-font-size: var(--app-font-size-chat-code, 11px);
  font-family: var(--font-chat-code-family) !important;
  font-size: var(--app-font-size-chat-code, 11px) !important;
}

[data-diffs-header],
[data-diff],
[data-file],
[data-error-wrapper],
[data-virtualizer-buffer] {
  --diffs-font-size: var(--app-font-size-chat-code, 11px) !important;
  --diffs-bg: color-mix(in srgb, var(--card) 90%, var(--background)) !important;
  --diffs-light-bg: color-mix(in srgb, var(--card) 90%, var(--background)) !important;
  --diffs-dark-bg: color-mix(in srgb, var(--card) 90%, var(--background)) !important;
  --diffs-token-light-bg: transparent;
  --diffs-token-dark-bg: transparent;

  --diffs-bg-context-override: color-mix(in srgb, var(--background) 97%, var(--foreground));
  --diffs-bg-hover-override: color-mix(in srgb, var(--background) 94%, var(--foreground));
  --diffs-bg-separator-override: color-mix(in srgb, var(--background) 95%, var(--foreground));
  --diffs-bg-buffer-override: color-mix(in srgb, var(--background) 90%, var(--foreground));

  --diffs-bg-addition-override: color-mix(in srgb, var(--background) 92%, var(--success));
  --diffs-bg-addition-number-override: color-mix(in srgb, var(--background) 88%, var(--success));
  --diffs-bg-addition-hover-override: color-mix(in srgb, var(--background) 85%, var(--success));
  --diffs-bg-addition-emphasis-override: color-mix(in srgb, var(--background) 80%, var(--success));

  --diffs-bg-deletion-override: color-mix(in srgb, var(--background) 92%, var(--destructive));
  --diffs-bg-deletion-number-override: color-mix(in srgb, var(--background) 88%, var(--destructive));
  --diffs-bg-deletion-hover-override: color-mix(in srgb, var(--background) 85%, var(--destructive));
  --diffs-bg-deletion-emphasis-override: color-mix(
    in srgb,
    var(--background) 80%,
    var(--destructive)
  );

  background-color: var(--diffs-bg) !important;
}

[data-diff],
[data-file],
[data-error-wrapper],
[data-virtualizer-buffer] {
  /* Re-assert the code font inside diff hunks because these nodes live in shadow-rooted markup. */
  --diffs-font-family: var(--font-chat-code-family) !important;
  font-family: var(--font-chat-code-family) !important;
  font-size: var(--app-font-size-chat-code, 11px) !important;
}

[data-file-info] {
  font-family: var(--font-ui-family) !important;
  font-size: var(--app-font-size-ui, 12px) !important;
  background-color: color-mix(in srgb, var(--card) 94%, var(--foreground)) !important;
  border-block-color: var(--border) !important;
  color: var(--foreground) !important;
}

[data-diffs-header] {
  --diffs-header-font-family: var(--font-ui-family) !important;
  font-family: var(--font-ui-family) !important;
  font-size: var(--app-font-size-ui, 12px) !important;
  position: sticky !important;
  top: 0;
  z-index: 4;
  background-color: color-mix(in srgb, var(--card) 94%, var(--foreground)) !important;
  border-bottom: 1px solid var(--border) !important;
  cursor: pointer;
}

[data-header-content] {
  align-items: center !important;
}

::slotted([slot="header-prefix"]) {
  display: inline-flex !important;
  align-items: center !important;
  justify-content: center !important;
  flex-shrink: 0 !important;
  line-height: 0 !important;
}

/* Hide the default change-type icon (blue circle) — replaced by chevron + file-type icon. */
[data-change-icon] {
  display: none;
}

[data-title],
[data-prev-name] {
  font-family: var(--font-ui-family) !important;
  font-size: var(--app-font-size-ui, 12px) !important;
  font-weight: 400 !important;
  cursor: pointer;
  color: var(--foreground) !important;
}

/* Every number rendered inside a diff reads in the UI font (with tabular figures
   so columns still line up), not the mono code font: gutter line numbers, the
   "N unmodified lines" separators, and the header +/- counts. The library pins
   the header counts to --diffs-font-family and the gutter/separators inherit it
   from the hunk body, so each needs an explicit override. */
[data-line-number-content],
[data-column-number],
[data-unmodified-lines] {
  font-family: var(--font-ui-family) !important;
  font-variant-numeric: tabular-nums !important;
}

[data-diffs-header] [data-additions-count],
[data-diffs-header] [data-deletions-count] {
  font-family: var(--font-ui-family) !important;
  font-variant-numeric: tabular-nums !important;
}
`;
  diffPanelUnsafeCssCache.set(theme, css);
  return css;
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

// Resolve the working-tree-relative path for a parsed file diff, stripping the
// conventional `a/` / `b/` patch prefixes so callers can match git status paths.
export function resolveFileDiffPath(fileDiff: FileDiffMetadata): string {
  const raw = fileDiff.name ?? fileDiff.prevName ?? "";
  if (raw.startsWith("a/") || raw.startsWith("b/")) {
    return raw.slice(2);
  }
  return raw;
}

// Stable identity for a parsed file diff, used as a React key and selection id.
export function buildFileDiffRenderKey(fileDiff: FileDiffMetadata): string {
  return fileDiff.cacheKey ?? `${fileDiff.prevName ?? "none"}:${fileDiff.name}`;
}

// Split a repo-relative path into a trailing-slash directory prefix and a leaf
// name so diff/file rows can dim the directory while emphasizing the file name.
// Intentionally not reusing the directory-browser helpers (projectPaths.ts):
// those carry trailing-separator / Windows-drive semantics meant for browsing.
export function splitRepoRelativePath(path: string): { dir: string; name: string } {
  const index = path.lastIndexOf("/");
  if (index === -1) {
    return { dir: "", name: path };
  }
  return { dir: path.slice(0, index + 1), name: path.slice(index + 1) };
}

// Natural-order comparator for parsed file diffs by working-tree path, so file
// lists stay stable and human-friendly (numeric-aware, case-insensitive).
export function compareFileDiffByPath(left: FileDiffMetadata, right: FileDiffMetadata): number {
  return resolveFileDiffPath(left).localeCompare(resolveFileDiffPath(right), undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

export function sortFileDiffsByPath(files: ReadonlyArray<FileDiffMetadata>): FileDiffMetadata[] {
  return files.toSorted(compareFileDiffByPath);
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

export function summarizeRenderablePatchStats(
  renderable: RenderablePatch | null | undefined,
): { additions: number; deletions: number; fileCount: number } | null {
  if (!renderable || renderable.kind !== "files" || renderable.files.length === 0) {
    return null;
  }
  return { ...summarizeFileDiffStats(renderable.files), fileCount: renderable.files.length };
}

export function summarizePatchTotals(
  patch: string | undefined,
): { additions: number; deletions: number; fileCount: number } | null {
  const renderable = getRenderablePatch(patch, "diff-panel:stats");
  return summarizeRenderablePatchStats(renderable);
}

// Per-file +N/-M parsed from a unified diff/patch, keyed by working-tree-relative
// path (a/ b/ prefixes stripped via resolveFileDiffPath). Lets transcript
// "Edited <file>" rows surface diff stats from a tool call's own patch when no
// turn-diff summary is in scope (e.g. standalone work rows). Empty map when the
// patch is missing or unparsable, so callers can fall back gracefully.
export function fileDiffStatsByPath(patch: string | undefined): Map<string, FileDiffStat> {
  const stats = new Map<string, FileDiffStat>();
  const renderable = getRenderablePatch(patch, "tool-row:stats");
  if (!renderable || renderable.kind !== "files") {
    return stats;
  }
  for (const file of renderable.files) {
    const path = resolveFileDiffPath(file);
    if (path.length === 0) {
      continue;
    }
    stats.set(path, summarizeFileDiffStats([file]));
  }
  return stats;
}

function normalizeDiffStatPath(path: string): string {
  return path
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/\/+/g, "/");
}

function diffStatPathsReferToSameFile(left: string, right: string): boolean {
  const normalizedLeft = normalizeDiffStatPath(left);
  const normalizedRight = normalizeDiffStatPath(right);
  return (
    normalizedLeft === normalizedRight ||
    normalizedLeft.endsWith(`/${normalizedRight}`) ||
    normalizedRight.endsWith(`/${normalizedLeft}`)
  );
}

// Resolve a parsed patch stat for a visible changed-file row. Parsed patch paths are
// usually repo-relative, while work-log changedFiles can be absolute or basename-only.
export function resolveFileDiffStatByChangedPath(
  statsByPath: ReadonlyMap<string, FileDiffStat>,
  changedFilePath: string,
  changedFileCount: number,
): FileDiffStat | undefined {
  if (statsByPath.size === 0) {
    return undefined;
  }

  const direct = statsByPath.get(changedFilePath);
  if (direct) {
    return direct;
  }

  const matchingStats = Array.from(statsByPath.entries())
    .filter(([path]) => diffStatPathsReferToSameFile(path, changedFilePath))
    .map(([, stat]) => stat);
  const uniqueMatch = matchingStats.length === 1 ? matchingStats.at(0) : undefined;
  if (uniqueMatch) {
    return uniqueMatch;
  }

  if (statsByPath.size === 1 && changedFileCount === 1) {
    return statsByPath.values().next().value;
  }
  return undefined;
}
