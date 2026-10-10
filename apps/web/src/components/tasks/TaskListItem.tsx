// FILE: TaskListItem.tsx
// Purpose: One row of the floating Tasks list: the status circle (tap to finish), the title,
//          one quiet word for its due day or what its agent is doing, and the agent's mark.
//          Clicking the row opens the task card; right-click has the rest (rename, open or
//          unlink the chat, delegate, delete).
// Layer: Tasks UI component
// Exports: TaskListItem

import type { TodoUpdateInput } from "@synara/contracts";
import { formatModelDisplayName } from "@synara/shared/model";
import type { MouseEvent } from "react";

import { ProviderIcon } from "~/components/ProviderIcon";
import { cn } from "~/lib/utils";
import { readNativeApi } from "../../nativeApi";
import { SIDEBAR_ROW_ACTIVE_CLASS_NAME } from "../../sidebarRowStyles";
import { ELEVATED_HOVER_SURFACE_CLASS_NAME } from "../../surfaceStyles";
import { TASK_META_TONE_CLASS } from "./TaskCardPrimitives";
import { TaskPriorityGlyph, TaskStatusGlyph } from "./TaskGlyphs";
import { TaskRowTitle, useTaskRename } from "./TaskRowTitle";
import { buildTaskRowContextMenu } from "./taskRowContextMenu";
import {
  describeTaskMeta,
  formatDueLabel,
  type TaskRowModel,
  unlinkChatInput,
} from "./tasks.logic";
import { useTaskCanUnlink } from "./taskDelegationState";
import { useOpenChat } from "./useOpenChat";

export function TaskListItem({
  row,
  selected,
  onSelect,
  now,
  onUpdate,
  onDelete,
}: {
  row: TaskRowModel;
  selected: boolean;
  /** Opens the card, which also holds the hand-off form. */
  onSelect: () => void;
  now: Date;
  onUpdate: (input: TodoUpdateInput) => void;
  onDelete: () => void;
}) {
  const { todo, status, thread } = row;
  const openChat = useOpenChat(todo.threadId);
  const rename = useTaskRename(todo, onUpdate);
  const isDone = status.kind === "done";
  const canUnlink = useTaskCanUnlink(todo, status.kind, now);
  // Linked to a chat that still exists, even before its summary loads ("Starting").
  const isDelegated = todo.threadId !== null && !status.chatMissing;
  const meta = describeTaskMeta(status, todo.dueDate ? formatDueLabel(todo.dueDate, now) : null);
  const agent = thread && !isDone ? thread.modelSelection : null;
  // Only the priorities worth a mark; the card shows every level.
  const flagsPriority = !isDone && (todo.priority === "urgent" || todo.priority === "high");

  const toggleDone = (event: MouseEvent) => {
    event.stopPropagation();
    onUpdate({ id: todo.id, completed: !isDone });
  };

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
          canUnlink,
        }),
        { x: event.clientX, y: event.clientY },
      );
      if (clicked === "rename") rename.startEditing();
      else if (clicked === "open-chat") openChat();
      else if (clicked === "unlink-chat") onUpdate(unlinkChatInput(todo));
      else if (clicked === "delegate") onSelect();
      else if (clicked === "toggle-done") onUpdate({ id: todo.id, completed: !isDone });
      else if (clicked === "delete") onDelete();
    })();
  };

  return (
    // Mouse convenience: the whole row opens the card. Keyboard users reach the same through
    // the title button, which is the row's accessible control.
    <div
      role="listitem"
      aria-current={selected ? "true" : undefined}
      onClick={onSelect}
      onContextMenu={handleContextMenu}
      className={cn(
        "flex min-h-10.5 cursor-default items-center gap-3 rounded-xl px-3 transition-colors",
        selected ? SIDEBAR_ROW_ACTIVE_CLASS_NAME : ELEVATED_HOVER_SURFACE_CLASS_NAME,
      )}
    >
      <button
        type="button"
        onClick={toggleDone}
        aria-label={`${isDone ? "Mark as not done" : "Mark as done"}: ${todo.title} (${status.label})`}
        className="flex shrink-0 rounded-full outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <TaskStatusGlyph kind={status.kind} className="size-4.5" />
      </button>

      <div className="flex min-w-0 flex-1 items-baseline gap-2.5 py-2.5">
        <TaskRowTitle title={todo.title} isDone={isDone} rename={rename} />
        {meta ? (
          <span
            className={cn(
              "max-w-56 shrink-0 truncate text-ui-sm",
              TASK_META_TONE_CLASS[meta.tone],
              meta.live && "shimmer",
            )}
          >
            {meta.text}
          </span>
        ) : null}
      </div>

      {flagsPriority ? <TaskPriorityGlyph priority={todo.priority} /> : null}
      {agent ? (
        <span title={formatModelDisplayName(agent.model) ?? agent.model} className="flex shrink-0">
          <ProviderIcon provider={agent.provider} className="size-3.5 opacity-80" />
        </span>
      ) : null}
    </div>
  );
}
