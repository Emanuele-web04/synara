// FILE: TasksView.tsx
// Purpose: The Tasks route — one calm list of everything to do, any of which can be handed to
//          an agent. Open to-dos come first (what needs the user, then what's working, then
//          the rest), a line at the end adds a new one, and finished ones fade out below.
//          Selecting a to-do opens its card, floating beside the list.
// Layer: Tasks route surface
// Exports: TasksView (default)

import { TodoId } from "@synara/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import { useNowMs } from "~/hooks/useNowMs";
import { isNewTaskShortcut } from "~/lib/newTaskShortcut";
import { cn } from "~/lib/utils";
import { useTasksSurfaceEnabled } from "../../tasksSurface";
import { RouteInsetSurface } from "../RouteInsetSurface";
import { RouteSurface, RouteSurfaceHeader } from "../RouteSurface";
import { TaskCard } from "./TaskCard";
import { TaskListItem } from "./TaskListItem";
import { TaskQuickAdd } from "./TaskQuickAdd";
import { TasksViewSwitch } from "./TasksViewSwitch";
import { buildTaskSections, summarizeTaskList, type TaskRowModel } from "./tasks.logic";
import { useTaskProjects } from "./useTaskProjects";
import { useTaskRows, useTodoList, useTodoMutations } from "./useTodos";

/** Finished to-dos shown before "Show all". */
const DONE_PREVIEW_COUNT = 2;

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
  // One list, no headings: the sections' order (needs you, working, to do) is kept.
  const { openRows, completed } = useMemo(() => {
    const { sections, completed } = buildTaskSections(rows);
    return { openRows: sections.flatMap((section) => section.rows), completed };
  }, [rows]);
  const [selectedTodoId, setSelectedTodoId] = useState<TodoId | null>(null);
  // A to-do added with Tab opens with the cursor in its note, for details to hand off.
  const [notesFocusTodoId, setNotesFocusTodoId] = useState<TodoId | null>(null);
  const selectTodo = (id: TodoId | null, options?: { focusNotes: boolean }) => {
    setSelectedTodoId(id);
    setNotesFocusTodoId(options?.focusNotes ? id : null);
  };
  const selectedRow = rows.find((row) => row.todo.id === selectedTodoId) ?? null;
  const { projectNameById, projectCwdById, projectOptions } = useTaskProjects();
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
      selected={row.todo.id === selectedTodoId}
      onSelect={() => selectTodo(row.todo.id)}
      now={now}
      onUpdate={(input) => updateTodo(input)}
      onDelete={() => {
        if (row.todo.id === selectedTodoId) selectTodo(null);
        deleteTodo(row.todo.id);
      }}
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

        {/* Escape closes the card unless a field or menu inside is handling it. */}
        <div
          className="relative min-h-0 flex-1"
          onKeyDown={(event) => {
            if (event.key !== "Escape" || event.defaultPrevented) return;
            const target = event.target;
            if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
            selectTodo(null);
          }}
        >
          {/* With the card open on a wide window, the list re-centres in the space left of it. */}
          <div
            className={cn(
              "h-full overflow-y-auto transition-[padding] duration-200",
              selectedRow && "xl:pr-[24rem]",
            )}
          >
            <div className="mx-auto flex w-full max-w-[36rem] flex-col gap-7 px-6 pt-10 pb-20">
              <header className="flex flex-col gap-1 px-3">
                <h1 className="text-2xl font-semibold tracking-tight text-foreground">Tasks</h1>
                <p className="text-ui text-muted-foreground">
                  {isLoading ? "Loading…" : summarizeTaskList(rows)}
                </p>
              </header>

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
                <TaskQuickAdd
                  inputRef={quickAddRef}
                  onCreate={(title, { open, onError }) => {
                    const id = newTodoId();
                    createTodo(
                      { id, title },
                      {
                        onError: () => {
                          onError();
                          // The server refused it and its row is gone: close its card too, so
                          // nothing more is typed into it or handed off from it.
                          setSelectedTodoId((current) => (current === id ? null : current));
                          setNotesFocusTodoId((current) => (current === id ? null : current));
                        },
                      },
                    );
                    if (open) selectTodo(id, { focusNotes: true });
                  }}
                />
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
          </div>

          {selectedRow ? (
            <TaskCard
              row={selectedRow}
              projectNameById={projectNameById}
              projectCwdById={projectCwdById}
              projectOptions={projectOptions}
              now={now}
              onUpdate={(input) => updateTodo(input)}
              onUpdateAsync={updateTodoAsync}
              onClose={() => selectTodo(null)}
              autoFocusNotes={notesFocusTodoId === selectedRow.todo.id}
              className="absolute top-4 right-4 max-h-[calc(100%-2rem)] w-[min(22rem,calc(100%-2rem))]"
            />
          ) : null}
        </div>
      </RouteSurface>
    </RouteInsetSurface>
  );
}
