import { isWorkspaceFileWriteConflictError } from "@synara/shared/workspaceFileWrite";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useReducer, useRef } from "react";

import { invalidateGitQueriesForCwds } from "~/lib/gitReactQuery";
import {
  invalidateProjectFileQueriesForCwds,
  projectReadFileQueryOptions,
} from "~/lib/projectReactQuery";
import { sha256Hex } from "~/lib/sha256";
import {
  INITIAL_WORKSPACE_FILE_EDITOR_STATE,
  isWorkspaceFileEditorDirty,
  workspaceFileEditorKey,
  workspaceFileEditorReducer,
  type WorkspaceFileEditorState,
} from "~/lib/workspaceFileEditor";
import { ensureNativeApi } from "~/nativeApi";

export interface UseWorkspaceFileEditorInput {
  cwd: string | null;
  filePath: string | null;
  enabled: boolean;
}

export interface WorkspaceFileEditorController {
  state: WorkspaceFileEditorState;
  dirty: boolean;
  loading: boolean;
  loadError: string | null;
  truncated: boolean;
  canEdit: boolean;
  handleChange: (value: string) => void;
  save: () => void;
  overwrite: () => void;
  reloadFromDisk: () => void;
  dismissConflict: () => void;
}

export function useWorkspaceFileEditor(
  input: UseWorkspaceFileEditorInput,
): WorkspaceFileEditorController {
  const { cwd, enabled, filePath } = input;
  const queryClient = useQueryClient();
  const [state, dispatch] = useReducer(
    workspaceFileEditorReducer,
    INITIAL_WORKSPACE_FILE_EDITOR_STATE,
  );
  const editorKey = workspaceFileEditorKey(cwd, filePath);
  const queryOptions = projectReadFileQueryOptions({
    cwd,
    relativePath: filePath,
    enabled: enabled && cwd !== null && filePath !== null,
  });
  const fileQuery = useQuery(queryOptions);
  const contents = fileQuery.data?.contents ?? null;
  const truncated = fileQuery.data?.truncated ?? false;
  const resolvedRelativePath = fileQuery.data?.relativePath ?? filePath;
  const stateRef = useRef(state);
  stateRef.current = state;
  const resolvedRelativePathRef = useRef(resolvedRelativePath);
  resolvedRelativePathRef.current = resolvedRelativePath;
  const truncatedRef = useRef(truncated);
  truncatedRef.current = truncated;

  useEffect(() => {
    if (editorKey === null || contents === null || truncated) {
      return;
    }
    let cancelled = false;
    void sha256Hex(contents).then((sha256) => {
      if (!cancelled) {
        dispatch({ type: "loaded", key: editorKey, contents, sha256 });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [contents, editorKey, truncated]);

  useEffect(() => {
    if (editorKey === null) {
      dispatch({ type: "closed" });
    }
  }, [editorKey]);

  const handleChange = useCallback((value: string) => {
    dispatch({ type: "changed", value });
  }, []);

  const writeContents = useCallback(
    async (options: { useExpectedHash: boolean }) => {
      const current = stateRef.current;
      const relativePath = resolvedRelativePathRef.current;
      if (
        cwd === null ||
        relativePath === null ||
        current.key === null ||
        current.saving ||
        truncatedRef.current
      ) {
        return;
      }
      const nextContents = current.value;
      dispatch({ type: "saveStarted" });
      try {
        const api = ensureNativeApi();
        await api.projects.writeFile({
          cwd,
          relativePath,
          contents: nextContents,
          ...(options.useExpectedHash && current.baselineSha256.length > 0
            ? { expectedContentsSha256: current.baselineSha256 }
            : {}),
        });
        const sha256 = await sha256Hex(nextContents);
        dispatch({ type: "saveSucceeded", contents: nextContents, sha256 });
        queryClient.setQueryData(queryOptions.queryKey, (previous) =>
          previous ? { ...previous, contents: nextContents } : previous,
        );
        await Promise.all([
          invalidateGitQueriesForCwds(queryClient, [cwd]),
          invalidateProjectFileQueriesForCwds(queryClient, [cwd]),
        ]);
      } catch (error) {
        dispatch({
          type: "saveFailed",
          message: error instanceof Error ? error.message : "Could not save the file.",
          conflict: isWorkspaceFileWriteConflictError(error),
        });
      }
    },
    [cwd, queryClient, queryOptions.queryKey],
  );

  const save = useCallback(() => {
    void writeContents({ useExpectedHash: true });
  }, [writeContents]);

  const overwrite = useCallback(() => {
    void writeContents({ useExpectedHash: false });
  }, [writeContents]);

  const reloadFromDisk = useCallback(() => {
    if (editorKey === null) {
      return;
    }
    void queryClient
      .fetchQuery({ ...queryOptions, staleTime: 0 })
      .then(async (result) => {
        dispatch({
          type: "reloaded",
          key: editorKey,
          contents: result.contents,
          sha256: await sha256Hex(result.contents),
        });
      })
      .catch((error: unknown) => {
        dispatch({
          type: "saveFailed",
          message: error instanceof Error ? error.message : "Could not reload the file.",
          conflict: false,
        });
      });
  }, [editorKey, queryClient, queryOptions]);

  const dismissConflict = useCallback(() => {
    dispatch({ type: "conflictDismissed" });
  }, []);

  return {
    state,
    dirty: isWorkspaceFileEditorDirty(state),
    loading: fileQuery.isLoading,
    loadError:
      fileQuery.error instanceof Error
        ? fileQuery.error.message
        : fileQuery.error
          ? "Could not read file."
          : null,
    truncated,
    canEdit: state.key !== null && state.key === editorKey && !truncated,
    handleChange,
    save,
    overwrite,
    reloadFromDisk,
    dismissConflict,
  };
}
