import type { ProjectReadFileResult } from "@synara/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";

import { projectReadFileQueryOptions, refetchFreshProjectFileQuery } from "~/lib/projectReactQuery";
import { refreshGitAfterFileWrite } from "~/lib/gitReactQuery";
import { useProjectFileChangeSubscription } from "./useProjectFileChangeSubscription";
import { getWorkspaceEditorSession } from "~/lib/workspaceEditorSession";
import {
  INITIAL_WORKSPACE_FILE_EDITOR_STATE,
  isWorkspaceFileEditorDirty,
  resolveWorkspaceFileEditorReadOnlyReason,
} from "~/lib/workspaceFileEditor";

export interface UseWorkspaceFileEditorInput {
  cwd: string | null;
  filePath: string | null;
  enabled: boolean;
}

const subscribeEmpty = () => () => undefined;
const readEmpty = () => INITIAL_WORKSPACE_FILE_EDITOR_STATE;

/** The preview already owns its file query (including path relocation). Both
 * entry points attach to the same canonical buffer and serialized writer. */
export function useWorkspaceFileEditorBuffer(
  input: UseWorkspaceFileEditorInput & {
    file: ProjectReadFileResult | undefined;
  },
) {
  const { cwd, enabled, file, filePath } = input;
  const client = useQueryClient();
  const relativePath = file?.relativePath ?? filePath;
  const session = useMemo(
    () =>
      enabled && cwd !== null && relativePath !== null
        ? getWorkspaceEditorSession(client, cwd, relativePath)
        : null,
    [client, cwd, enabled, relativePath],
  );
  const state = useSyncExternalStore(
    session?.subscribe ?? subscribeEmpty,
    session?.getSnapshot ?? readEmpty,
    readEmpty,
  );
  useEffect(() => {
    if (file) session?.load(file);
  }, [file, session]);
  const readOnlyReason = file === undefined ? null : resolveWorkspaceFileEditorReadOnlyReason(file);
  const flush = useCallback(() => session?.flush() ?? Promise.resolve(true), [session]);
  const reloadFromDisk = useCallback(() => {
    void session?.reload();
  }, [session]);
  const handleChange = useCallback((value: string) => session?.change(value), [session]);
  const save = useCallback(() => session?.save(), [session]);
  const overwrite = useCallback(() => session?.overwrite(), [session]);
  const pauseAutosave = useCallback(() => session?.pause(), [session]);
  const resumeAutosave = useCallback(() => session?.resume(), [session]);
  return {
    state,
    dirty: isWorkspaceFileEditorDirty(state),
    readOnlyReason,
    canEdit:
      session !== null && state.key !== null && file !== undefined && readOnlyReason === null,
    handleChange,
    save,
    overwrite,
    reloadFromDisk,
    flush,
    pauseAutosave,
    resumeAutosave,
  };
}

export function useWorkspaceFileEditor(input: UseWorkspaceFileEditorInput) {
  const client = useQueryClient();
  const fileQuery = useQuery(
    projectReadFileQueryOptions({
      cwd: input.cwd,
      relativePath: input.filePath,
      enabled: input.enabled,
    }),
  );
  const controller = useWorkspaceFileEditorBuffer({ ...input, file: fileQuery.data });
  const onFileChange = useCallback(() => {
    if (!input.cwd) return;
    void refetchFreshProjectFileQuery(client, { cwd: input.cwd, relativePath: input.filePath });
    void refreshGitAfterFileWrite(client, input.cwd).catch(() => undefined);
  }, [client, input.cwd, input.filePath]);
  useProjectFileChangeSubscription({
    cwd: input.cwd,
    relativePath: fileQuery.data?.relativePath ?? null,
    enabled: input.enabled,
    onChange: onFileChange,
  });
  return {
    ...controller,
    loading: fileQuery.isLoading,
    loadError:
      fileQuery.error instanceof Error
        ? fileQuery.error.message
        : fileQuery.error
          ? "Could not read file."
          : null,
  };
}

export type WorkspaceFileEditorController = ReturnType<typeof useWorkspaceFileEditor>;
