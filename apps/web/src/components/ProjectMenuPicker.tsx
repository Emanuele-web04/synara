// FILE: ProjectMenuPicker.tsx
// Purpose: Shared menu-based project picker keyed by ProjectId. Single source for
//          the project radio menu used by the kanban new-task dialog and the
//          editor top-bar project switcher.
// Layer: Web UI component

import type { ProjectId } from "@synara/contracts";
import type { ReactElement, ReactNode } from "react";

import { ComposerPickerMenuPopup } from "~/components/chat/ComposerPickerMenuPopup";
import { Menu, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "~/components/ui/menu";

export interface ProjectMenuPickerOption {
  readonly id: ProjectId;
  readonly name: string;
}

export function ProjectMenuPicker(props: {
  projectOptions: ReadonlyArray<ProjectMenuPickerOption>;
  selectedProjectId: ProjectId | null;
  onProjectIdChange: (projectId: ProjectId) => void;
  /** Rendered through MenuTrigger's `render` slot so each surface owns its trigger chrome. */
  trigger: ReactElement;
  /** Content merged into the trigger element (label, chevron, …). */
  children?: ReactNode;
  align?: "start" | "center" | "end";
  popupClassName?: string;
}) {
  const { onProjectIdChange, projectOptions, selectedProjectId } = props;

  return (
    <Menu>
      <MenuTrigger render={props.trigger}>{props.children}</MenuTrigger>
      <ComposerPickerMenuPopup
        align={props.align ?? "start"}
        className={props.popupClassName ?? "min-w-52"}
      >
        <MenuRadioGroup
          value={selectedProjectId ?? ""}
          onValueChange={(value) => {
            // Re-selecting the active project must stay a no-op so the menu
            // never navigates the caller away from its current context.
            if (value === selectedProjectId) {
              return;
            }
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
