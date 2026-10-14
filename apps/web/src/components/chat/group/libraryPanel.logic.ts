// FILE: libraryPanel.logic.ts
// Purpose: Pure helpers for the group Library panel — sort/filter/flatten of the
//          per-directory entry listing the `projectAgent.library.*` RPCs return.
// Layer: Chat UI logic (framework-free)

import type { LibraryEntry } from "@synara/contracts";

import { getFileIconName } from "~/file-icons";

export type LibraryViewMode = "list" | "grid";
export type LibraryTypeFilter = "all" | "documents" | "images" | "code" | "other";
export type LibrarySortKey = "name" | "modifiedAt";
export type LibrarySortDirection = "asc" | "desc";

export interface LibrarySortState {
  readonly key: LibrarySortKey;
  readonly direction: LibrarySortDirection;
}

export const DEFAULT_LIBRARY_SORT: LibrarySortState = { key: "name", direction: "asc" };

export interface LibraryRow {
  readonly entry: LibraryEntry;
  readonly depth: number;
}

// Buckets are derived from the shared file-icon table so the Type filter stays
// consistent with the icons rows already render.
const DOCUMENT_ICON_NAMES = new Set([
  "file-pdf",
  "page-text",
  "file-text",
  "file-chart",
  "markdown",
  "calendar-days",
]);
const IMAGE_ICON_NAMES = new Set(["file-png", "file-jpg", "image-alt-text"]);
const CODE_ICON_NAMES = new Set([
  "typescript",
  "react",
  "javascript",
  "json",
  "phyton",
  "rust",
  "php",
  "java",
  "c",
  "vue",
  "svelte",
  "cmd",
  "settings-gear-1",
]);

export function libraryEntryTypeBucket(
  entry: Pick<LibraryEntry, "name" | "kind">,
): Exclude<LibraryTypeFilter, "all"> {
  const iconName = getFileIconName(entry.name);
  if (IMAGE_ICON_NAMES.has(iconName)) return "images";
  if (DOCUMENT_ICON_NAMES.has(iconName)) return "documents";
  if (CODE_ICON_NAMES.has(iconName)) return "code";
  return "other";
}

// Name/directory-first compare, mirroring the server listing order so an
// untouched column keeps directories above files.
export function compareLibraryEntries(
  a: LibraryEntry,
  b: LibraryEntry,
  sort: LibrarySortState,
): number {
  const direction = sort.direction === "asc" ? 1 : -1;
  const primary =
    sort.key === "name" ? a.name.localeCompare(b.name) : a.modifiedAt.localeCompare(b.modifiedAt);
  if (primary !== 0) return primary * direction;
  return a.name.localeCompare(b.name);
}

export function sortLibraryEntries(
  entries: readonly LibraryEntry[],
  sort: LibrarySortState,
): LibraryEntry[] {
  const directories = entries.filter((entry) => entry.kind === "directory");
  const files = entries.filter((entry) => entry.kind !== "directory");
  return [
    ...directories.toSorted((a, b) => compareLibraryEntries(a, b, sort)),
    ...files.toSorted((a, b) => compareLibraryEntries(a, b, sort)),
  ];
}

export function entryMatchesLibraryFilters(
  entry: LibraryEntry,
  filter: { readonly typeFilter: LibraryTypeFilter; readonly query: string },
): boolean {
  const query = filter.query.trim().toLowerCase();
  if (query.length > 0) {
    const haystack = `${entry.relativePath}`.toLowerCase();
    if (!haystack.includes(query)) return false;
  }
  if (filter.typeFilter !== "all" && entry.kind === "file") {
    if (libraryEntryTypeBucket(entry) !== filter.typeFilter) return false;
  }
  return true;
}

// Click-to-sort: same key flips direction, a new key starts ascending.
export function nextLibrarySort(current: LibrarySortState, key: LibrarySortKey): LibrarySortState {
  if (current.key !== key) return { key, direction: "asc" };
  return { key, direction: current.direction === "asc" ? "desc" : "asc" };
}

export function toggleLibraryDirectory(
  expanded: ReadonlySet<string>,
  relativePath: string,
): ReadonlySet<string> {
  const next = new Set(expanded);
  if (next.has(relativePath)) {
    next.delete(relativePath);
  } else {
    next.add(relativePath);
  }
  return next;
}

// Directory contents keyed by directory relative path ("" is the root).
export type LibraryEntriesByDirectory = ReadonlyMap<string, readonly LibraryEntry[]>;

function flattenInto(
  rows: LibraryRow[],
  dirPath: string,
  depth: number,
  input: {
    entriesByDir: LibraryEntriesByDirectory;
    expandedDirectories: ReadonlySet<string>;
    sort: LibrarySortState;
    typeFilter: LibraryTypeFilter;
    query: string;
  },
): void {
  const entries = input.entriesByDir.get(dirPath);
  if (!entries) return;
  const searching = input.query.trim().length > 0;
  const filtering = input.typeFilter !== "all";
  for (const entry of sortLibraryEntries(entries, input.sort)) {
    if (entry.kind === "directory") {
      // Descend into a directory when it is expanded, or when a search/type
      // filter is active so matching (loaded) descendants still surface.
      const descend = searching || filtering || input.expandedDirectories.has(entry.relativePath);
      const childRows: LibraryRow[] = [];
      if (descend) {
        flattenInto(childRows, entry.relativePath, depth + 1, input);
      }
      // Under a type filter a directory is only a container: show it iff it
      // yields visible children. While searching, also keep directories whose
      // own name matches the query.
      const visible = filtering
        ? childRows.length > 0
        : searching
          ? entryMatchesLibraryFilters(entry, input) || childRows.length > 0
          : true;
      if (visible) {
        rows.push({ entry, depth });
        rows.push(...childRows);
      }
      continue;
    }
    if (entryMatchesLibraryFilters(entry, input)) {
      rows.push({ entry, depth });
    }
  }
}

// Flatten the loaded tree into display order. A non-empty query searches every
// directory already loaded (expansion state is ignored while searching — the
// server lists per-directory, so unloaded folders are out of scope).
export function flattenLibraryRows(input: {
  readonly entriesByDir: LibraryEntriesByDirectory;
  readonly expandedDirectories: ReadonlySet<string>;
  readonly sort: LibrarySortState;
  readonly typeFilter: LibraryTypeFilter;
  readonly query: string;
}): LibraryRow[] {
  const rows: LibraryRow[] = [];
  flattenInto(rows, "", 0, input);
  return rows;
}

// The seeded folder is expanded by default so first-open shows the structure.
export const DEFAULT_EXPANDED_DIRECTORIES: ReadonlySet<string> = new Set(["Artifacts"]);
