// FILE: TaskDelegateTargetPicker.tsx
// Purpose: The delegate form's "Run in" control: a project menu plus a native folder
//          picker, for chats that start in a project or in a bare folder.
// Layer: Tasks UI component
// Exports: TaskDelegateTargetPicker

import { ProjectMenuPicker } from "~/components/ProjectMenuPicker";
import { Button } from "~/components/ui/button";
import { ChevronDownIcon, FolderIcon } from "~/lib/icons";
import { readNativeApi } from "../../nativeApi";
import { folderLabel } from "./tasks.logic";
import type { TaskDelegateTargetState } from "./useTaskDelegateTarget";

export function TaskDelegateTargetPicker({ runIn }: { runIn: TaskDelegateTargetState }) {
  const { target, setTarget, projectOptions, targetProject } = runIn;

  const handleChooseFolder = async () => {
    const path = await readNativeApi()?.dialogs.pickFolder();
    if (path) {
      setTarget({ kind: "folder", path });
    }
  };

  return (
    <div className="flex min-w-0 items-center gap-1">
      <ProjectMenuPicker
        projectOptions={projectOptions}
        selectedProjectId={target?.kind === "project" ? target.projectId : null}
        onProjectIdChange={(projectId) => setTarget({ kind: "project", projectId })}
        closeOnSelect
        trigger={
          <Button
            size="xs"
            variant="chrome"
            className="min-w-0 max-w-44 justify-start gap-1.5 text-ui-sm"
          />
        }
      >
        <FolderIcon aria-hidden className="size-3.5 shrink-0 opacity-70" />
        <span className="min-w-0 truncate">
          {target?.kind === "folder"
            ? folderLabel(target.path)
            : (targetProject?.name ?? "Choose a project")}
        </span>
        <ChevronDownIcon aria-hidden className="size-3 shrink-0 opacity-60" />
      </ProjectMenuPicker>
      <Button
        size="xs"
        variant="ghost"
        className="shrink-0 text-ui-sm text-muted-foreground"
        onClick={() => void handleChooseFolder()}
        title={target?.kind === "folder" ? target.path : undefined}
      >
        Folder…
      </Button>
    </div>
  );
}
