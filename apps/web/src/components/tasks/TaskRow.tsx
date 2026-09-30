// FILE: TaskRow.tsx
// Purpose: One row of the Tasks list. A plain to-do is a single line with a status
//          circle, priority, title, project, and due date; a delegated one adds an agent
//          line (provider icon, model, folder, what it is doing) plus a status chip and
//          the action that unblocks it. Clicking a row selects it for the inspector.
// Layer: Tasks UI component
// Exports: TaskRow

import type { ProjectId, TodoUpdateInput } from "@synara/contracts";
import type { ComponentProps, MouseEvent, ReactNode } from "react";

import { Button } from "~/components/ui/button";
import { CalendarIcon, DelegateIcon, FolderIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { readNativeApi } from "../../nativeApi";
import { TaskPriorityGlyph, TaskStatusChip, TaskStatusGlyph } from "./TaskGlyphs";
import { TaskDueMenu, TaskPriorityMenu, TaskProjectMenu } from "./TaskPropertyMenus";
import { TaskRowAgentLine } from "./TaskRowAgentLine";
import { TaskRowTitle, useTaskRename } from "./TaskRowTitle";
import { buildTaskRowContextMenu } from "./taskRowContextMenu";
import {
  describeAgentLocation,
  formatAgentActivity,
  formatDueLabel,
  type TaskRowModel,
  todoPriorityLabel,
  unlinkChatInput,
} from "./tasks.logic";
import { useOpenChat } from "./useOpenChat";

const stopRowSelect = (event: MouseEvent) => event.stopPropagation();
// A button inside the row that acts without also selecting the row.
const withoutRowSelect = (action: () => void) => (event: MouseEvent) => {
  event.stopPropagation();
  action();
};

const PROPERTY_BUTTON_CLASS =
  "h-6 gap-1 rounded-md px-1.5 text-ui-sm font-normal text-muted-foreground hover:text-foreground";
const HOVER_REVEAL_CLASS = "opacity-0 group-hover/task:opacity-100 focus-visible:opacity-100";

/** Property menus act on the to-do without selecting its row; React bubbles clicks from
 *  their portaled popups through here too. */
function TaskRowMenuZone({ children }: { children: ReactNode }) {
  return (
    <div className="contents" onClick={stopRowSelect}>
      {children}
    </div>
  );
}

/** The row's project / due-date chip; an unset one shows only while the row is hovered. */
function TaskRowPropertyButton({
  empty,
  className,
  ...props
}: ComponentProps<typeof Button> & { empty: boolean }) {
  return (
    <Button
      size="xs"
      variant="ghost"
      {...props}
      className={cn(PROPERTY_BUTTON_CLASS, empty && HOVER_REVEAL_CLASS, className)}
    />
  );
}

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
  const openChat = useOpenChat(todo.threadId);
  const rename = useTaskRename(todo, onUpdate);
  const isDone = status.kind === "done";
  // Linked to a chat that still exists, even before its summary loads ("Starting").
  const isDelegated = todo.threadId !== null && !status.chatMissing;
  const showsAgent = thread !== null && !isDone;
  const projectName = todo.projectId ? (projectNameById.get(todo.projectId) ?? null) : null;
  // The agent line already names the chat's project; don't repeat it on the right.
  const showsProjectLabel = !(showsAgent && thread && todo.projectId === thread.projectId);
  const due = todo.dueDate ? formatDueLabel(todo.dueDate, now) : null;
  const agentLocation = thread ? describeAgentLocation(thread, projectNameById) : null;
  const agentActivity = formatAgentActivity(status, thread);

  const toggleDone = () => onUpdate({ id: todo.id, completed: !isDone });

  const handleContextMenu = (event: MouseEvent) => {
    const api = readNativeApi();
    if (!api) return;
    event.preventDefault();
    onSelect();
    void (async () => {
      const clicked = await api.contextMenu.show(
        buildTaskRowContextMenu({
          isDelegated,
          isDone,
          hasLink: todo.threadId !== null,
          canUnlink: status.kind !== "starting",
        }),
        { x: event.clientX, y: event.clientY },
      );
      if (clicked === "rename") rename.startEditing();
      else if (clicked === "open-chat") openChat();
      else if (clicked === "unlink-chat") onUpdate(unlinkChatInput(todo));
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
      <TaskRowMenuZone>
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
      </TaskRowMenuZone>

      <button
        type="button"
        onClick={withoutRowSelect(toggleDone)}
        aria-label={`${isDone ? "Mark as not done" : "Mark as done"}: ${todo.title} (${status.label})`}
        className="flex shrink-0 rounded-full outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <TaskStatusGlyph kind={status.kind} />
      </button>

      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <TaskRowTitle title={todo.title} isDone={isDone} rename={rename} />
        {showsAgent && thread ? (
          <TaskRowAgentLine thread={thread} location={agentLocation} activity={agentActivity} />
        ) : null}
      </div>

      <div className="flex shrink-0 items-center gap-1">
        <TaskRowMenuZone>
          {showsProjectLabel ? (
            <TaskProjectMenu
              projectId={todo.projectId}
              projectOptions={projectOptions}
              onChange={(projectId) => onUpdate({ id: todo.id, projectId })}
              align="end"
              trigger={
                <TaskRowPropertyButton
                  empty={!projectName}
                  aria-label={projectName ? `Project: ${projectName}` : "Set project"}
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
                <TaskRowPropertyButton
                  empty={!due}
                  aria-label={due ? `Due ${due.label}` : "Set due date"}
                  className={cn(due?.overdue && "text-status-failure hover:text-status-failure")}
                />
              }
            >
              {due ? due.label : <CalendarIcon aria-hidden className="size-3.5" />}
            </TaskDueMenu>
          )}
        </TaskRowMenuZone>

        {showsAgent && status.kind === "review" ? (
          <Button
            size="xs"
            variant="outline"
            className="text-ui-sm"
            onClick={withoutRowSelect(toggleDone)}
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
            onClick={withoutRowSelect(onRequestDelegate)}
          >
            <DelegateIcon aria-hidden className="size-3.5 text-status-merged" />
            Delegate
          </Button>
        ) : null}
      </div>
    </div>
  );
}
