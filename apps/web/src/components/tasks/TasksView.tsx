// FILE: TasksView.tsx
// Purpose: The Tasks route — one calm list of everything to do, any of which can be handed to
//          an agent. Open to-dos come first (what needs the user, then what's working, then
//          the rest), a line at the end adds a new one, and finished ones fade out below.
//          Selecting a to-do opens its card, floating beside the list.
// Layer: Tasks route surface
// Exports: TasksView (default)

import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import { useNowMs } from "~/hooks/useNowMs";
import { isNewTaskShortcut } from "~/lib/newTaskShortcut";
import { useStore } from "~/store";
import { useTasksSurfaceEnabled } from "../../tasksSurface";
import { RouteInsetSurface } from "../RouteInsetSurface";
import { RouteSurface, RouteSurfaceHeader } from "../RouteSurface";
import { NotionWorkspaceLauncher } from "../notion/NotionWorkspaceLauncher";
import { TaskCardSurface, useTaskSelection } from "./TaskCardSurface";
import { TaskListFilters } from "./TaskListFilters";
import { TaskListItem } from "./TaskListItem";
import { TaskQuickAdd } from "./TaskQuickAdd";
import { TasksViewSwitch } from "./TasksViewSwitch";
import { countTaskFilters, EMPTY_TASK_FILTERS, matchesTaskFilters } from "./taskFilters";
import { buildTaskSections, summarizeTaskList, type TaskRowModel } from "./tasks.logic";
import { useTaskRows, useTodoList, useTodoMutations } from "./useTodos";

/** Finished to-dos shown before "Show all". */
const DONE_PREVIEW_COUNT = 2;

export default function TasksView() {
  const navigate = useNavigate();
  // The connected server may not offer Tasks (an older server): back to Kanban.
  const tasksSurfaceEnabled = useTasksSurfaceEnabled();
  useEffect(() => {
    if (!tasksSurfaceEnabled) void navigate({ to: "/kanban", replace: true });
  }, [navigate, tasksSurfaceEnabled]);
  const { todos, isLoading, isError, refetch } = useTodoList();
  const mutations = useTodoMutations();
  const projects = useStore((state) => state.projects);
  // Ticks relative times, and lets a just-linked chat settle from Starting to missing.
  const nowMs = useNowMs(true, 15_000);
  const now = useMemo(() => new Date(nowMs), [nowMs]);
  const rows = useTaskRows(todos, now);
  // Selection belongs to the full store. Filtering must not unmount an open task draft.
  const selection = useTaskSelection(rows, mutations);
  const [filters, setFilters] = useState({ ...EMPTY_TASK_FILTERS });
  const visibleRows = useMemo(
    () => rows.filter((row) => matchesTaskFilters(row.todo, filters)),
    [rows, filters],
  );
  // One list, no headings: the sections' order (needs you, working, to do) is kept.
  const { openRows, completed } = useMemo(() => {
    const { sections, completed } = buildTaskSections(visibleRows);
    return { openRows: sections.flatMap((section) => section.rows), completed };
  }, [visibleRows]);
  const [showsAllDone, setShowsAllDone] = useState(false);
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

  const renderRow = (row: TaskRowModel) => (
    <TaskListItem
      key={row.todo.id}
      row={row}
      selected={row.todo.id === selection.selectedTodoId}
      onSelect={() => selection.select(row.todo.id)}
      now={now}
      onUpdate={(input) => mutations.updateTodo(input)}
      onDelete={() => selection.removeTask(row.todo.id)}
    />
  );
  const shownDone = showsAllDone ? completed : completed.slice(0, DONE_PREVIEW_COUNT);

  return (
    <RouteInsetSurface>
      <RouteSurface>
        <RouteSurfaceHeader>
          <div className="ml-auto">
            <TasksViewSwitch current="list" />
          </div>
        </RouteSurfaceHeader>

        <TaskCardSurface selection={selection} now={now} mutations={mutations}>
          <div className="mx-auto flex w-full max-w-[36rem] flex-col gap-7 px-6 pt-10 pb-20">
            <header className="flex flex-col gap-1 px-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h1 className="text-2xl font-semibold tracking-tight text-foreground">Tasks</h1>
                <NotionWorkspaceLauncher
                  project={filters.project}
                  disabled={selection.selectedTodoId !== null}
                />
              </div>
              <p className="text-ui text-muted-foreground">
                {isLoading ? "Loading…" : summarizeTaskList(rows)}
              </p>
            </header>

            <TaskListFilters
              todos={todos}
              projects={projects}
              value={filters}
              onChange={setFilters}
            />
            {countTaskFilters(filters) ? (
              <p role="status" className="px-3 text-ui-sm text-muted-foreground">
                {visibleRows.length} of {rows.length} tasks match these filters.
              </p>
            ) : null}

            {isError && rows.length === 0 ? (
              <div className="flex items-center gap-3 px-3">
                <p className="text-ui text-foreground">Couldn't load your tasks.</p>
                <Button size="sm" shape="capsule" variant="subtle" onClick={() => void refetch()}>
                  Try again
                </Button>
              </div>
            ) : null}

            <div className="flex flex-col gap-0.5">
              <div role="list" aria-label="To do" className="flex flex-col gap-0.5">
                {openRows.map(renderRow)}
              </div>
              <TaskQuickAdd inputRef={quickAddRef} onCreate={selection.addTask} />
            </div>

            {completed.length > 0 ? (
              <div className="flex flex-col gap-0.5 opacity-80">
                <div role="list" aria-label="Done" className="flex flex-col gap-0.5">
                  {shownDone.map(renderRow)}
                </div>
                {completed.length > DONE_PREVIEW_COUNT ? (
                  <button
                    type="button"
                    aria-expanded={showsAllDone}
                    onClick={() => setShowsAllDone((current) => !current)}
                    className="self-start px-3 py-1.5 text-ui-sm text-muted-foreground outline-none hover:text-foreground focus-visible:underline"
                  >
                    {showsAllDone ? "Show less" : `Show all ${completed.length} done`}
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        </TaskCardSurface>
      </RouteSurface>
    </RouteInsetSurface>
  );
}
