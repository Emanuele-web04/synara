// FILE: KanbanTaskProjectPicker.tsx
// Purpose: Header project picker for the kanban new-task dialog.
// Layer: Kanban UI component
// Exports: KanbanTaskProjectPicker

import type { ProjectId } from "@t3tools/contracts";

import { ComposerPickerMenuPopup } from "~/components/chat/ComposerPickerMenuPopup";
import { Button } from "~/components/ui/button";
import { Menu, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "~/components/ui/menu";
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
    <Menu>
      <MenuTrigger
        render={
          <Button
            size="xs"
            variant="chrome-outline"
            disabled={projectOptions.length === 0}
            aria-label="Choose the project for this task"
            // Override the xs size variant's sm:10px so the project name matches
            // the 12px "New task" title instead of reading smaller.
            className="max-w-56 gap-1.5 font-medium text-[length:var(--app-font-size-ui,12px)] text-[var(--color-text-foreground)] sm:text-[length:var(--app-font-size-ui,12px)]"
          />
        }
      >
        <span className="min-w-0 truncate">{selectedProjectOption?.name ?? "No project"}</span>
        <ChevronDownIcon aria-hidden className="size-3 shrink-0 opacity-60" />
      </MenuTrigger>
      <ComposerPickerMenuPopup align="start" className="min-w-52">
        <MenuRadioGroup
          value={selectedProjectId ?? ""}
          onValueChange={(value) => {
            const option = projectOptions.find((candidate) => candidate.id === value);
            if (option) {
              onProjectIdChange(option.id);
            }
          }}
        >
          {projectOptions.map((option) => (
            <MenuRadioItem key={option.id} value={option.id}>
              {option.name}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </ComposerPickerMenuPopup>
    </Menu>
  );
}
