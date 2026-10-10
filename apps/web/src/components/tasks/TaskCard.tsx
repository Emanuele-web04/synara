// FILE: TaskCard.tsx
// Purpose: The floating card for the selected to-do: its editable title and note, property
//          pills, then either the hand-off controls (a plain to-do), what its agent is doing
//          and needs (a delegated one), or the way back from done. ⌘↵ anywhere on the card
//          hands a plain to-do off, note included.
// Layer: Tasks UI component
// Exports: TaskCard

import { GLASS_RAISED_SURFACE_CLASS_NAME } from "~/surfaceStyles";
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
import {
  pruneSavedTaskText,
  recordSavedTaskText,
  type SavedTaskText,
  type TaskRowModel,
  unlinkChatInput,
  withSavedTaskText,
} from "./tasks.logic";
import { useTaskCanUnlink } from "./taskDelegationState";
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
  const canUnlink = useTaskCanUnlink(todo, status.kind, now);
  const startHandOffRef = useRef<(() => void) | null>(null);

  // Title and note edits saved here that the to-do's copy doesn't show yet (see SavedTaskText).
  // The card stays mounted across selections, so they are tied to the to-do they were for.
  const savedTextRef = useRef<SavedTaskText | null>(null);
  useEffect(() => {
    savedTextRef.current = pruneSavedTaskText(savedTextRef.current, todo);
  }, [todo]);
  const saveText = (input: TodoUpdateInput) => {
    savedTextRef.current = recordSavedTaskText(savedTextRef.current, input);
    onUpdate(input);
  };
  const readTodo = (): Todo => withSavedTaskText(todo, savedTextRef.current);

  return (
    <section
      aria-label="Task details"
      className={cn(
        `${GLASS_RAISED_SURFACE_CLASS_NAME} flex flex-col gap-3.5 overflow-y-auto rounded-3xl bg-popover p-4`,
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
            {canUnlink ? (
              <TaskPillButton onClick={() => onUpdate(unlinkChatInput(todo))}>
                Unlink
              </TaskPillButton>
            ) : null}
          </TaskActionRow>
        </>
      ) : (
        <>
          {status.chatMissing ? (
            <TaskWell className="flex-row items-center justify-between gap-3">
              <span className="text-ui-sm text-muted-foreground">
                The chat this task was handed to no longer exists.
              </span>
              {canUnlink ? (
                <TaskPillButton onClick={() => onUpdate(unlinkChatInput(todo))}>
                  Unlink
                </TaskPillButton>
              ) : null}
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
