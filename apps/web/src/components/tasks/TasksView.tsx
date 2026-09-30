// FILE: TasksView.tsx
// Purpose: The Tasks route — a compact to-do list where any item can be handed to an
//          agent chat. Open items group by what they need from the user (Needs you,
//          Running, To do); finished ones fold into Completed. Selecting a row opens the
//          inspector with its details, the delegate form, or the agent's live state.
// Layer: Tasks route surface
// Exports: TasksView (default)

import { TodoId } from "@synara/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";

import { FilterPillGroup } from "~/components/FilterPillGroup";
import { useNowMs } from "~/hooks/useNowMs";
import { isNewTaskShortcut } from "~/lib/newTaskShortcut";
import { useTasksSurfaceEnabled } from "../../tasksSurface";
import { RouteSurface, RouteSurfaceHeader } from "../RouteSurface";
import { RouteInsetSurface } from "../RouteInsetSurface";
import { TaskInspector } from "./TaskInspector";
import { TaskListEmptyState } from "./TaskListEmptyState";
import { TaskListSections } from "./TaskListSections";
import { TaskQuickAdd } from "./TaskQuickAdd";
import { TaskRow } from "./TaskRow";
import { NewTaskButton } from "./NewTaskButton";
import { TasksViewSwitch } from "./TasksViewSwitch";
import {
  buildTaskSections,
  filterTaskRows,
  TASK_FILTER_OPTIONS,
  type TaskFilter,
} from "./tasks.logic";
import { useTaskProjects } from "./useTaskProjects";
import { useTaskRows, useTodoList, useTodoMutations } from "./useTodos";

function newTodoId(): TodoId {
  return TodoId.makeUnsafe(`todo:${crypto.randomUUID()}`);
}

export default function TasksView() {
  const navigate = useNavigate();
  // The connected server may not offer Tasks (a browser on a Stable server): back to Kanban.
  const tasksSurfaceEnabled = useTasksSurfaceEnabled();
  useEffect(() => {
    if (!tasksSurfaceEnabled) void navigate({ to: "/kanban", replace: true });
  }, [navigate, tasksSurfaceEnabled]);
  const { todos, isLoading, isError, refetch } = useTodoList();
  const { createTodo, updateTodo, updateTodoAsync, deleteTodo } = useTodoMutations();
  // Ticks relative times, and lets a just-linked chat settle from Starting to missing.
  const nowMs = useNowMs(true, 15_000);
  const now = useMemo(() => new Date(nowMs), [nowMs]);
  const rows = useTaskRows(todos, now);
  const [filter, setFilter] = useState<TaskFilter>("all");
  const visibleRows = useMemo(() => filterTaskRows(rows, filter), [filter, rows]);
  const { sections, completed } = useMemo(() => buildTaskSections(visibleRows), [visibleRows]);
  const [selectedTodoId, setSelectedTodoId] = useState<TodoId | null>(null);
  const selectedRow = rows.find((row) => row.todo.id === selectedTodoId) ?? null;
  const { projectNameById, projectCwdById, projectOptions } = useTaskProjects();
  const openCount = rows.filter((row) => row.status.kind !== "done").length;
  const [showCompleted, setShowCompleted] = useState(false);
  const quickAddRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    function onKeyDown(event: globalThis.KeyboardEvent) {
      if (!isNewTaskShortcut(event)) return;
      event.preventDefault();
      quickAddRef.current?.focus();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const renderRow = (row: (typeof rows)[number]) => (
    <TaskRow
      key={row.todo.id}
      row={row}
      selected={row.todo.id === selectedTodoId}
      onSelect={() => setSelectedTodoId(row.todo.id)}
      onRequestDelegate={() => setSelectedTodoId(row.todo.id)}
      projectNameById={projectNameById}
      projectOptions={projectOptions}
      now={now}
      onUpdate={(input) => updateTodo(input)}
      onDelete={() => {
        if (row.todo.id === selectedTodoId) setSelectedTodoId(null);
        deleteTodo(row.todo.id);
      }}
    />
  );
  // The Done filter is the Completed list itself, so it shows expanded without the fold.
  const completedExpanded = filter === "done" || showCompleted;

  return (
    <RouteInsetSurface>
      <RouteSurface>
        <RouteSurfaceHeader>
          <div className="flex min-w-0 flex-1 items-center gap-2 [-webkit-app-region:no-drag]">
            <h2 className="truncate text-ui-lg font-medium text-foreground">Tasks</h2>
            <span className="shrink-0 text-ui leading-snug text-muted-foreground/70">
              {openCount} open
            </span>
            <TasksViewSwitch current="list" />
            <div className="ml-2 hidden sm:block">
              <FilterPillGroup
                ariaLabel="Show tasks"
                value={filter}
                options={TASK_FILTER_OPTIONS}
                onChange={setFilter}
              />
            </div>
            <NewTaskButton onClick={() => quickAddRef.current?.focus()} />
          </div>
        </RouteSurfaceHeader>

        {/* Escape closes the inspector unless a field or menu inside is handling it. */}
        <div
          className="flex min-h-0 flex-1"
          onKeyDown={(event) => {
            if (event.key !== "Escape" || event.defaultPrevented) return;
            const target = event.target;
            if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
            setSelectedTodoId(null);
          }}
        >
          <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
            <TaskQuickAdd
              inputRef={quickAddRef}
              onCreate={(title, options) => createTodo({ id: newTodoId(), title }, options)}
            />
            <TaskListSections
              sections={sections}
              completed={completed}
              completedExpanded={completedExpanded}
              onToggleCompleted={() => setShowCompleted((current) => !current)}
              renderRow={renderRow}
            />
            <TaskListEmptyState
              isLoading={isLoading}
              isError={isError}
              totalCount={rows.length}
              visibleCount={visibleRows.length}
              onRetry={() => void refetch()}
            />
          </div>
          {selectedRow ? (
            <TaskInspector
              row={selectedRow}
              projectNameById={projectNameById}
              projectCwdById={projectCwdById}
              projectOptions={projectOptions}
              now={now}
              onUpdate={(input) => updateTodo(input)}
              onUpdateAsync={updateTodoAsync}
              onClose={() => setSelectedTodoId(null)}
            />
          ) : null}
        </div>
      </RouteSurface>
    </RouteInsetSurface>
  );
}
