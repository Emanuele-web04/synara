// FILE: RelocateProjectDialog.tsx
// Purpose: Reconnects an imported project to a restored/moved folder without recreating chats.
// Layer: Sidebar UI

import { useState } from "react";
import type { ProjectId } from "@synara/contracts";
import { useQueryClient } from "@tanstack/react-query";

import { ensureNativeApi } from "../nativeApi";
import { relocateProjectFromClient } from "../lib/projectRelocation";
import { hasUnsavedWorkspaceEditors } from "../lib/workspaceEditorSession";
import { RenameDialog } from "./RenameDialog";
import { toastManager } from "./ui/toast";
import { useTranslation } from "~/i18n";

export function RelocateProjectDialog(props: {
  projectId: ProjectId;
  workspaceRoot: string;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();

  const queryClient = useQueryClient();
  const [originalWorkspaceRoot] = useState(props.workspaceRoot);
  return (
    <RenameDialog
      open
      title={t("workspace:changeProjectPath")}
      description={t("workspace:enterTheRestoredFolderSPathOnTheSynara")}
      initialValue={originalWorkspaceRoot}
      saveLabel={t("workspace:changePath")}
      onOpenChange={props.onOpenChange}
      onSave={async (workspaceRoot) => {
        try {
          if (hasUnsavedWorkspaceEditors(queryClient)) {
            throw new Error("Save or discard unsaved file edits before changing a project path.");
          }
          await relocateProjectFromClient(ensureNativeApi().orchestration, {
            projectId: props.projectId,
            previousWorkspaceRoot: originalWorkspaceRoot,
            workspaceRoot,
          });
          toastManager.add({
            type: "success",
            title: t("workspace:projectPathUpdated"),
            description: t("workspace:continueInYourExistingThreadsABlockedThreadMay"),
          });
        } catch (error) {
          toastManager.add({
            type: "error",
            title: t("workspace:couldNotChangeProjectPath"),
            description:
              error instanceof Error ? error.message : t("workspace:anUnknownErrorOccurred"),
          });
          throw error;
        }
      }}
    />
  );
}
