// FILE: TaskQuickAdd.tsx
// Purpose: The "New task" line at the top of the list: type a title, press Enter. Escape
//          clears it; a title the server rejects comes back if nothing new was typed.
// Layer: Tasks UI component
// Exports: TaskQuickAdd

import { type KeyboardEvent, type RefObject, useState } from "react";

import { PlusIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { TASK_LIST_INSET_CLASS } from "./taskListStyles";

export function TaskQuickAdd({
  inputRef,
  onCreate,
}: {
  inputRef: RefObject<HTMLInputElement | null>;
  onCreate: (title: string, options: { onError: () => void }) => void;
}) {
  const [draftTitle, setDraftTitle] = useState("");

  const addTask = () => {
    const title = draftTitle.trim();
    if (title.length === 0) return;
    setDraftTitle("");
    onCreate(title, {
      // Give the typed title back if the server didn't take it and nothing new was typed.
      onError: () => setDraftTitle((current) => (current.length === 0 ? title : current)),
    });
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" && !event.nativeEvent.isComposing) {
      event.preventDefault();
      addTask();
    } else if (event.key === "Escape") {
      setDraftTitle("");
      event.currentTarget.blur();
    }
  };

  return (
    <div
      className={cn(
        "flex h-10 items-center gap-2.5 border-b border-border px-5",
        TASK_LIST_INSET_CLASS,
      )}
    >
      <PlusIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground/70" />
      <input
        ref={inputRef}
        aria-label="New task"
        placeholder="New task"
        value={draftTitle}
        onChange={(event) => setDraftTitle(event.target.value)}
        onKeyDown={handleKeyDown}
        className="font-system-ui min-w-0 flex-1 bg-transparent text-ui text-foreground outline-none placeholder:text-muted-foreground/70"
      />
    </div>
  );
}
