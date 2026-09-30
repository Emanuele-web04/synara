// FILE: TaskInspector.tsx
// Purpose: Right-hand detail panel for the selected to-do: editable title and notes,
//          properties, and the agent section — the delegate form for a plain to-do, or,
//          once delegated, the chat's model and folder, recent activity, and the action
//          it needs (approve a request inline, stop, review the reply, mark done).
// Layer: Tasks UI component
// Exports: TaskInspector

import type { ProjectId, TodoUpdateInput } from "@synara/contracts";

import { IconButton } from "~/components/ui/icon-button";
import { XIcon } from "~/lib/icons";
import { TaskAgentSection } from "./TaskAgentSection";
import { TaskDelegateForm } from "./TaskDelegateForm";
import { TaskStatusGlyph } from "./TaskGlyphs";
import { TaskInspectorProperties } from "./TaskInspectorProperties";
import { TaskNotice } from "./TaskInspectorPrimitives";
import { TaskTextFields } from "./TaskTextFields";
import { type TaskRowModel, unlinkChatInput } from "./tasks.logic";
import { useOpenChat } from "./useOpenChat";

interface TaskInspectorProps {
  row: TaskRowModel;
  projectNameById: ReadonlyMap<string, string>;
  projectCwdById: ReadonlyMap<string, string>;
  projectOptions: ReadonlyArray<{ id: ProjectId; name: string }>;
  now: Date;
  onUpdate: (input: TodoUpdateInput) => void;
  onUpdateAsync: (input: TodoUpdateInput) => Promise<unknown>;
  onClose: () => void;
}

export function TaskInspector({
  row,
  projectNameById,
  projectCwdById,
  projectOptions,
  now,
  onUpdate,
  onUpdateAsync,
  onClose,
}: TaskInspectorProps) {
  const { todo, status, thread } = row;
  const openChat = useOpenChat(todo.threadId);
  const isDone = status.kind === "done";

  return (
    <aside
      aria-label="Task details"
      className="flex w-[24rem] shrink-0 flex-col overflow-y-auto border-l border-border bg-card/40"
    >
      <div className="flex flex-col gap-5 px-5 pt-3.5 pb-6">
        <div className="flex items-center gap-2 text-ui-sm text-muted-foreground">
          <TaskStatusGlyph kind={status.kind} className="size-3.5" />
          <span>{status.label}</span>
          <div className="flex-1" />
          <IconButton label="Close details" size="icon-xs" variant="ghost" onClick={onClose}>
            <XIcon className="size-3.5" />
          </IconButton>
        </div>

        {/* Keyed by id so switching the selection never carries a half-typed edit over. */}
        <TaskTextFields key={todo.id} row={row} onUpdate={onUpdate} />

        <TaskInspectorProperties
          todo={todo}
          projectNameById={projectNameById}
          projectOptions={projectOptions}
          now={now}
          onUpdate={onUpdate}
        />

        <div className="h-px bg-border" />

        {thread ? (
          <TaskAgentSection
            key={thread.id}
            row={row}
            threadId={thread.id}
            projectNameById={projectNameById}
            projectCwdById={projectCwdById}
            onUpdate={onUpdate}
          />
        ) : isDone ? (
          <TaskNotice>Done. Reopen it to delegate it again.</TaskNotice>
        ) : todo.threadId !== null && !status.chatMissing ? (
          // Linked, but the chat has not reached the server yet: no second Start meanwhile.
          <TaskNotice action={{ label: "Open chat", onClick: openChat }}>
            {status.detail ?? "Starting the agent…"}
          </TaskNotice>
        ) : (
          <div className="flex flex-col gap-3">
            {status.chatMissing ? (
              <TaskNotice
                action={{
                  label: "Unlink",
                  onClick: () => onUpdate(unlinkChatInput(todo)),
                }}
              >
                The chat this task was delegated to no longer exists.
              </TaskNotice>
            ) : null}
            <TaskDelegateForm key={todo.id} todo={todo} onLinkChat={onUpdateAsync} />
          </div>
        )}
      </div>
    </aside>
  );
}
