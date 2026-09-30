// FILE: TaskCard.tsx
// Purpose: The side panel for the selected to-do, docked to the right of the list: its
//          state, editable title and note, property pills, then either the hand-off form (a
//          plain to-do) or what its agent is doing and needs (a delegated one).
// Layer: Tasks UI component
// Exports: TaskCard

import type { ProjectId, TodoUpdateInput } from "@synara/contracts";

import { IconButton } from "~/components/ui/icon-button";
import { XIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { TaskAgentPanel } from "./TaskAgentPanel";
import { TaskCardProperties } from "./TaskCardProperties";
import { TASK_META_TONE_CLASS, TaskPillButton, TaskWell } from "./TaskCardPrimitives";
import { TaskHandOff } from "./TaskHandOff";
import { TaskTextFields } from "./TaskTextFields";
import { describeTaskMeta, type TaskRowModel } from "./tasks.logic";
import { useOpenChat } from "./useOpenChat";

export function TaskCard({
  row,
  projectNameById,
  projectCwdById,
  projectOptions,
  now,
  onUpdate,
  onUpdateAsync,
  onClose,
  className,
}: {
  row: TaskRowModel;
  projectNameById: ReadonlyMap<string, string>;
  projectCwdById: ReadonlyMap<string, string>;
  projectOptions: ReadonlyArray<{ id: ProjectId; name: string }>;
  now: Date;
  onUpdate: (input: TodoUpdateInput) => void;
  onUpdateAsync: (input: TodoUpdateInput) => Promise<unknown>;
  onClose: () => void;
  className?: string;
}) {
  const { todo, status, thread } = row;
  const openChat = useOpenChat(todo.threadId);
  const isDone = status.kind === "done";
  const meta = describeTaskMeta(status, null);
  const statusText = isDone
    ? "Done"
    : status.kind === "todo"
      ? "To do"
      : (meta?.text ?? status.label);

  return (
    <aside
      aria-label="Task details"
      className={cn(
        "flex w-[22rem] shrink-0 flex-col gap-3.5 overflow-y-auto border-l border-border px-4 pt-3 pb-5",
        className,
      )}
    >
      <div className="flex h-6 items-center gap-2">
        <span
          className={cn(
            "flex-1 text-ui-sm",
            meta && !isDone ? TASK_META_TONE_CLASS[meta.tone] : "text-muted-foreground",
          )}
        >
          {statusText}
        </span>
        <IconButton label="Close" size="icon-xs" variant="ghost" onClick={onClose}>
          <XIcon className="size-3.5" />
        </IconButton>
      </div>

      {/* Keyed by id so switching the selection never carries a half-typed edit over. */}
      <TaskTextFields key={todo.id} row={row} onUpdate={onUpdate} />

      <TaskCardProperties
        todo={todo}
        projectNameById={projectNameById}
        projectOptions={projectOptions}
        now={now}
        onUpdate={onUpdate}
      />

      <div className="h-px bg-border" />

      {thread ? (
        <TaskAgentPanel
          key={thread.id}
          row={row}
          threadId={thread.id}
          projectNameById={projectNameById}
          projectCwdById={projectCwdById}
          onUpdate={onUpdate}
        />
      ) : isDone ? (
        <TaskPillButton
          className="self-start"
          onClick={() => onUpdate({ id: todo.id, completed: false })}
        >
          Mark as not done
        </TaskPillButton>
      ) : todo.threadId !== null && !status.chatMissing ? (
        // Linked, but the chat has not reached this window yet: no second Start meanwhile.
        <>
          <TaskWell>
            <span className="shimmer text-ui-sm">{status.detail ?? "Starting the agent…"}</span>
          </TaskWell>
          <TaskPillButton className="self-start" onClick={openChat}>
            Open chat
          </TaskPillButton>
        </>
      ) : (
        <>
          {status.chatMissing ? (
            <TaskWell className="flex-row items-center justify-between gap-3">
              <span className="text-ui-sm text-muted-foreground">
                The chat this task was handed to no longer exists.
              </span>
              <TaskPillButton onClick={() => onUpdate({ id: todo.id, threadId: null })}>
                Unlink
              </TaskPillButton>
            </TaskWell>
          ) : null}
          <TaskHandOff key={todo.id} todo={todo} onLinkChat={onUpdateAsync} />
        </>
      )}
    </aside>
  );
}
