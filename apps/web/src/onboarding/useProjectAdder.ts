// FILE: useProjectAdder.ts
// Purpose: First-project actions for the onboarding's last step: browse (desktop), drop a
//          folder anywhere in the window, or submit a typed path. Every route goes through
//          the shared create-or-recover flow.
// Layer: Web UI hook

import type { ProjectId } from "@synara/contracts";
import { useEffect, useState } from "react";

import { useAppSettings } from "~/appSettings";
import { isElectron } from "~/env";
import { useWindowFolderDrop } from "~/hooks/useWindowFolderDrop";
import { useTranslation } from "~/i18n";
import { createOrRecoverProjectFromPath } from "~/lib/projectCreation";
import { expandProjectHomePath } from "~/lib/projectPaths";
import { readNativeApi } from "~/nativeApi";
import { useStore } from "~/store";
import { useWorkspacePathsStore } from "~/workspacePathsStore";

export interface OnboardingProjectResult {
  readonly projectId: ProjectId;
  readonly workspaceRoot: string;
  readonly created: boolean;
}

export function useProjectAdder(props: {
  readonly onResult: (result: OnboardingProjectResult) => void;
  /** Project creation is not abortable; the dialog blocks navigation while it runs. */
  readonly onBusyChange: (busy: boolean) => void;
}) {
  const { settings } = useAppSettings();
  const { t } = useTranslation();
  const homeDir = useWorkspacePathsStore((store) => store.homeDir);
  const syncServerShellSnapshot = useStore((store) => store.syncServerShellSnapshot);
  const [picking, setPicking] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { onBusyChange } = props;
  const busy = picking || submitting;
  useEffect(() => {
    onBusyChange(busy);
  }, [busy, onBusyChange]);
  useEffect(() => () => onBusyChange(false), [onBusyChange]);

  const addProject = async (rawPath: string): Promise<boolean> => {
    const api = readNativeApi();
    const workspaceRoot = expandProjectHomePath(rawPath.trim(), homeDir);
    if (!api || workspaceRoot.length === 0) return false;
    setSubmitting(true);
    setError(null);
    try {
      const result = await createOrRecoverProjectFromPath({
        api,
        workspaceRoot,
        // Files the project in Void; the sidebar follows it once the tour closes.
        spaceId: null,
        defaultProvider: settings.defaultProvider,
        loadSnapshot: () => api.orchestration.getShellSnapshot().catch(() => null),
      });
      if (result.snapshot) {
        syncServerShellSnapshot(result.snapshot);
      }
      props.onResult({
        projectId: result.projectId,
        workspaceRoot: result.project?.workspaceRoot ?? workspaceRoot,
        created: result.created,
      });
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("onboarding:couldNotAddTheProject"));
      return false;
    } finally {
      setSubmitting(false);
    }
  };

  const browse = async () => {
    const api = readNativeApi();
    if (!api || busy) return;
    setPicking(true);
    setError(null);
    try {
      const picked = await api.dialogs.pickFolder();
      if (picked) {
        await addProject(picked);
      }
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : t("onboarding:couldNotOpenTheFolderPicker"),
      );
    } finally {
      setPicking(false);
    }
  };

  const isDropTarget = useWindowFolderDrop({
    enabled: isElectron && !busy,
    onFolder: (dropped) => void addProject(dropped),
    onError: setError,
  });

  return {
    addProject,
    browse,
    busy,
    picking,
    submitting,
    error,
    clearError: () => setError(null),
    isDropTarget,
    homeDir,
  };
}
