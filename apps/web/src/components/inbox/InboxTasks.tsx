// FILE: InboxTasks.tsx
// Purpose: The Inbox's to-do tile: the tasks that count today (due, overdue, or with an
//          agent), the ones finished today, and a line to add one for today. The list
//          scrolls inside the tile once it is tall; the rest of the backlog is on Tasks.
// Layer: Inbox UI
// Exports: InboxTasks

import type { TodoDueDate } from "@synara/contracts";
import { useRef } from "react";

import { TaskListItem } from "../tasks/TaskListItem";
import { TaskQuickAdd } from "../tasks/TaskQuickAdd";
import type { TaskSelection } from "../tasks/TaskCardSurface";
import type { TaskRowModel } from "../tasks/tasks.logic";
import type { useTodoMutations } from "../tasks/useTodos";
import type { InboxTasks as InboxTaskRows } from "./inbox.logic";
import { Group } from "./InboxTaskList";

export function InboxTasks({
  tasks,
  today,
  now,
  selection,
  onUpdate,
  onOpenTasks,
}: {
  tasks: InboxTaskRows;
  /** The working day's date: a task added here is due today, so it stays on this page. */
  today: TodoDueDate;
  now: Date;
  selection: TaskSelection;
  onUpdate: ReturnType<typeof useTodoMutations>["updateTodo"];
  onOpenTasks: () => void;
}) {
  const quickAddRef = useRef<HTMLInputElement>(null);
  const renderRow = (row: TaskRowModel) => (
    <TaskListItem
      key={row.todo.id}
      row={row}
      selected={row.todo.id === selection.selectedTodoId}
      onSelect={() => selection.select(row.todo.id)}
      now={now}
      onUpdate={(input) => onUpdate(input)}
      onDelete={() => selection.removeTask(row.todo.id)}
    />
  );

  return (
    <Group
      label="Today’s tasks"
      count={tasks.open.length}
      action={
        <button
          type="button"
          onClick={onOpenTasks}
          className="text-ui-sm text-muted-foreground outline-none hover:text-foreground focus-visible:underline"
        >
          All tasks
        </button>
      }
    >
      {tasks.open.length + tasks.doneToday.length > 0 ? (
        <div className="flex max-h-80 flex-col gap-0.5 overflow-y-auto">
          {tasks.open.length > 0 ? (
            <div role="list" aria-label="To do today" className="flex flex-col gap-0.5">
              {tasks.open.map(renderRow)}
            </div>
          ) : null}
          {tasks.doneToday.length > 0 ? (
            <div role="list" aria-label="Done today" className="flex flex-col gap-0.5 opacity-80">
              {tasks.doneToday.map(renderRow)}
            </div>
          ) : null}
        </div>
      ) : null}
      <TaskQuickAdd
        inputRef={quickAddRef}
        placeholder="Add a task for today, or press Tab to hand it to an agent"
        onCreate={(title, options) => selection.addTask(title, options, { dueDate: today })}
      />
    </Group>
  );
}
