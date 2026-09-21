import type { ProjectId } from "@synara/contracts";

import { ProjectMenuPicker } from "~/components/ProjectMenuPicker";
import { Button } from "~/components/ui/button";
import { ChevronDownIcon } from "~/lib/icons";

interface KanbanTaskProjectOption {
  readonly id: ProjectId;
  readonly name: string;
}

interface KanbanTaskProjectPickerProps {
  readonly projectOptions: ReadonlyArray<KanbanTaskProjectOption>;
  readonly selectedProjectId: ProjectId | null;
  readonly onProjectIdChange: (projectId: ProjectId) => void;
}

export function KanbanTaskProjectPicker({
  projectOptions,
  selectedProjectId,
  onProjectIdChange,
}: KanbanTaskProjectPickerProps) {
  const selectedProjectOption =
    projectOptions.find((option) => option.id === selectedProjectId) ?? null;

  return (
    <ProjectMenuPicker
      projectOptions={projectOptions}
      selectedProjectId={selectedProjectId}
      onProjectIdChange={onProjectIdChange}
      trigger={
        <Button
          size="xs"
          variant="chrome-outline"
          disabled={projectOptions.length === 0}
          aria-label="Choose the project for this task"
          // override the xs variant's size so the project name matches the 12px "New task" title
          className="max-w-56 gap-1.5 font-medium text-ui text-[var(--color-text-foreground)] sm:text-ui"
        />
      }
    >
      <span className="min-w-0 truncate">{selectedProjectOption?.name ?? "No project"}</span>
      <ChevronDownIcon aria-hidden className="size-3 shrink-0 opacity-60" />
    </ProjectMenuPicker>
  );
}
