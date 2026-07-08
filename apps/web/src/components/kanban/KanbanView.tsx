// FILE: KanbanView.tsx
// Purpose: Kanban control-center page shell — header chrome plus the nested
//          overview (all projects) / single-project board navigation.
// Layer: Kanban route surface
// Exports: KanbanView (default)

import type { ProjectId } from "@synara/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { SidebarHeaderNavigationControls } from "~/components/SidebarHeaderNavigationControls";
import { Button } from "~/components/ui/button";
import { Kbd, KbdGroup } from "~/components/ui/kbd";
import { RouteInsetSurface } from "../RouteInsetSurface";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import {
  useDesktopTopBarTrafficLightGutterClassName,
  useDesktopTopBarWindowControlsGutterClassName,
} from "~/hooks/useDesktopTopBarGutter";
import { useNowMs } from "~/hooks/useNowMs";
import { splitShortcutLabel } from "~/keybindings";
import { ArrowLeftIcon, PlusIcon } from "~/lib/icons";
import { cn, isMacPlatform } from "~/lib/utils";

// Kanban-scoped "Create task" shortcut: ⌘⌥T on macOS, Ctrl+Alt+T elsewhere —
// matching the app's mod convention (meta on mac, ctrl otherwise) and the ⌘⌥
// "create new X" family. Matched on event.code so it survives Alt remapping the
// produced character on some layouts.
function getNavigatorPlatform(): string {
  return typeof navigator === "undefined" ? "" : navigator.platform;
}

const NEW_TASK_SHORTCUT_LABEL = isMacPlatform(getNavigatorPlatform()) ? "⌥⌘T" : "Ctrl+Alt+T";
const NEW_TASK_SHORTCUT_PARTS = splitShortcutLabel(NEW_TASK_SHORTCUT_LABEL);

function isNewTaskShortcut(event: KeyboardEvent): boolean {
  if (event.code !== "KeyT" || event.repeat || event.shiftKey || !event.altKey) {
    return false;
  }
  return isMacPlatform(getNavigatorPlatform())
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey;
}
import { useStore } from "../../store";
import {
  CHAT_SURFACE_HEADER_DIVIDER_CLASS_NAME,
  CHAT_SURFACE_HEADER_HEIGHT_CLASS,
  CHAT_SURFACE_HEADER_PADDING_X_CLASS,
} from "../chat/chatHeaderControls";
import { CHAT_BACKGROUND_CLASS_NAME } from "../chat/composerPickerStyles";
import { KanbanNewTaskDialog } from "./KanbanNewTaskDialog";
import { KanbanOverview } from "./KanbanOverview";
import { KanbanProjectBoardView } from "./KanbanProjectBoardView";
import { useKanbanBoard } from "./useKanbanBoard";
import { useKanbanCardContextMenu } from "./useKanbanCardContextMenu";
import type { KanbanCard } from "./kanban.logic";

export default function KanbanView({ projectId }: { projectId: string | null }) {
  const navigate = useNavigate();
  const board = useKanbanBoard();
  const threadsHydrated = useStore((state) => state.threadsHydrated);
  const desktopTopBarTrafficLightGutterClassName = useDesktopTopBarTrafficLightGutterClassName();
  const desktopTopBarWindowControlsGutterClassName =
    useDesktopTopBarWindowControlsGutterClassName();

  const projectBoard =
    projectId === null
      ? null
      : (board.projects.find((candidate) => candidate.projectId === projectId) ?? null);
  const hasActiveCardWork = useMemo(
    () =>
      board.projects.some((project) =>
        project.inProgress.some((card) => card.activeWorkStartedAt !== null),
      ),
    [board.projects],
  );
  const nowMs = useNowMs(hasActiveCardWork);

  const [newTaskDialog, setNewTaskDialog] = useState<{
    key: number;
    projectId: ProjectId | null;
    sendAsDraft: boolean;
  } | null>(null);
  const handleNewTask = useCallback(
    (targetProjectId: ProjectId | null, options?: { sendAsDraft?: boolean }) => {
      setNewTaskDialog({
        key: Date.now(),
        projectId: targetProjectId,
        sendAsDraft: options?.sendAsDraft ?? false,
      });
    },
    [],
  );
  const projectBoardId = projectBoard?.projectId ?? null;
  const handleNewTaskInProjectBoard = useCallback(() => {
    handleNewTask(projectBoardId);
  }, [handleNewTask, projectBoardId]);
  // The Draft column's "+" implies "add a card here" — seed the dialog's
  // "Send as draft" toggle so the task parks in Draft instead of dispatching.
  const handleNewDraftInProjectBoard = useCallback(() => {
    handleNewTask(projectBoardId, { sendAsDraft: true });
  }, [handleNewTask, projectBoardId]);
  const newTaskProjectOptions = useMemo(
    () =>
      board.projects.map((project) => ({
        id: project.projectId,
        name: project.projectName,
      })),
    [board.projects],
  );

  // Kanban-scoped ⌥⌘T: open the New task dialog targeting the current board (or
  // unscoped on the overview). A ref mirrors the open state so a repeat press
  // doesn't remount an already-open dialog and wipe a half-typed prompt — and so
  // the listener stays registered once instead of re-binding on every open/close.
  const isNewTaskDialogOpenRef = useRef(false);
  isNewTaskDialogOpenRef.current = newTaskDialog !== null;
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

  const handleOpenCard = useCallback(
    (card: KanbanCard) => {
      void navigate({ to: "/$threadId", params: { threadId: card.threadId } });
    },
    [navigate],
  );

  const { onCardContextMenu, renameDialog } = useKanbanCardContextMenu();

  const handleOpenProject = useCallback(
    (targetProjectId: ProjectId) => {
      void navigate({ to: "/kanban/$projectId", params: { projectId: targetProjectId } });
    },
    [navigate],
  );

  const handleBackToOverview = useCallback(() => {
    void navigate({ to: "/kanban" });
  }, [navigate]);

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
              <h2 className="max-w-[clamp(16rem,50vw,40rem)] truncate text-sm font-medium text-foreground">
                {projectBoard ? projectBoard.projectName : "Kanban"}
              </h2>
              <span className="shrink-0 text-xs text-muted-foreground/70">
                {projectBoard ? projectBoard.totalCount : board.totalCount} tasks
              </span>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      size="sm"
                      variant="chrome"
                      className="ml-auto shrink-0 gap-1.5"
                      disabled={newTaskProjectOptions.length === 0}
                      onClick={handleNewTaskInProjectBoard}
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

        <div className="min-h-0 min-w-0 flex-1 pt-3">
          {projectBoard ? (
            <KanbanProjectBoardView
              board={projectBoard}
              onOpenCard={handleOpenCard}
              onCardContextMenu={onCardContextMenu}
              onNewTask={handleNewDraftInProjectBoard}
              nowMs={nowMs}
            />
          ) : (
            <KanbanOverview
              board={board}
              onOpenProject={handleOpenProject}
              onOpenCard={handleOpenCard}
              onCardContextMenu={onCardContextMenu}
              onNewTask={handleNewTask}
              nowMs={nowMs}
            />
          )}
        </div>
      </div>

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
