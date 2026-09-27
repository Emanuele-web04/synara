// FILE: TaskPropertyMenus.tsx
// Purpose: The to-do property pickers (priority, project, due date) shared by the task
//          row and the task inspector — each surface supplies its own trigger chrome.
// Layer: Tasks UI component
// Exports: TaskPriorityMenu, TaskProjectMenu, TaskDueMenu

import type { ProjectId, TodoDueDate, TodoPriority } from "@synara/contracts";
import type { ReactElement, ReactNode } from "react";

import { ProjectMenuPicker } from "~/components/ProjectMenuPicker";
import { ComposerPickerMenuPopup } from "~/components/chat/ComposerPickerMenuPopup";
import { Menu, MenuItem, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "~/components/ui/menu";
import { TaskPriorityGlyph } from "./TaskGlyphs";
import { DUE_PRESET_OPTIONS, resolveDuePreset, TODO_PRIORITY_OPTIONS } from "./tasks.logic";

export function TaskPriorityMenu({
  priority,
  onChange,
  trigger,
  children,
  align = "start",
}: {
  priority: TodoPriority;
  onChange: (priority: TodoPriority) => void;
  trigger: ReactElement;
  children: ReactNode;
  align?: "start" | "end";
}) {
  return (
    <Menu>
      <MenuTrigger render={trigger}>{children}</MenuTrigger>
      <ComposerPickerMenuPopup align={align} className="min-w-40">
        <MenuRadioGroup value={priority} onValueChange={(value) => onChange(value as TodoPriority)}>
          {TODO_PRIORITY_OPTIONS.map((option) => (
            <MenuRadioItem key={option.value} value={option.value} closeOnClick>
              <span className="flex items-center gap-2">
                <TaskPriorityGlyph priority={option.value} />
                {option.label}
              </span>
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </ComposerPickerMenuPopup>
    </Menu>
  );
}

export function TaskProjectMenu({
  projectId,
  projectOptions,
  onChange,
  trigger,
  children,
  align = "start",
}: {
  projectId: ProjectId | null;
  projectOptions: ReadonlyArray<{ id: ProjectId; name: string }>;
  onChange: (projectId: ProjectId | null) => void;
  trigger: ReactElement;
  children: ReactNode;
  align?: "start" | "end";
}) {
  return (
    <ProjectMenuPicker
      projectOptions={projectOptions}
      selectedProjectId={projectId}
      onProjectIdChange={onChange}
      noneOption={{ label: "No project", onSelect: () => onChange(null) }}
      closeOnSelect
      align={align}
      trigger={trigger}
    >
      {children}
    </ProjectMenuPicker>
  );
}

export function TaskDueMenu({
  dueDate,
  now,
  onChange,
  trigger,
  children,
  align = "start",
}: {
  dueDate: TodoDueDate | null;
  now: Date;
  onChange: (dueDate: TodoDueDate | null) => void;
  trigger: ReactElement;
  children: ReactNode;
  align?: "start" | "end";
}) {
  return (
    <Menu>
      <MenuTrigger render={trigger}>{children}</MenuTrigger>
      <ComposerPickerMenuPopup align={align} className="min-w-36">
        {DUE_PRESET_OPTIONS.map((option) => (
          <MenuItem
            key={option.value}
            onClick={() => onChange(resolveDuePreset(option.value, now))}
          >
            {option.label}
          </MenuItem>
        ))}
        {dueDate ? <MenuItem onClick={() => onChange(null)}>No due date</MenuItem> : null}
      </ComposerPickerMenuPopup>
    </Menu>
  );
}
