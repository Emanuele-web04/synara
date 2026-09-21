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
  projectIdRef.current = input.projectId;

  const stillCurrent = (projectId: ProjectId, generation: number) =>
    projectIdRef.current === projectId && loadGeneration.current === generation;

  const reset = useCallback(() => {
    setRoot(null);
    setEntriesByDir(new Map());
    setStatus(null);
    loadedDirs.current = new Set();
  }, []);

  const loadDirectory = useCallback(async (relativePath: string | undefined) => {
    const api = readNativeApi();
    const projectId = projectIdRef.current;
    if (!api?.projectAgent || !projectId) return;
    const dir = relativePath ?? ROOT_DIRECTORY;
    try {
      const listed = await api.projectAgent.library.list({
        projectId,
        ...(relativePath !== undefined ? { relativePath } : {}),
      });
      if (projectIdRef.current !== projectId) return;
      setRoot(listed.root);
      setEntriesByDir((current) => new Map(current).set(dir, listed.entries));
      loadedDirs.current = new Set([...loadedDirs.current, dir]);
    } catch (cause) {
      if (projectIdRef.current !== projectId) return;
      setError(cause instanceof Error ? cause.message : "Failed to list the library.");
    }
  }, []);

  const reloadLoadedDirectories = useCallback(async () => {
    for (const dir of loadedDirs.current) {
      await loadDirectory(dir === ROOT_DIRECTORY ? undefined : dir);
    }
  }, [loadDirectory]);

  const load = useCallback(async () => {
    const api = readNativeApi();
    const projectId = projectIdRef.current;
    const generation = ++loadGeneration.current;
    if (!api?.projectAgent || !projectId) {
      reset();
      return;
    }
    loadedDirs.current = new Set();
    setEntriesByDir(new Map());
    try {
      const [listed, nextStatus] = await Promise.all([
        api.projectAgent.library.list({ projectId }),
        api.projectAgent.library.status({ projectId }),
      ]);
      if (!stillCurrent(projectId, generation)) return;
      setRoot(listed.root);
      setStatus(nextStatus);
      setEntriesByDir(new Map([[ROOT_DIRECTORY, listed.entries]]));
      loadedDirs.current = new Set([ROOT_DIRECTORY]);
      setError(null);
    } catch (cause) {
      if (!stillCurrent(projectId, generation)) return;
      setError(cause instanceof Error ? cause.message : "Failed to load the library.");
    }
  }, [reset]);

  useEffect(() => {
    if (!input.enabled || !input.projectId) {
      reset();
      return;
    }
    void load();
  }, [input.enabled, input.projectId, load, reset]);

  const runMutation = useCallback(
    async (
      work: (
        api: NonNullable<ReturnType<typeof readNativeApi>>["projectAgent"]["library"],
        projectId: ProjectId,
      ) => Promise<void>,
    ) => {
      const api = readNativeApi();
      const projectId = projectIdRef.current;
      if (!api?.projectAgent || !projectId) return false;
      setBusy(true);
      try {
        await work(api.projectAgent.library, projectId);
        if (projectIdRef.current !== projectId) return true;
        await reloadLoadedDirectories();
        try {
          setStatus(await api.projectAgent.library.status({ projectId }));
        } catch {
          // A failed status refresh must not mask the mutation result.
        }
        return true;
      } catch (cause) {
        if (projectIdRef.current === projectId) {
          setError(cause instanceof Error ? cause.message : "Library action failed.");
        }
        return false;
      } finally {
        if (projectIdRef.current === projectId) setBusy(false);
      }
    },
    [reloadLoadedDirectories],
  );

  const mkdir = useCallback(
    async (relativePath: string) =>
      runMutation(async (library, projectId) => {
        await library.mkdir({ projectId, relativePath });
      }),
    [runMutation],
  );

  const rename = useCallback(
    async (from: string, to: string) =>
      runMutation(async (library, projectId) => {
        await library.rename({ projectId, from, to });
      }),
    [runMutation],
  );

  const deleteEntry = useCallback(
    async (relativePath: string) =>
      runMutation(async (library, projectId) => {
        await library.delete({ projectId, relativePath });
      }),
    [runMutation],
  );

  const history = useCallback(async (relativePath?: string) => {
    const api = readNativeApi();
    const projectId = projectIdRef.current;
    if (!api?.projectAgent || !projectId) return [] as readonly LibraryCommit[];
    try {
      const result = await api.projectAgent.library.history({
        projectId,
        ...(relativePath !== undefined ? { relativePath } : {}),
      });
      return result.commits;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to load library history.");
      return [] as readonly LibraryCommit[];
    }
  }, []);

  const restore = useCallback(
    async (relativePath: string, sha: string) =>
      runMutation(async (library, projectId) => {
        await library.restore({ projectId, relativePath, sha });
      }),
    [runMutation],
  );

  const upload = useCallback(
    async (relativeDirectory: string | undefined, file: File) => {
      const projectId = projectIdRef.current;
      if (!projectId) return false;
      const params = new URLSearchParams({
        projectId,
        name: file.name,
        mimeType: file.type || "application/octet-stream",
      });
      if (relativeDirectory) params.set("relativePath", relativeDirectory);
      setBusy(true);
      try {
        const response = await fetch(
          resolveWsHttpUrl(`${LIBRARY_UPLOAD_ROUTE_PATH}?${params.toString()}`),
          {
            method: "POST",
            credentials: "include",
            body: file,
          },
        );
        const payload = (await response.json().catch(() => null)) as {
          readonly error?: unknown;
        } | null;
        if (!response.ok) {
          const message =
            payload && typeof payload.error === "string"
              ? payload.error
              : `Library upload failed with status ${response.status}.`;
          throw new Error(message);
        }
        if (projectIdRef.current !== projectId) return true;
        await reloadLoadedDirectories();
        const api = readNativeApi();
        if (api?.projectAgent) {
          try {
            setStatus(await api.projectAgent.library.status({ projectId }));
          } catch {
            // status refresh failure must not mask a successful upload
          }
        }
        return true;
      } catch (cause) {
        if (projectIdRef.current === projectId) {
          setError(cause instanceof Error ? cause.message : "Library upload failed.");
        }
        return false;
      } finally {
        if (projectIdRef.current === projectId) setBusy(false);
      }
    },
    [reloadLoadedDirectories],
  );

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
