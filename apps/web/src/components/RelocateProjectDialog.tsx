import { useState } from "react";
import type { ProjectId } from "@synara/contracts";
import { useQueryClient } from "@tanstack/react-query";

import { ensureNativeApi } from "../nativeApi";
import { relocateProjectFromClient } from "../lib/projectRelocation";
import { hasUnsavedWorkspaceEditors } from "../lib/workspaceEditorSession";
import { RenameDialog } from "./RenameDialog";
import { toastManager } from "./ui/toast";

export function RelocateProjectDialog(props: {
  projectId: ProjectId;
  workspaceRoot: string;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [originalWorkspaceRoot] = useState(props.workspaceRoot);
  return (
    <RenameDialog
      open
      title="Change project path"
      description="Enter the restored folder's path on the Synara server. Your existing project and conversations stay in place. This does not recover lost files or move/repair linked Git worktrees. Finish active turns first."
      initialValue={originalWorkspaceRoot}
      saveLabel="Change path"
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
            title: "Project path updated",
            description:
              "Continue in your existing threads. A blocked thread may still require its explicit Unblock action.",
          });
        } catch (error) {
          toastManager.add({
            type: "error",
            title: "Could not change project path",
            description: error instanceof Error ? error.message : "An unknown error occurred.",
          });
          throw error;
        }
      }}
    />
  );
}
