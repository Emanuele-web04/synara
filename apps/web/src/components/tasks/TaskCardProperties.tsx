// FILE: TaskCardProperties.tsx
// Purpose: The task card's row of property pills — due day, project, priority — each one
//          opening the same picker the rest of Tasks uses.
// Layer: Tasks UI component
// Exports: TaskCardProperties

import type { ProjectId, Todo, TodoUpdateInput } from "@synara/contracts";

import { CalendarIcon, FolderIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { TaskPillButton } from "./TaskCardPrimitives";
import { TaskPriorityGlyph } from "./TaskGlyphs";
import { TaskDueMenu, TaskPriorityMenu, TaskProjectMenu } from "./TaskPropertyMenus";
import { formatDueLabel, todoPriorityLabel } from "./tasks.logic";

const PILL_ICON_CLASS = "size-3.5 shrink-0 opacity-70";

export function TaskCardProperties({
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
    <div className="flex flex-wrap gap-1.5">
      <TaskDueMenu
        dueDate={todo.dueDate}
        now={now}
        onChange={(dueDate) => onUpdate({ id: todo.id, dueDate })}
        trigger={
          <TaskPillButton
            aria-label={due ? `Due ${due.label}` : "Set a due day"}
            className={cn(due?.overdue && "text-status-failure hover:text-status-failure")}
          />
        }
      >
        <CalendarIcon aria-hidden className={PILL_ICON_CLASS} />
        {due ? due.label : "No date"}
      </TaskDueMenu>
      <TaskProjectMenu
        projectId={todo.projectId}
        projectOptions={projectOptions}
        onChange={(projectId) => onUpdate({ id: todo.id, projectId })}
        trigger={
          <TaskPillButton aria-label={projectName ? `Project: ${projectName}` : "Set a project"} />
        }
      >
        <FolderIcon aria-hidden className={PILL_ICON_CLASS} />
        <span className="max-w-40 truncate">{projectName ?? "No project"}</span>
      </TaskProjectMenu>
      <TaskPriorityMenu
        priority={todo.priority}
        onChange={(priority) => onUpdate({ id: todo.id, priority })}
        trigger={<TaskPillButton aria-label={`Priority: ${todoPriorityLabel(todo.priority)}`} />}
      >
        <TaskPriorityGlyph priority={todo.priority} />
        {todo.priority === "none" ? "Priority" : todoPriorityLabel(todo.priority)}
      </TaskPriorityMenu>
    </div>
  );
}
