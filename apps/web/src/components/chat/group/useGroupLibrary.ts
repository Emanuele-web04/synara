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
import { useEffect, useRef, useState } from "react";

import { resolveWsHttpUrl } from "~/lib/wsHttpUrl";
import { readNativeApi } from "~/nativeApi";

const ROOT_DIRECTORY = "";

// Kept at module scope so no value blocks (ternaries, `?.`) live inside the
// try/catch bodies below — those trip React Compiler bailouts.
const libraryErrorMessage = (cause: unknown, fallback: string) =>
  cause instanceof Error ? cause.message : fallback;

const libraryUploadErrorMessage = (payload: unknown, status: number) => {
  const message = (payload as { readonly error?: unknown } | null)?.error;
  return typeof message === "string" ? message : `Library upload failed with status ${status}.`;
};

type NativeLibraryApi = NonNullable<ReturnType<typeof readNativeApi>>["projectAgent"]["library"];

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
  const [reloadNonce, setReloadNonce] = useState(0);
  const projectIdRef = useRef(input.projectId);
  const loadGeneration = useRef(0);
  const loadedDirs = useRef<ReadonlySet<string>>(new Set());

  const load = () => setReloadNonce((nonce) => nonce + 1);

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
  }, [input.enabled, input.projectId, reloadNonce]);

  const loadDirectory = async (relativePath: string | undefined) => {
    const api = readNativeApi();
    const projectId = projectIdRef.current;
    if (!api?.projectAgent || !projectId) return;
    const dir = relativePath ?? ROOT_DIRECTORY;
    const listArgs = relativePath === undefined ? { projectId } : { projectId, relativePath };
    try {
      const listed = await api.projectAgent.library.list(listArgs);
      if (projectIdRef.current !== projectId) return;
      setRoot(listed.root);
      setEntriesByDir((current) => new Map(current).set(dir, listed.entries));
      loadedDirs.current = new Set([...loadedDirs.current, dir]);
    } catch (cause) {
      if (projectIdRef.current !== projectId) return;
      setError(libraryErrorMessage(cause, "Failed to list the library."));
    }
  };

  const reloadLoadedDirectories = async () => {
    for (const dir of loadedDirs.current) {
      await loadDirectory(dir === ROOT_DIRECTORY ? undefined : dir);
    }
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
        await reloadLoadedDirectories();
        await refreshStatus(projectId);
        setError(null);
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

  const rename = async (from: string, to: string) =>
    runMutation(async (library, projectId) => {
      await library.rename({ projectId, from, to });
    });

  const deleteEntry = async (relativePath: string) =>
    runMutation(async (library, projectId) => {
      await library.delete({ projectId, relativePath });
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
      const payload = (await response.json().catch(() => null)) as unknown;
      if (projectIdRef.current === projectId) {
        if (!response.ok) {
          setError(libraryUploadErrorMessage(payload, response.status));
        } else {
          await reloadLoadedDirectories();
          await refreshStatus(projectId);
          setError(null);
          succeeded = true;
        }
      } else {
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
    setError,
  };
}
