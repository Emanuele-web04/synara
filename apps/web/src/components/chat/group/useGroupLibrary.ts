// FILE: useGroupLibrary.ts
// Purpose: Client state for the group Library panel — per-directory listings,
//          mutations (mkdir/rename/delete/restore), binary upload, and the
//          remote-push status pill. Mirrors useProjectAgent's load/mutation
//          discipline (project-id + generation guards) so a project switch can
//          never surface another group's library.
// Layer: Chat UI hooks

import {
  type LibraryCommit,
  type LibraryEntry,
  type ProjectAgentLibraryStatusResult,
  type ProjectId,
} from "@synara/contracts";
import { LIBRARY_UPLOAD_ROUTE_PATH } from "@synara/shared/binaryTransfer";
import { useCallback, useEffect, useRef, useState } from "react";

import { resolveWsHttpUrl } from "~/lib/wsHttpUrl";
import { readNativeApi } from "~/nativeApi";

const ROOT_DIRECTORY = "";
// One page of search results; "Load more" fetches the next cursor page.
const SEARCH_PAGE_SIZE = 50;
const SEARCH_DEBOUNCE_MS = 250;

// Kept at module scope so no value blocks (ternaries, `?.`) live inside the
// try/catch bodies below — those trip React Compiler bailouts.
const libraryErrorMessage = (cause: unknown, fallback: string) =>
  cause instanceof Error ? cause.message : fallback;

const libraryUploadErrorMessage = (payload: unknown, status: number) => {
  const message = (payload as { readonly error?: unknown } | null)?.error;
  return typeof message === "string" ? message : `Library upload failed with status ${status}.`;
};

type NativeLibraryApi = NonNullable<ReturnType<typeof readNativeApi>>["projectAgent"]["library"];

// Search-page merge lives at module scope: a conditional value block inside a
// try/catch body is a React Compiler bailout.
function mergeSearchResults(input: {
  readonly appending: boolean;
  readonly previous: readonly LibraryEntry[];
  readonly page: readonly LibraryEntry[];
  readonly droppedPaths: ReadonlySet<string>;
}): readonly LibraryEntry[] {
  const merged = input.appending ? [...input.previous, ...input.page] : input.page;
  return merged.filter((entry) => !input.droppedPaths.has(entry.relativePath));
}

export function useGroupLibrary(input: {
  readonly projectId: ProjectId | null;
  readonly enabled: boolean;
}) {
  const [root, setRoot] = useState<string | null>(null);
  const [entriesByDir, setEntriesByDir] = useState<ReadonlyMap<string, readonly LibraryEntry[]>>(
    new Map(),
  );
  const [status, setStatus] = useState<ProjectAgentLibraryStatusResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const projectIdRef = useRef(input.projectId);
  const loadGeneration = useRef(0);
  const loadedDirs = useRef<ReadonlySet<string>>(new Set());
  // One listing refresh in flight at a time: focus + turn-finished bursts
  // coalesce into a single follow-up instead of stacking sequential reloads.
  const refreshInFlightRef = useRef<Promise<void> | null>(null);
  const refreshQueuedRef = useRef(false);
  // Server-side name search state. The per-directory listings only cover
  // directories a user opened, so a query searches the whole tree instead; the
  // results are paths only (no contents are read), and paging is cursor-based.
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<readonly LibraryEntry[]>([]);
  const [searchCursor, setSearchCursor] = useState<string | null>(null);
  const [searchTruncated, setSearchTruncated] = useState(false);
  const [searchScanned, setSearchScanned] = useState(0);
  const [searchBusy, setSearchBusy] = useState(false);
  const searchGeneration = useRef(0);
  const searchTimer = useRef<number | null>(null);
  // Paths a rename/delete removed, so a page that was already in flight cannot
  // re-add a row for something that no longer exists.
  const [droppedSearchPaths, setDroppedSearchPaths] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );

  // Refresh in place: keep every cached listing until its directory's fresh one
  // lands, so expanded subfolders never flash empty. The root plus every
  // directory already fetched (including collapsed ones) is re-listed and
  // replaced as each result arrives.
  const load = () => {
    const api = readNativeApi();
    const projectId = projectIdRef.current;
    if (!input.enabled || !projectId || !api?.projectAgent) return;
    if (refreshInFlightRef.current !== null) {
      refreshQueuedRef.current = true;
      return;
    }
    const generation = loadGeneration.current;
    const stillCurrent = () =>
      projectIdRef.current === projectId && loadGeneration.current === generation;
    const dirs = new Set(loadedDirs.current);
    dirs.add(ROOT_DIRECTORY);
    let refreshFailed = false;
    const run = (async () => {
      await Promise.all(
        Array.from(dirs, async (dir) => {
          const listArgs =
            dir === ROOT_DIRECTORY ? { projectId } : { projectId, relativePath: dir };
          try {
            const listed = await api.projectAgent.library.list(listArgs);
            if (!stillCurrent()) return;
            setEntriesByDir((current) => new Map(current).set(dir, listed.entries));
            if (dir === ROOT_DIRECTORY) setRoot(listed.root);
          } catch (cause) {
            if (!stillCurrent()) return;
            refreshFailed = true;
            setError(libraryErrorMessage(cause, "Failed to refresh the library."));
          }
        }),
      );
      await refreshStatus(projectId);
      if (stillCurrent() && !refreshFailed) setError(null);
    })();
    refreshInFlightRef.current = run;
    void run.finally(() => {
      refreshInFlightRef.current = null;
      if (!refreshQueuedRef.current) return;
      refreshQueuedRef.current = false;
      if (stillCurrent()) load();
    });
  };

  useEffect(() => {
    const projectId = input.projectId;
    projectIdRef.current = projectId;
    loadGeneration.current += 1;
    // A mutation in flight for the previous project must not leave the busy
    // flag stuck on the new one.
    setBusy(false);
    const api = readNativeApi();
    if (!input.enabled || !projectId || !api?.projectAgent) {
      setRoot(null);
      setEntriesByDir(new Map());
      setStatus(null);
      loadedDirs.current = new Set();
      // A query never carries across a project switch: the next project's
      // library is a different tree and the old results would be false links.
      if (searchTimer.current !== null) window.clearTimeout(searchTimer.current);
      searchTimer.current = null;
      searchGeneration.current += 1;
      setDroppedSearchPaths(new Set<string>());
      setSearchQuery("");
      setSearchResults([]);
      setSearchCursor(null);
      setSearchTruncated(false);
      setSearchScanned(0);
      setSearchBusy(false);
      return;
    }
    const generation = loadGeneration.current;
    const stillCurrent = () =>
      projectIdRef.current === projectId && loadGeneration.current === generation;
    setEntriesByDir(new Map());
    loadedDirs.current = new Set();
    void (async () => {
      try {
        const [listed, nextStatus] = await Promise.all([
          api.projectAgent.library.list({ projectId }),
          api.projectAgent.library.status({ projectId }),
        ]);
        // Eagerly list root directories so seeded-expanded folders (Artifacts)
        // render their contents on first open instead of an empty expander.
        const rootDirs = listed.entries.filter((entry) => entry.kind === "directory");
        const childListings = await Promise.all(
          rootDirs.map((entry) =>
            api.projectAgent.library.list({
              projectId,
              relativePath: entry.relativePath,
            }),
          ),
        );
        if (!stillCurrent()) return;
        const entriesByDir = new Map<string, readonly LibraryEntry[]>([
          [ROOT_DIRECTORY, listed.entries],
        ]);
        const dirs = new Set([ROOT_DIRECTORY]);
        rootDirs.forEach((entry, index) => {
          const childEntries = childListings[index];
          if (childEntries) {
            entriesByDir.set(entry.relativePath, childEntries.entries);
            dirs.add(entry.relativePath);
          }
        });
        loadedDirs.current = dirs;
        setEntriesByDir(entriesByDir);
        setRoot(listed.root);
        setStatus(nextStatus);
        setError(null);
      } catch (cause) {
        if (!stillCurrent()) return;
        setError(libraryErrorMessage(cause, "Failed to load the library."));
      }
    })();
  }, [input.enabled, input.projectId]);

  const loadDirectory = async (relativePath: string | undefined) => {
    const api = readNativeApi();
    const projectId = projectIdRef.current;
    if (!api?.projectAgent || !projectId) return false;
    const dir = relativePath ?? ROOT_DIRECTORY;
    const listArgs = relativePath === undefined ? { projectId } : { projectId, relativePath };
    try {
      const listed = await api.projectAgent.library.list(listArgs);
      if (projectIdRef.current !== projectId) return false;
      setRoot(listed.root);
      setEntriesByDir((current) => new Map(current).set(dir, listed.entries));
      loadedDirs.current = new Set([...loadedDirs.current, dir]);
      return true;
    } catch (cause) {
      if (projectIdRef.current === projectId) {
        setError(libraryErrorMessage(cause, "Failed to list the library."));
      }
      return false;
    }
  };

  const reloadLoadedDirectories = async (projectId: ProjectId) => {
    let refreshed = true;
    // The server serializes listings under the project's root lock. Start each
    // RPC only after the previous reply so its timeout excludes queued reads.
    for (const dir of loadedDirs.current) {
      if (projectIdRef.current !== projectId) return false;
      const loaded = await loadDirectory(dir === ROOT_DIRECTORY ? undefined : dir);
      if (!loaded) refreshed = false;
    }
    return refreshed;
  };

  const refreshStatus = async (projectId: ProjectId) => {
    const api = readNativeApi();
    if (!api?.projectAgent) return;
    const nextStatus = await api.projectAgent.library.status({ projectId }).catch(() => null);
    if (nextStatus && projectIdRef.current === projectId) setStatus(nextStatus);
  };

  const runMutation = async (
    work: (library: NativeLibraryApi, projectId: ProjectId) => Promise<void>,
  ) => {
    const api = readNativeApi();
    const projectId = projectIdRef.current;
    if (!api?.projectAgent || !projectId) return false;
    setBusy(true);
    // No finally: a finalizer is a React Compiler bailout, and the busy flag is
    // also reset by the project-switch effect for stale-project exits.
    let succeeded = false;
    try {
      await work(api.projectAgent.library, projectId);
      if (projectIdRef.current === projectId) {
        const refreshed = await reloadLoadedDirectories(projectId);
        await refreshStatus(projectId);
        if (projectIdRef.current === projectId) {
          if (refreshed) setError(null);
          // An upload or a restore can add a path the active query matches,
          // so the results are re-fetched instead of left stale.
          if (searchQuery.trim().length > 0) {
            void runSearch(searchQuery);
          }
        }
      }
      succeeded = true;
    } catch (cause) {
      if (projectIdRef.current === projectId) {
        setError(libraryErrorMessage(cause, "Library action failed."));
      }
    }
    if (projectIdRef.current === projectId) setBusy(false);
    return succeeded;
  };

  const mkdir = async (relativePath: string) =>
    runMutation(async (library, projectId) => {
      await library.mkdir({ projectId, relativePath });
    });

  const forgetDirectory = (relativePath: string) => {
    const keep = (dir: string) => dir !== relativePath && !dir.startsWith(`${relativePath}/`);
    loadedDirs.current = new Set(Array.from(loadedDirs.current).filter(keep));
    setEntriesByDir((current) => new Map(Array.from(current).filter(([dir]) => keep(dir))));
    // Same rule for search results: a renamed or deleted path disappears now,
    // so no row keeps pointing at a file that is gone or has a new name.
    setSearchResults((current) => {
      const kept = current.filter((entry) => keep(entry.relativePath));
      const removed = current.filter((entry) => !keep(entry.relativePath));
      if (removed.length > 0) {
        setDroppedSearchPaths(
          new Set([...droppedSearchPaths, ...removed.map((entry) => entry.relativePath)]),
        );
      }
      return kept;
    });
  };

  // Whole-tree name search. A fresh query replaces the result set; paging
  // appends the next cursor's page. Paths dropped by a rename/delete are
  // filtered out even if an in-flight page still names them.
  const runSearch = useCallback(
    async (query: string, options?: { readonly append?: boolean }) => {
      const api = readNativeApi();
      const projectId = projectIdRef.current;
      const trimmed = query.trim();
      if (!input.enabled || !api?.projectAgent || !projectId || trimmed.length === 0) return;
      const generation = ++searchGeneration.current;
      const appending = options?.append === true;
      const cursor = appending ? searchCursor : null;
      // Built before the try: a conditional value block inside try/catch is a
      // React Compiler bailout. The guard closure keeps the logical conditions
      // out of the try/catch bodies too.
      const searchArgs = cursor
        ? { projectId, query: trimmed, limit: SEARCH_PAGE_SIZE, cursor }
        : { projectId, query: trimmed, limit: SEARCH_PAGE_SIZE };
      const stillCurrent = () =>
        projectIdRef.current === projectId && searchGeneration.current === generation;
      setSearchBusy(true);
      try {
        const page = await api.projectAgent.library.search(searchArgs);
        if (!stillCurrent()) return;
        const kept = mergeSearchResults({
          appending,
          previous: searchResults,
          page: page.entries,
          droppedPaths: droppedSearchPaths,
        });
        setSearchResults(kept);
        setSearchCursor(page.nextCursor);
        setSearchTruncated(page.truncated);
        setSearchScanned(page.scannedEntries);
        // No finally: a finalizer is a React Compiler bailout, so the busy flag
        // clears on each exit and a stale generation skips it entirely.
        if (stillCurrent()) setSearchBusy(false);
      } catch (cause) {
        if (!stillCurrent()) return;
        setSearchResults([]);
        setSearchCursor(null);
        setError(libraryErrorMessage(cause, "Failed to search the library."));
        setSearchBusy(false);
      }
    },
    [droppedSearchPaths, input.enabled, searchCursor, searchResults],
  );

  // Debounced: every keystroke would otherwise walk the whole library tree.
  const search = useCallback(
    (query: string) => {
      setSearchQuery(query);
      if (searchTimer.current !== null) window.clearTimeout(searchTimer.current);
      searchTimer.current = null;
      if (query.trim().length === 0) {
        searchGeneration.current += 1;
        setDroppedSearchPaths(new Set<string>());
        setSearchResults([]);
        setSearchCursor(null);
        setSearchTruncated(false);
        setSearchScanned(0);
        setSearchBusy(false);
        return;
      }
      // A new query invalidates the old page and the paths dropped under it.
      setDroppedSearchPaths(new Set<string>());
      searchTimer.current = window.setTimeout(() => void runSearch(query), SEARCH_DEBOUNCE_MS);
    },
    [runSearch],
  );

  const loadMoreSearchResults = useCallback(() => {
    if (searchCursor === null || searchBusy) return;
    void runSearch(searchQuery, { append: true });
  }, [runSearch, searchBusy, searchCursor, searchQuery]);

  const rename = async (from: string, to: string) =>
    runMutation(async (library, projectId) => {
      await library.rename({ projectId, from, to });
      if (projectIdRef.current === projectId) forgetDirectory(from);
    });

  const deleteEntry = async (relativePath: string) =>
    runMutation(async (library, projectId) => {
      await library.delete({ projectId, relativePath });
      if (projectIdRef.current === projectId) forgetDirectory(relativePath);
    });

  const history = async (relativePath?: string) => {
    const api = readNativeApi();
    const projectId = projectIdRef.current;
    if (!api?.projectAgent || !projectId) return [] as readonly LibraryCommit[];
    const historyArgs = relativePath === undefined ? { projectId } : { projectId, relativePath };
    try {
      const result = await api.projectAgent.library.history(historyArgs);
      return result.commits;
    } catch (cause) {
      if (projectIdRef.current === projectId) {
        setError(libraryErrorMessage(cause, "Failed to load library history."));
      }
      return [] as readonly LibraryCommit[];
    }
  };

  const restore = async (relativePath: string, sha: string) =>
    runMutation(async (library, projectId) => {
      await library.restore({ projectId, relativePath, sha });
    });

  const upload = async (relativeDirectory: string | undefined, file: File) => {
    const projectId = projectIdRef.current;
    if (!projectId) return false;
    const params = new URLSearchParams({ projectId, name: file.name });
    if (relativeDirectory) params.set("relativePath", relativeDirectory);
    const url = resolveWsHttpUrl(`${LIBRARY_UPLOAD_ROUTE_PATH}?${params.toString()}`);
    setBusy(true);
    let succeeded = false;
    try {
      const response = await fetch(url, {
        method: "POST",
        credentials: "include",
        body: file,
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as unknown;
        if (projectIdRef.current === projectId) {
          setError(libraryUploadErrorMessage(payload, response.status));
        }
      } else {
        if (projectIdRef.current === projectId) {
          const refreshed = await reloadLoadedDirectories(projectId);
          await refreshStatus(projectId);
          if (projectIdRef.current === projectId) {
            if (refreshed) setError(null);
          }
        }
        succeeded = true;
      }
    } catch (cause) {
      if (projectIdRef.current === projectId) {
        setError(libraryErrorMessage(cause, "Library upload failed."));
      }
    }
    if (projectIdRef.current === projectId) setBusy(false);
    return succeeded;
  };

  return {
    root,
    entriesByDir,
    status,
    error,
    busy,
    load,
    loadDirectory,
    mkdir,
    rename,
    deleteEntry,
    history,
    restore,
    upload,
    search,
    searchQuery,
    searchResults,
    searchCursor,
    searchTruncated,
    searchScanned,
    searchBusy,
    loadMoreSearchResults,
    droppedSearchPaths,
    setError,
  };
}
