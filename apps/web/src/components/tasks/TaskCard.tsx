// FILE: TaskCard.tsx
// Purpose: The floating card for the selected to-do: its editable title and note, property
//          pills, then either the hand-off controls (a plain to-do), what its agent is doing
//          and needs (a delegated one), or the way back from done. ⌘↵ anywhere on the card
//          hands a plain to-do off, note included.
// Layer: Tasks UI component
// Exports: TaskCard

import type { ProjectId, Todo, TodoUpdateInput } from "@synara/contracts";
import { useEffect, useRef } from "react";

import { IconButton } from "~/components/ui/icon-button";
import { XIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { RAISED_SURFACE_CHROME_CLASS_NAME } from "../chat/composerPickerStyles";
import { TaskAgentPanel } from "./TaskAgentPanel";
import { TaskCardProperties } from "./TaskCardProperties";
import { TaskActionRow, TaskPillButton, TaskWell } from "./TaskCardPrimitives";
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
  autoFocusNotes = false,
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
  /** Opens with the cursor in the note (a task just added with Tab). */
  autoFocusNotes?: boolean;
  className?: string;
}) {
  const { todo, status, thread } = row;
  const openChat = useOpenChat(todo.threadId);
  const startHandOffRef = useRef<(() => void) | null>(null);

  // Title and note edits saved from this card, until the to-do's own copy carries them: Start
  // reads the to-do through them, so an edit saved by that same press still reaches the agent.
  const savedTextRef = useRef<{ title?: string; notes?: string }>({});
  useEffect(() => {
    savedTextRef.current = {};
  }, [todo.title, todo.notes]);
  const saveText = (input: TodoUpdateInput) => {
    if (input.title !== undefined) savedTextRef.current.title = input.title;
    if (input.notes !== undefined) savedTextRef.current.notes = input.notes;
    onUpdate(input);
  };
  const readTodo = (): Todo => ({ ...todo, ...savedTextRef.current });

  return (
    <section
      aria-label="Task details"
      className={cn(
        "flex flex-col gap-3.5 overflow-y-auto rounded-3xl bg-popover p-4",
        RAISED_SURFACE_CHROME_CLASS_NAME,
        className,
      )}
      onKeyDown={(event) => {
        const start = startHandOffRef.current;
        if (!start || !(event.metaKey || event.ctrlKey) || event.key !== "Enter") return;
        event.preventDefault();
        // Blurring saves the title or note being typed, so the agent gets it.
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
        start();
      }}
    >
      {/* Keyed by id so switching the selection never carries a half-typed edit over. */}
      <TaskTextFields
        key={todo.id}
        row={row}
        onUpdate={saveText}
        autoFocusNotes={autoFocusNotes}
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

      {/* Done first: a finished delegated to-do still has its chat, and needs the way back. */}
      {status.kind === "done" ? (
        <TaskActionRow>
          {thread ? <TaskPillButton onClick={openChat}>Open chat</TaskPillButton> : null}
          <TaskPillButton onClick={() => onUpdate({ id: todo.id, completed: false })}>
            Mark as not done
          </TaskPillButton>
        </TaskActionRow>
      ) : thread ? (
        <TaskAgentPanel
          key={thread.id}
          row={row}
          threadId={thread.id}
          projectNameById={projectNameById}
          projectCwdById={projectCwdById}
          onUpdate={onUpdate}
        />
      ) : todo.threadId !== null && !status.chatMissing ? (
        // Linked, but the chat has not reached this window yet: no second Start meanwhile.
        <>
          <TaskWell>
            <span className="shimmer text-ui-sm">{status.detail ?? "Starting the agent…"}</span>
          </TaskWell>
          <TaskActionRow>
            <TaskPillButton onClick={openChat}>Open chat</TaskPillButton>
          </TaskActionRow>
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
          <TaskHandOff
            key={todo.id}
            todo={todo}
            readTodo={readTodo}
            onLinkChat={onUpdateAsync}
            startRef={startHandOffRef}
          />
        </>
      )}
    </section>
  );
}
