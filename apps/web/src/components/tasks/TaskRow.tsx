// FILE: TaskRow.tsx
// Purpose: One row of the Tasks list. A plain to-do is a single line with a status
//          circle, priority, title, project, and due date; a delegated one adds an agent
//          line (provider icon, model, folder, what it is doing) plus a status chip and
//          the action that unblocks it. Clicking a row selects it for the inspector.
// Layer: Tasks UI component
// Exports: TaskRow

import type { ProjectId, TodoUpdateInput } from "@synara/contracts";
import { formatModelDisplayName } from "@synara/shared/model";
import { useNavigate } from "@tanstack/react-router";
import { type KeyboardEvent, type MouseEvent, useState } from "react";

import { ProviderIcon } from "~/components/ProviderIcon";
import { Button } from "~/components/ui/button";
import { THREAD_CONTEXT_MENU_ICONS } from "~/lib/contextMenuIcons";
import { CalendarIcon, DelegateIcon, FolderIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { readNativeApi } from "../../nativeApi";
import { TaskPriorityGlyph, TaskStatusChip, TaskStatusGlyph } from "./TaskGlyphs";
import { TaskDueMenu, TaskPriorityMenu, TaskProjectMenu } from "./TaskPropertyMenus";
import {
  describeAgentLocation,
  formatAgentActivity,
  formatDueLabel,
  isChatMissingSettled,
  type TaskRowModel,
  todoPriorityLabel,
} from "./tasks.logic";

// Property menus act on the to-do without selecting its row.
const stopRowSelect = (event: MouseEvent) => event.stopPropagation();

const PROPERTY_BUTTON_CLASS =
  "h-6 gap-1 rounded-md px-1.5 text-ui-sm font-normal text-muted-foreground hover:text-foreground";
const HOVER_REVEAL_CLASS = "opacity-0 group-hover/task:opacity-100 focus-visible:opacity-100";

interface TaskRowProps {
  row: TaskRowModel;
  selected: boolean;
  onSelect: () => void;
  /** Opens the inspector on this to-do's delegate form. */
  onRequestDelegate: () => void;
  projectNameById: ReadonlyMap<string, string>;
  projectOptions: ReadonlyArray<{ id: ProjectId; name: string }>;
  now: Date;
  onUpdate: (input: TodoUpdateInput) => void;
  onDelete: () => void;
}

export function TaskRow({
  row,
  selected,
  onSelect,
  onRequestDelegate,
  projectNameById,
  projectOptions,
  now,
  onUpdate,
  onDelete,
}: TaskRowProps) {
  const { todo, status, thread } = row;
  const navigate = useNavigate();
  const [isEditing, setIsEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState(todo.title);
  const isDone = status.kind === "done";
  // Linked to a chat that still exists, even before its summary loads ("Starting").
  const isDelegated =
    todo.threadId !== null && !(status.chatMissing && isChatMissingSettled(todo, now));
  const showsAgent = thread !== null && !isDone;
  const projectName = todo.projectId ? (projectNameById.get(todo.projectId) ?? null) : null;
  // The agent line already names the chat's project; don't repeat it on the right.
  const showsProjectLabel = !(showsAgent && thread && todo.projectId === thread.projectId);
  const due = todo.dueDate ? formatDueLabel(todo.dueDate, now) : null;
  const agentLocation = thread ? describeAgentLocation(thread, projectNameById) : null;
  const agentActivity = formatAgentActivity(status, thread);

  const openChat = () => {
    if (todo.threadId) void navigate({ to: "/$threadId", params: { threadId: todo.threadId } });
  };
  // The title the rename started from: saving an unchanged draft must not write it back
  // over a rename another window made meanwhile.
  const [editStartTitle, setEditStartTitle] = useState(todo.title);
  const startEditing = () => {
    setDraftTitle(todo.title);
    setEditStartTitle(todo.title);
    setIsEditing(true);
  };
  const commitTitle = () => {
    setIsEditing(false);
    const nextTitle = draftTitle.trim();
    if (nextTitle.length > 0 && nextTitle !== editStartTitle && nextTitle !== todo.title) {
      onUpdate({ id: todo.id, title: nextTitle });
    }
  };
  const handleTitleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter") {
      event.preventDefault();
      commitTitle();
    } else if (event.key === "Escape") {
      event.preventDefault();
      setIsEditing(false);
    }
  };
  const toggleDone = () => onUpdate({ id: todo.id, completed: !isDone });

  const handleContextMenu = (event: MouseEvent) => {
    const api = readNativeApi();
    if (!api) return;
    event.preventDefault();
    onSelect();
    void (async () => {
      const clicked = await api.contextMenu.show(
        [
          { id: "rename", label: "Rename", icon: THREAD_CONTEXT_MENU_ICONS.rename },
          ...(isDelegated
            ? [
                { id: "open-chat" as const, label: "Open chat", separatorBefore: true },
                { id: "unlink-chat" as const, label: "Unlink chat" },
              ]
            : [
                ...(isDone
                  ? []
                  : [{ id: "delegate" as const, label: "Delegate…", separatorBefore: true }]),
                // A link to a chat that was deleted can still be cleared.
                ...(todo.threadId !== null
                  ? [{ id: "unlink-chat" as const, label: "Unlink chat", separatorBefore: isDone }]
                  : []),
              ]),
          {
            id: "toggle-done",
            label: isDone ? "Mark as not done" : "Mark as done",
            separatorBefore: true,
          },
          {
            id: "delete",
            label: "Delete",
            icon: THREAD_CONTEXT_MENU_ICONS.delete,
            destructive: true,
            separatorBefore: true,
          },
        ],
        { x: event.clientX, y: event.clientY },
      );
      if (clicked === "rename") startEditing();
      else if (clicked === "open-chat") openChat();
      else if (clicked === "unlink-chat") onUpdate({ id: todo.id, threadId: null });
      else if (clicked === "delegate") onRequestDelegate();
      else if (clicked === "toggle-done") toggleDone();
      else if (clicked === "delete") onDelete();
    })();
  };

  return (
    // Mouse convenience: the whole row selects. Keyboard users reach the same through the
    // title button, which is the row's accessible control.
    <div
      role="listitem"
      aria-current={selected ? "true" : undefined}
      onClick={onSelect}
      onContextMenu={handleContextMenu}
      className={cn(
        "group/task flex cursor-default items-center gap-2.5 px-5 transition-colors",
        showsAgent ? "h-13" : "h-9.5",
        selected ? "bg-accent" : "hover:bg-accent/70",
      )}
    >
      {/* Property menus act on the to-do without selecting it; React bubbles clicks from
          their portaled popups through here too. */}
      <div className="contents" onClick={stopRowSelect}>
        <TaskPriorityMenu
          priority={todo.priority}
          onChange={(priority) => onUpdate({ id: todo.id, priority })}
          trigger={
            <button
              type="button"
              aria-label={`Priority: ${todoPriorityLabel(todo.priority)}`}
              className={cn(
                "flex size-5 shrink-0 items-center justify-center rounded-sm outline-none focus-visible:ring-1 focus-visible:ring-ring",
                todo.priority === "none" && HOVER_REVEAL_CLASS,
              )}
            />
          }
        >
          <TaskPriorityGlyph priority={todo.priority} />
        </TaskPriorityMenu>
      </div>

      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          toggleDone();
        }}
        aria-label={`${isDone ? "Mark as not done" : "Mark as done"}: ${todo.title} (${status.label})`}
        className="flex shrink-0 rounded-full outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <TaskStatusGlyph kind={status.kind} />
      </button>

      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        {isEditing ? (
          <input
            aria-label="Task title"
            value={draftTitle}
            autoFocus
            onFocus={(event) => event.currentTarget.select()}
            onChange={(event) => setDraftTitle(event.target.value)}
            onBlur={commitTitle}
            onKeyDown={handleTitleKeyDown}
            className="font-system-ui min-w-0 bg-transparent text-ui text-foreground outline-none"
          />
        ) : (
          <button
            type="button"
            onDoubleClick={startEditing}
            onKeyDown={(event) => {
              if (event.key === "F2") {
                event.preventDefault();
                startEditing();
              }
            }}
            title="Double-click or press F2 to rename"
            className={cn(
              "min-w-0 truncate text-left text-ui outline-none",
              isDone ? "text-muted-foreground" : "text-foreground",
            )}
          >
            {todo.title}
          </button>
        )}
        {showsAgent && thread ? (
          <div className="flex min-w-0 items-center gap-1.5 text-ui-sm text-muted-foreground">
            <ProviderIcon provider={thread.modelSelection.provider} className="size-3 shrink-0" />
            <span className="shrink-0 text-foreground/80">
              {formatModelDisplayName(thread.modelSelection.model) ?? thread.modelSelection.model}
            </span>
            {agentLocation ? (
              <>
                <span className="shrink-0">in</span>
                <span className="min-w-0 shrink truncate font-mono text-ui-xs text-foreground/70">
                  {agentLocation}
                </span>
              </>
            ) : null}
            {agentActivity ? (
              <>
                <span className="shrink-0">·</span>
                <span className="min-w-0 truncate">{agentActivity}</span>
              </>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="flex shrink-0 items-center gap-1">
        <div className="contents" onClick={stopRowSelect}>
          {showsProjectLabel ? (
            <TaskProjectMenu
              projectId={todo.projectId}
              projectOptions={projectOptions}
              onChange={(projectId) => onUpdate({ id: todo.id, projectId })}
              align="end"
              trigger={
                <Button
                  size="xs"
                  variant="ghost"
                  aria-label={projectName ? `Project: ${projectName}` : "Set project"}
                  className={cn(PROPERTY_BUTTON_CLASS, !projectName && HOVER_REVEAL_CLASS)}
                />
              }
            >
              {projectName ? (
                <span className="max-w-32 truncate">{projectName}</span>
              ) : (
                <FolderIcon aria-hidden className="size-3.5" />
              )}
            </TaskProjectMenu>
          ) : null}

          {isDone ? null : (
            <TaskDueMenu
              dueDate={todo.dueDate}
              now={now}
              onChange={(dueDate) => onUpdate({ id: todo.id, dueDate })}
              align="end"
              trigger={
                <Button
                  size="xs"
                  variant="ghost"
                  aria-label={due ? `Due ${due.label}` : "Set due date"}
                  className={cn(
                    PROPERTY_BUTTON_CLASS,
                    due?.overdue && "text-status-failure hover:text-status-failure",
                    !due && HOVER_REVEAL_CLASS,
                  )}
                />
              }
            >
              {due ? due.label : <CalendarIcon aria-hidden className="size-3.5" />}
            </TaskDueMenu>
          )}
        </div>

        {showsAgent && status.kind === "review" ? (
          <Button
            size="xs"
            variant="outline"
            className="text-ui-sm"
            onClick={(event) => {
              event.stopPropagation();
              toggleDone();
            }}
          >
            Mark done
          </Button>
        ) : null}
        {showsAgent && status.kind === "needs" ? (
          <Button size="xs" className="text-ui-sm" onClick={onSelect}>
            Respond
          </Button>
        ) : null}
        {showsAgent && status.kind === "stopped" ? (
          <Button size="xs" variant="outline" className="text-ui-sm" onClick={openChat}>
            Open
          </Button>
        ) : null}
        {showsAgent ? <TaskStatusChip kind={status.kind} label={status.label} /> : null}

        {!isDelegated && !isDone ? (
          <Button
            size="xs"
            variant="outline"
            className={cn("gap-1.5 text-ui-sm", !selected && HOVER_REVEAL_CLASS)}
            onClick={(event) => {
              event.stopPropagation();
              onRequestDelegate();
            }}
          >
            <DelegateIcon aria-hidden className="size-3.5 text-status-merged" />
            Delegate
          </Button>
        ) : null}
      </div>
    </div>
  );
}
