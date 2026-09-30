// FILE: TaskInspectorProperties.tsx
// Purpose: The inspector's editable property list — priority, project, and due date, each a
//          labelled row whose value opens the same picker the task row uses.
// Layer: Tasks UI component
// Exports: TaskInspectorProperties

import type { ProjectId, Todo, TodoUpdateInput } from "@synara/contracts";
import type { ComponentProps } from "react";

import { Button } from "~/components/ui/button";
import { CalendarIcon, FolderIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { TaskPriorityGlyph } from "./TaskGlyphs";
import { TASK_PROPERTY_ICON_CLASS, TaskPropertyRow } from "./TaskInspectorPrimitives";
import { TaskDueMenu, TaskPriorityMenu, TaskProjectMenu } from "./TaskPropertyMenus";
import { formatDueLabel, todoPriorityLabel } from "./tasks.logic";

const PROPERTY_VALUE_CLASS =
  "h-7 w-fit max-w-full justify-start gap-1.5 px-2 text-ui font-normal text-foreground";

/** The button a property row shows its current value on; an unset value reads muted. */
function TaskPropertyValueButton({
  empty,
  overdue,
  className,
  ...props
}: ComponentProps<typeof Button> & { empty?: boolean | undefined; overdue?: boolean | undefined }) {
  return (
    <Button
      size="xs"
      variant="ghost"
      {...props}
      className={cn(
        PROPERTY_VALUE_CLASS,
        empty && "text-muted-foreground",
        overdue && "text-status-failure",
        className,
      )}
    />
  );
}

export function TaskInspectorProperties({
  todo,
  projectNameById,
  projectOptions,
  now,
  onUpdate,
}: {
  todo: Todo;
  projectNameById: ReadonlyMap<string, string>;
  projectOptions: ReadonlyArray<{ id: ProjectId; name: string }>;
  now: Date;
  onUpdate: (input: TodoUpdateInput) => void;
}) {
  const due = todo.dueDate ? formatDueLabel(todo.dueDate, now) : null;
  const projectName = todo.projectId ? (projectNameById.get(todo.projectId) ?? null) : null;

  return (
    <dl className="grid grid-cols-[5rem_minmax(0,1fr)] items-center gap-x-2 gap-y-1">
      <TaskPropertyRow label="Priority">
        <TaskPriorityMenu
          priority={todo.priority}
          onChange={(priority) => onUpdate({ id: todo.id, priority })}
          trigger={<TaskPropertyValueButton />}
        >
          <TaskPriorityGlyph priority={todo.priority} />
          {todoPriorityLabel(todo.priority)}
        </TaskPriorityMenu>
      </TaskPropertyRow>
      <TaskPropertyRow label="Project">
        <TaskProjectMenu
          projectId={todo.projectId}
          projectOptions={projectOptions}
          onChange={(projectId) => onUpdate({ id: todo.id, projectId })}
          trigger={<TaskPropertyValueButton empty={!projectName} />}
        >
          <FolderIcon aria-hidden className={TASK_PROPERTY_ICON_CLASS} />
          <span className="min-w-0 truncate">{projectName ?? "No project"}</span>
        </TaskProjectMenu>
      </TaskPropertyRow>
      <TaskPropertyRow label="Due">
        <TaskDueMenu
          dueDate={todo.dueDate}
          now={now}
          onChange={(dueDate) => onUpdate({ id: todo.id, dueDate })}
          trigger={<TaskPropertyValueButton empty={!due} overdue={due?.overdue} />}
        >
          <CalendarIcon aria-hidden className={TASK_PROPERTY_ICON_CLASS} />
          {due ? due.label : "No due date"}
        </TaskDueMenu>
      </TaskPropertyRow>
    </dl>
  );
}
