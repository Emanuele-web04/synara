// FILE: TaskCardSurface.tsx
// Purpose: What every surface that lists to-dos shares: which one is selected, adding and
//          deleting with that selection kept right, and the scrolling area whose card floats
//          at its top right (the content makes room for it on a wide window; Escape closes it).
// Layer: Tasks UI component
// Exports: useTaskSelection, TaskCardSurface, TaskSelection

import type { TodoDueDate, TodoId } from "@synara/contracts";
import { useState, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { TaskCard } from "./TaskCard";
import { newTodoId, type TaskRowModel } from "./tasks.logic";
import { useTaskProjects } from "./useTaskProjects";
import type { useTodoMutations } from "./useTodos";

type TodoMutations = ReturnType<typeof useTodoMutations>;

export function useTaskSelection(
  rows: readonly TaskRowModel[],
  { createTodo, deleteTodo }: Pick<TodoMutations, "createTodo" | "deleteTodo">,
) {
  const [selectedTodoId, setSelectedTodoId] = useState<TodoId | null>(null);
  // A to-do added with Tab opens with the cursor in its note, for details to hand off.
  const [notesFocusTodoId, setNotesFocusTodoId] = useState<TodoId | null>(null);
  const select = (id: TodoId | null, options?: { focusNotes: boolean }) => {
    setSelectedTodoId(id);
    setNotesFocusTodoId(options?.focusNotes ? id : null);
  };
  // Only this to-do's card: another may have been opened since.
  const closeIfSelected = (id: TodoId) => {
    setSelectedTodoId((current) => (current === id ? null : current));
    setNotesFocusTodoId((current) => (current === id ? null : current));
  };
  const selectedRow = rows.find((row) => row.todo.id === selectedTodoId) ?? null;

  return {
    selectedTodoId,
    selectedRow,
    autoFocusNotes: selectedRow !== null && notesFocusTodoId === selectedRow.todo.id,
    select,
    /** The quick-add line's handler; `open` (Tab) opens the new to-do's card right away. */
    addTask: (
      title: string,
      { open, onError }: { open: boolean; onError: () => void },
      defaults: { dueDate?: TodoDueDate } = {},
    ) => {
      const id = newTodoId();
      createTodo(
        { id, title, ...defaults },
        {
          onError: () => {
            onError();
            // The server refused it and its row is gone: close its card too, so nothing
            // more is typed into it or handed off from it.
            closeIfSelected(id);
          },
        },
      );
      if (open) select(id, { focusNotes: true });
    },
    removeTask: (id: TodoId) => {
      closeIfSelected(id);
      deleteTodo(id);
    },
  };
}

export type TaskSelection = ReturnType<typeof useTaskSelection>;

export function TaskCardSurface({
  selection,
  now,
  mutations,
  className,
  children,
}: {
  selection: TaskSelection;
  now: Date;
  mutations: Pick<TodoMutations, "updateTodo" | "updateTodoAsync">;
  className?: string;
  children: ReactNode;
}) {
  const { projectNameById, projectCwdById, projectOptions } = useTaskProjects();
  const { selectedRow } = selection;
  return (
    // Escape closes the card unless a field or menu inside is handling it.
    <div
      className={cn("relative min-h-0 flex-1", className)}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.defaultPrevented) return;
        const target = event.target;
        if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
        selection.select(null);
      }}
    >
      {/* With the card open on a wide window, the content re-centres in the space left of it. */}
      <div
        className={cn(
          "h-full overflow-y-auto transition-[padding] duration-200",
          selectedRow && "xl:pr-[24rem]",
        )}
      >
        {children}
      </div>
      {selectedRow ? (
        <TaskCard
          row={selectedRow}
          projectNameById={projectNameById}
          projectCwdById={projectCwdById}
          projectOptions={projectOptions}
          now={now}
          onUpdate={(input) => mutations.updateTodo(input)}
          onUpdateAsync={mutations.updateTodoAsync}
          onClose={() => selection.select(null)}
          autoFocusNotes={selection.autoFocusNotes}
          className="absolute top-4 right-4 max-h-[calc(100%-2rem)] w-[min(22rem,calc(100%-2rem))]"
        />
      ) : null}
    </div>
  );
}
