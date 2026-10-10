// FILE: KanbanView.tsx
// Purpose: Kanban control-center page shell — header chrome plus the nested
//          overview (all projects) / single-project board navigation.
// Layer: Kanban route surface
// Exports: KanbanView (default)

import type { ProjectId } from "@synara/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import { FilterPillGroup } from "~/components/FilterPillGroup";
import { RouteInsetSurface } from "../RouteInsetSurface";
import { useNowMs } from "~/hooks/useNowMs";
import { useThreadPullRequests } from "~/hooks/useThreadPullRequests";
import { ArrowLeftIcon } from "~/lib/icons";
import { isNewTaskShortcut } from "~/lib/newTaskShortcut";

import { useStore } from "../../store";
import { NewTaskButton } from "../tasks/NewTaskButton";
import { TasksViewSwitch } from "../tasks/TasksViewSwitch";
import { RouteSurface, RouteSurfaceHeader } from "../RouteSurface";
import { KanbanNewTaskDialog } from "./KanbanNewTaskDialog";
import { KanbanOverview } from "./KanbanOverview";
import { KanbanProjectBoardView } from "./KanbanProjectBoardView";
import { useKanbanBoard } from "./useKanbanBoard";
import { useKanbanCardContextMenu } from "./useKanbanCardContextMenu";
import { overviewVisibleKanbanCards, type KanbanCard } from "./kanban.logic";
import { useKanbanUiStore, type KanbanViewMode } from "../../kanbanUiStore";

const BOARD_VIEW_OPTIONS: ReadonlyArray<{ value: KanbanViewMode; label: string }> = [
  { value: "v2", label: "Attention" },
  { value: "classic", label: "Classic" },
];

export default function KanbanView({ projectId }: { projectId: string | null }) {
  const navigate = useNavigate();
  const board = useKanbanBoard();
  const threadsHydrated = useStore((state) => state.threadsHydrated);
  const kanbanViewMode = useKanbanUiStore((state) => state.kanbanViewMode);
  const setKanbanViewMode = useKanbanUiStore((state) => state.setKanbanViewMode);

  const projectBoard =
    projectId === null
      ? null
      : (board.projects.find((candidate) => candidate.projectId === projectId) ?? null);
  const hasActiveCardWork = board.projects.some(
    (project) =>
      project.inProgress.some((card) => card.activeWorkStartedAt !== null) ||
      project.awaitingYou.some((card) => card.activeWorkStartedAt !== null),
  );
  const nowMs = useNowMs(hasActiveCardWork);

  // PR badges resolve like the sidebar's: live git status per checkout validates the
  // persisted PR instead of trusting stale lastKnownPr metadata. Scoped to the cards the
  // current surface renders (one board, or each overview column's capped list).
  const allProjects = useStore((state) => state.projects);
  const projectCwdById = useMemo(
    () => new Map(allProjects.map((project) => [project.id, project.cwd] as const)),
    [allProjects],
  );
  const renderedCardThreads = useMemo(() => {
    const isV2 = kanbanViewMode === "v2";
    const cards = projectBoard
      ? [
          ...projectBoard.inProgress,
          ...(isV2 ? projectBoard.awaitingYou : []),
          ...projectBoard.draft,
          ...projectBoard.done,
        ]
      : board.projects.flatMap(
          (candidate) => overviewVisibleKanbanCards(candidate, isV2).visibleCards,
        );
    return cards.flatMap((card) => (card.thread ? [card.thread] : []));
  }, [board.projects, kanbanViewMode, projectBoard]);
  const prByThreadId = useThreadPullRequests({
    threads: renderedCardThreads,
    projectCwdById,
  });

  const [newTaskDialog, setNewTaskDialog] = useState<{
    key: number;
    projectId: ProjectId | null;
    sendAsDraft: boolean;
  } | null>(null);
  const handleNewTask = (
    targetProjectId: ProjectId | null,
    options?: { sendAsDraft?: boolean },
  ) => {
    setNewTaskDialog({
      key: Date.now(),
      projectId: targetProjectId,
      sendAsDraft: options?.sendAsDraft ?? false,
    });
  };
  const projectBoardId = projectBoard?.projectId ?? null;
  const handleNewTaskInProjectBoard = () => {
    handleNewTask(projectBoardId);
  };
  // The Draft column's "+" implies "add a card here" — seed the dialog's
  // "Send as draft" toggle so the task parks in Draft instead of dispatching.
  const handleNewDraftInProjectBoard = () => {
    handleNewTask(projectBoardId, { sendAsDraft: true });
  };
  const newTaskProjectOptions = board.projects.map((project) => ({
    id: project.projectId,
    name: project.projectName,
  }));

  // Kanban-scoped ⌥⌘T: open the New task dialog targeting the current board (or
  // unscoped on the overview). A ref mirrors the open state so a repeat press
  // doesn't remount an already-open dialog and wipe a half-typed prompt — and so
  // the listener stays registered once instead of re-binding on every open/close.
  const isNewTaskDialogOpenRef = useRef(false);
  useEffect(() => {
    isNewTaskDialogOpenRef.current = newTaskDialog !== null;
  }, [newTaskDialog]);
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!isNewTaskShortcut(event) || isNewTaskDialogOpenRef.current) {
        return;
      }
      if (newTaskProjectOptions.length === 0) {
        return;
      }
      event.preventDefault();
      handleNewTask(projectBoardId);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [handleNewTask, newTaskProjectOptions.length, projectBoardId]);

  useEffect(() => {
    // Unknown/stale project id (deleted project, old link): fall back to the overview
    // instead of a blank board — but only once hydration can tell stale from loading.
    if (projectId !== null && projectBoard === null && threadsHydrated) {
      void navigate({ to: "/kanban", replace: true });
    }
  }, [navigate, projectBoard, projectId, threadsHydrated]);

  const handleOpenCard = (card: KanbanCard) => {
    void navigate({ to: "/$threadId", params: { threadId: card.threadId } });
  };

  const { onCardContextMenu, renameDialog } = useKanbanCardContextMenu();

  const handleOpenProject = (targetProjectId: ProjectId) => {
    void navigate({ to: "/kanban/$projectId", params: { projectId: targetProjectId } });
  };

  const handleBackToOverview = () => {
    void navigate({ to: "/kanban" });
  };

  return (
    <RouteInsetSurface>
      <RouteSurface>
        <RouteSurfaceHeader>
          <div className="flex min-w-0 flex-1 items-center gap-2 [-webkit-app-region:no-drag]">
            {projectBoard ? (
              <Button
                size="icon-xs"
                variant="ghost"
                onClick={handleBackToOverview}
                aria-label="Back to all projects"
              >
                <ArrowLeftIcon className="size-3.5" />
              </Button>
            ) : null}
            <h2 className="max-w-[clamp(16rem,50vw,40rem)] truncate text-ui-lg font-medium text-foreground">
              {projectBoard ? projectBoard.projectName : "Kanban"}
            </h2>
            <span className="shrink-0 text-ui leading-snug text-muted-foreground/70">
              {projectBoard ? projectBoard.totalCount : board.totalCount} tasks
            </span>
            {projectBoard ? null : <TasksViewSwitch current="kanban" />}
            <FilterPillGroup
              ariaLabel="Board view"
              value={kanbanViewMode}
              options={BOARD_VIEW_OPTIONS}
              onChange={setKanbanViewMode}
            />
            <NewTaskButton
              disabled={newTaskProjectOptions.length === 0}
              onClick={handleNewTaskInProjectBoard}
            />
          </div>
        </RouteSurfaceHeader>

        {/* Pre-hydration every project's count is 0, so the overview would flash
            its empty state before the cards arrive. Hold it back until the
            thread store is hydrated (the stale-project redirect waits on the
            same flag). */}
        <div className="min-h-0 min-w-0 flex-1 pt-3">
          {projectBoard ? (
            <KanbanProjectBoardView
              board={projectBoard}
              onOpenCard={handleOpenCard}
              onCardContextMenu={onCardContextMenu}
              onNewTask={handleNewDraftInProjectBoard}
              prByThreadId={prByThreadId}
              nowMs={nowMs}
              viewMode={kanbanViewMode}
            />
          ) : threadsHydrated ? (
            <KanbanOverview
              board={board}
              onOpenProject={handleOpenProject}
              onOpenCard={handleOpenCard}
              onCardContextMenu={onCardContextMenu}
              onNewTask={handleNewTask}
              prByThreadId={prByThreadId}
              nowMs={nowMs}
              viewMode={kanbanViewMode}
            />
          ) : null}
        </div>
      </RouteSurface>

      {newTaskDialog ? (
        <KanbanNewTaskDialog
          key={newTaskDialog.key}
          onOpenChange={(open) => {
            if (!open) {
              setNewTaskDialog(null);
            }
          }}
          projectOptions={newTaskProjectOptions}
          initialProjectId={newTaskDialog.projectId}
          initialSendAsDraft={newTaskDialog.sendAsDraft}
        />
      ) : null}
      {renameDialog}
    </RouteInsetSurface>
  );
}
