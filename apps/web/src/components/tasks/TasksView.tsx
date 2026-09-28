// FILE: TasksView.tsx
// Purpose: The Tasks route — a compact to-do list where any item can be handed to an
//          agent chat. Open items group by what they need from the user (Needs you,
//          Running, To do); finished ones fold into Completed. Selecting a row opens the
//          inspector with its details, the delegate form, or the agent's live state.
// Layer: Tasks route surface
// Exports: TasksView (default)

import { TodoId } from "@synara/contracts";
import { useNavigate } from "@tanstack/react-router";
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";

import { FilterPillGroup } from "~/components/FilterPillGroup";
import { SidebarHeaderNavigationControls } from "~/components/SidebarHeaderNavigationControls";
import { Button } from "~/components/ui/button";
import { DisclosureChevron } from "~/components/ui/DisclosureChevron";
import { DisclosureRegion } from "~/components/ui/DisclosureRegion";
import { Kbd, KbdGroup } from "~/components/ui/kbd";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import {
  useDesktopTopBarTrafficLightGutterClassName,
  useDesktopTopBarWindowControlsGutterClassName,
} from "~/hooks/useDesktopTopBarGutter";
import { useNowMs } from "~/hooks/useNowMs";
import { PlusIcon } from "~/lib/icons";
import { isNewTaskShortcut, NEW_TASK_SHORTCUT_PARTS } from "~/lib/newTaskShortcut";
import { cn } from "~/lib/utils";
import { useStore } from "../../store";
import { useTasksSurfaceEnabled } from "../../tasksSurface";
import {
  CHAT_SURFACE_HEADER_DIVIDER_CLASS_NAME,
  CHAT_SURFACE_HEADER_HEIGHT_CLASS,
  CHAT_SURFACE_HEADER_PADDING_X_CLASS,
} from "../chat/chatHeaderControls";
import { CHAT_BACKGROUND_CLASS_NAME } from "../chat/composerPickerStyles";
import { RouteInsetSurface } from "../RouteInsetSurface";
import { TaskStatusGlyph } from "./TaskGlyphs";
import { TaskRow } from "./TaskRow";
import { TasksViewSwitch } from "./TasksViewSwitch";
import { TaskInspector } from "./TaskInspector";
import {
  buildTaskSections,
  filterTaskRows,
  TASK_FILTER_OPTIONS,
  type TaskFilter,
  type TaskSectionKey,
  type TaskStatusKind,
} from "./tasks.logic";
import { useTaskRows, useTodoList, useTodoMutations } from "./useTodos";

const SECTION_GLYPH: Record<TaskSectionKey, TaskStatusKind> = {
  needs: "needs",
  running: "running",
  todo: "todo",
};

const ROW_INSET_CLASS = "pl-[3.125rem]";

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
  const projects = useStore((state) => state.projects);
  const projectNameById = useMemo(
    () => new Map<string, string>(projects.map((project) => [project.id, project.name])),
    [projects],
  );
  const projectCwdById = useMemo(
    () => new Map<string, string>(projects.map((project) => [project.id, project.cwd])),
    [projects],
  );
  const projectOptions = useMemo(
    () =>
      projects
        .filter((project) => project.kind === "project")
        .map((project) => ({ id: project.id, name: project.name })),
    [projects],
  );
  const openCount = rows.filter((row) => row.status.kind !== "done").length;
  const [showCompleted, setShowCompleted] = useState(false);
  const [draftTitle, setDraftTitle] = useState("");
  const quickAddRef = useRef<HTMLInputElement>(null);
  const desktopTopBarTrafficLightGutterClassName = useDesktopTopBarTrafficLightGutterClassName();
  const desktopTopBarWindowControlsGutterClassName =
    useDesktopTopBarWindowControlsGutterClassName();

  useEffect(() => {
    function onKeyDown(event: globalThis.KeyboardEvent) {
      if (!isNewTaskShortcut(event)) return;
      event.preventDefault();
      quickAddRef.current?.focus();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const addTask = () => {
    const title = draftTitle.trim();
    if (title.length === 0) return;
    setDraftTitle("");
    createTodo(
      { id: newTodoId(), title },
      // Give the typed title back if the server didn't take it and nothing new was typed.
      { onError: () => setDraftTitle((current) => (current.length === 0 ? title : current)) },
    );
  };
  const handleQuickAddKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" && !event.nativeEvent.isComposing) {
      event.preventDefault();
      addTask();
    } else if (event.key === "Escape") {
      setDraftTitle("");
      event.currentTarget.blur();
    }
  };

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
      <div
        className={cn(
          "flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden",
          CHAT_BACKGROUND_CLASS_NAME,
        )}
      >
        <header
          className={cn(
            CHAT_SURFACE_HEADER_DIVIDER_CLASS_NAME,
            CHAT_SURFACE_HEADER_PADDING_X_CLASS,
            "drag-region",
            desktopTopBarTrafficLightGutterClassName,
            desktopTopBarWindowControlsGutterClassName,
          )}
        >
          <div className={cn("flex items-center gap-2 sm:gap-3", CHAT_SURFACE_HEADER_HEIGHT_CLASS)}>
            <SidebarHeaderNavigationControls />
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
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      size="sm"
                      variant="chrome"
                      className="ml-auto shrink-0 gap-1.5"
                      onClick={() => quickAddRef.current?.focus()}
                    >
                      <PlusIcon className="size-3.5" />
                      New task
                    </Button>
                  }
                />
                <TooltipPopup side="bottom">
                  <span className="flex items-center gap-2">
                    New task
                    <KbdGroup>
                      {NEW_TASK_SHORTCUT_PARTS.map((part) => (
                        <Kbd key={part}>{part}</Kbd>
                      ))}
                    </KbdGroup>
                  </span>
                </TooltipPopup>
              </Tooltip>
            </div>
          </div>
        </header>

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
            <div
              className={cn(
                "flex h-10 items-center gap-2.5 border-b border-border px-5",
                ROW_INSET_CLASS,
              )}
            >
              <PlusIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground/70" />
              <input
                ref={quickAddRef}
                aria-label="New task"
                placeholder="New task"
                value={draftTitle}
                onChange={(event) => setDraftTitle(event.target.value)}
                onKeyDown={handleQuickAddKeyDown}
                className="font-system-ui min-w-0 flex-1 bg-transparent text-ui text-foreground outline-none placeholder:text-muted-foreground/70"
              />
            </div>

            <div>
              {sections.map((section) => (
                <section key={section.key} aria-label={section.label}>
                  <div
                    className={cn(
                      "flex h-8.5 items-center gap-2.5 border-b border-border bg-muted/40 px-5",
                      ROW_INSET_CLASS,
                    )}
                  >
                    <TaskStatusGlyph kind={SECTION_GLYPH[section.key]} animated={false} />
                    <h3 className="text-ui-sm font-medium text-foreground">{section.label}</h3>
                    <span className="text-ui-sm text-muted-foreground">{section.rows.length}</span>
                  </div>
                  <div role="list" aria-label={section.label}>
                    {section.rows.map(renderRow)}
                  </div>
                </section>
              ))}

              {completed.length > 0 ? (
                <section aria-label="Completed">
                  <button
                    type="button"
                    aria-expanded={completedExpanded}
                    onClick={() => setShowCompleted((current) => !current)}
                    className={cn(
                      "flex h-8.5 w-full items-center gap-2.5 border-b border-border bg-muted/40 px-5 text-left",
                      ROW_INSET_CLASS,
                    )}
                  >
                    <TaskStatusGlyph kind="done" />
                    <span className="text-ui-sm font-medium text-foreground">Completed</span>
                    <span className="text-ui-sm text-muted-foreground">{completed.length}</span>
                    <DisclosureChevron
                      open={completedExpanded}
                      className="size-3 text-muted-foreground"
                    />
                  </button>
                  <DisclosureRegion open={completedExpanded}>
                    <div role="list" aria-label="Completed">
                      {completed.map(renderRow)}
                    </div>
                  </DisclosureRegion>
                </section>
              ) : null}
            </div>

            {isError && rows.length === 0 ? (
              <div className="flex flex-col items-center gap-2 px-5 py-16 text-center">
                <p className="text-ui text-foreground">Couldn't load your tasks</p>
                <Button size="sm" variant="outline" onClick={() => void refetch()}>
                  Try again
                </Button>
              </div>
            ) : null}
            {!isLoading && !isError && rows.length === 0 ? (
              <div className="flex flex-col items-center gap-1 px-5 py-16 text-center">
                <p className="text-ui text-foreground">No tasks yet</p>
                <p className="max-w-sm text-ui-sm text-muted-foreground">
                  Add anything you need to do. Select a task and choose Delegate to hand it to an
                  agent in a project or folder.
                </p>
              </div>
            ) : null}
            {!isLoading && rows.length > 0 && visibleRows.length === 0 ? (
              <p className="px-5 py-16 text-center text-ui-sm text-muted-foreground">
                Nothing here.
              </p>
            ) : null}
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
      </div>
    </RouteInsetSurface>
  );
}
