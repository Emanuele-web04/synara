// FILE: TaskCardProperties.tsx
// Purpose: The task card's row of property pills — due day, project, priority — each one
//          opening the same picker the rest of Tasks uses. A property that is set shows its
//          value; an unset one is just its icon, so an empty to-do stays quiet.
// Layer: Tasks UI component
// Exports: TaskCardProperties

import type { ProjectId, Todo, TodoUpdateInput } from "@synara/contracts";

import { CalendarIcon, FolderIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { TaskPillButton } from "./TaskCardPrimitives";
import { TaskPriorityGlyph } from "./TaskGlyphs";
import { TaskDueMenu, TaskPriorityMenu, TaskProjectMenu } from "./TaskPropertyMenus";
import { formatDueLabel, todoPriorityLabel } from "./tasks.logic";
import { useTranslation } from "~/i18n";

const PILL_ICON_CLASS = "size-3.5 shrink-0 opacity-70";
/** An unset property: a round icon-only pill. */
const EMPTY_PILL_CLASS = "w-7 px-0 sm:w-6";

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
  const { t, formatLocale } = useTranslation();

  const due = todo.dueDate ? formatDueLabel(todo.dueDate, now, t, formatLocale) : null;
  const projectName = todo.projectId ? (projectNameById.get(todo.projectId) ?? null) : null;

  return (
    <div className="flex flex-wrap gap-1.5">
      <TaskDueMenu
        dueDate={todo.dueDate}
        now={now}
        onChange={(dueDate) => onUpdate({ id: todo.id, dueDate })}
        trigger={
          <TaskPillButton
            aria-label={due ? t("common:due", { value0: due.label }) : t("common:setADueDay")}
            title={due ? undefined : t("common:dueDay")}
            className={cn(
              !due && EMPTY_PILL_CLASS,
              due?.overdue && "text-status-failure hover:text-status-failure",
            )}
          />
        }
      >
        <CalendarIcon aria-hidden className={PILL_ICON_CLASS} />
        {due?.label}
      </TaskDueMenu>
      <TaskProjectMenu
        projectId={todo.projectId}
        projectOptions={projectOptions}
        onChange={(projectId) => onUpdate({ id: todo.id, projectId })}
        trigger={
          <TaskPillButton
            aria-label={
              projectName ? t("git:project", { value0: projectName }) : t("common:setAProject")
            }
            title={projectName ? undefined : t("chat:detail_project")}
            className={cn(!projectName && EMPTY_PILL_CLASS)}
          />
        }
      >
        <FolderIcon aria-hidden className={PILL_ICON_CLASS} />
        {projectName ? <span className="max-w-40 truncate">{projectName}</span> : null}
      </TaskProjectMenu>
      <TaskPriorityMenu
        priority={todo.priority}
        onChange={(priority) => onUpdate({ id: todo.id, priority })}
        trigger={
          <TaskPillButton
            aria-label={t("common:priority", { value0: todoPriorityLabel(todo.priority, t) })}
            title={todo.priority === "none" ? t("workspace:priority") : undefined}
            className={cn(todo.priority === "none" && EMPTY_PILL_CLASS)}
          />
        }
      >
        <TaskPriorityGlyph priority={todo.priority} />
        {todo.priority === "none" ? null : todoPriorityLabel(todo.priority, t)}
      </TaskPriorityMenu>
    </div>
  );
}
