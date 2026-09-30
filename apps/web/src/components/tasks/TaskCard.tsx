// FILE: TaskCard.tsx
// Purpose: The floating card for the selected to-do: its editable title and note, property
//          pills, then either the hand-off controls (a plain to-do) or what its agent is
//          doing and needs (a delegated one).
// Layer: Tasks UI component
// Exports: TaskCard

import type { ProjectId, TodoUpdateInput } from "@synara/contracts";

import { IconButton } from "~/components/ui/icon-button";
import { XIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { RAISED_SURFACE_CHROME_CLASS_NAME } from "../chat/composerPickerStyles";
import { TaskAgentPanel } from "./TaskAgentPanel";
import { TaskCardProperties } from "./TaskCardProperties";
import { TaskPillButton, TaskWell } from "./TaskCardPrimitives";
import { TaskHandOff } from "./TaskHandOff";
import { TaskTextFields } from "./TaskTextFields";
import type { TaskRowModel } from "./tasks.logic";
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

  return (
    <section
      aria-label="Task details"
      className={cn(
        "flex flex-col gap-3.5 overflow-y-auto rounded-3xl bg-popover p-4",
        RAISED_SURFACE_CHROME_CLASS_NAME,
        className,
      )}
    >
      {/* Keyed by id so switching the selection never carries a half-typed edit over. */}
      <TaskTextFields
        key={todo.id}
        row={row}
        onUpdate={onUpdate}
        trailing={
          <IconButton
            label="Close"
            size="icon-xs"
            variant="ghost"
            className="-mr-1 shrink-0 text-muted-foreground"
            onClick={onClose}
          >
            <XIcon className="size-3.5" />
          </IconButton>
        }
      />

      <TaskCardProperties
        todo={todo}
        projectNameById={projectNameById}
        projectOptions={projectOptions}
        now={now}
        onUpdate={onUpdate}
      />

      {thread ? (
        <TaskAgentPanel
          key={thread.id}
          row={row}
          threadId={thread.id}
          projectNameById={projectNameById}
          projectCwdById={projectCwdById}
          onUpdate={onUpdate}
        />
      ) : status.kind === "done" ? (
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
          <TaskPillButton className="self-end" onClick={openChat}>
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
    </section>
  );
}
