// FILE: TaskRowTitle.tsx
// Purpose: A task row's title — a button that reads as text, or, while renaming, an input.
//          The rename state lives in a hook because the row's context menu starts it too.
// Layer: Tasks UI component
// Exports: TaskRowTitle, useTaskRename

import type { Todo, TodoUpdateInput } from "@synara/contracts";
import { type KeyboardEvent, useState } from "react";

import { cn } from "~/lib/utils";

export function useTaskRename(
  todo: Pick<Todo, "id" | "title">,
  onUpdate: (input: TodoUpdateInput) => void,
) {
  const [isEditing, setIsEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState(todo.title);
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
  return { isEditing, draftTitle, setDraftTitle, startEditing, commitTitle, handleTitleKeyDown };
}

export function TaskRowTitle({
  title,
  isDone,
  rename,
}: {
  title: string;
  isDone: boolean;
  rename: ReturnType<typeof useTaskRename>;
}) {
  const { isEditing, draftTitle, setDraftTitle, startEditing, commitTitle, handleTitleKeyDown } =
    rename;
  if (isEditing) {
    return (
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
    );
  }
  return (
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
      {title}
    </button>
  );
}
