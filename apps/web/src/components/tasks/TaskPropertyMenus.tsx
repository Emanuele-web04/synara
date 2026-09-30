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

/** What every property picker takes besides its own value: the trigger it opens from. */
interface TaskPropertyMenuProps {
  trigger: ReactElement;
  /** What the trigger shows — the property's current value. */
  children: ReactNode;
  align?: "start" | "end" | undefined;
}

function TaskPropertyMenu({
  trigger,
  triggerContent,
  align,
  popupClassName,
  children,
}: {
  trigger: ReactElement;
  triggerContent: ReactNode;
  align: "start" | "end" | undefined;
  popupClassName: string;
  children: ReactNode;
}) {
  return (
    <Menu>
      <MenuTrigger render={trigger}>{triggerContent}</MenuTrigger>
      <ComposerPickerMenuPopup align={align ?? "start"} className={popupClassName}>
        {children}
      </ComposerPickerMenuPopup>
    </Menu>
  );
}

export function TaskPriorityMenu({
  priority,
  onChange,
  trigger,
  children,
  align,
}: TaskPropertyMenuProps & {
  priority: TodoPriority;
  onChange: (priority: TodoPriority) => void;
}) {
  return (
    <TaskPropertyMenu
      trigger={trigger}
      triggerContent={children}
      align={align}
      popupClassName="min-w-40"
    >
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
    </TaskPropertyMenu>
  );
}

export function TaskProjectMenu({
  projectId,
  projectOptions,
  onChange,
  trigger,
  children,
  align,
}: TaskPropertyMenuProps & {
  projectId: ProjectId | null;
  projectOptions: ReadonlyArray<{ id: ProjectId; name: string }>;
  onChange: (projectId: ProjectId | null) => void;
}) {
  return (
    <ProjectMenuPicker
      projectOptions={projectOptions}
      selectedProjectId={projectId}
      onProjectIdChange={onChange}
      noneOption={{ label: "No project", onSelect: () => onChange(null) }}
      closeOnSelect
      align={align ?? "start"}
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
  align,
}: TaskPropertyMenuProps & {
  dueDate: TodoDueDate | null;
  now: Date;
  onChange: (dueDate: TodoDueDate | null) => void;
}) {
  return (
    <TaskPropertyMenu
      trigger={trigger}
      triggerContent={children}
      align={align}
      popupClassName="min-w-36"
    >
      {DUE_PRESET_OPTIONS.map((option) => (
        <MenuItem key={option.value} onClick={() => onChange(resolveDuePreset(option.value, now))}>
          {option.label}
        </MenuItem>
      ))}
      {dueDate ? <MenuItem onClick={() => onChange(null)}>No due date</MenuItem> : null}
    </TaskPropertyMenu>
  );
}
