// FILE: TaskQuickAdd.tsx
// Purpose: The list's last row, where a new task is typed: Enter adds it, Tab adds it and
//          opens its card with the cursor in the note (⌘↵ there hands it to an agent),
//          Escape clears the line. A title the server
//          rejects comes back if nothing new was typed.
// Layer: Tasks UI component
// Exports: TaskQuickAdd

import { type KeyboardEvent, type RefObject, useState } from "react";

export function TaskQuickAdd({
  inputRef,
  placeholder = "Add a task, or press Tab to hand it to an agent",
  onCreate,
}: {
  inputRef: RefObject<HTMLInputElement | null>;
  placeholder?: string;
  /** `open` asks to open the new task's card right away (Tab). */
  onCreate: (title: string, options: { open: boolean; onError: () => void }) => void;
}) {
  const [draftTitle, setDraftTitle] = useState("");

  const addTask = (open: boolean) => {
    const title = draftTitle.trim();
    if (title.length === 0) return false;
    setDraftTitle("");
    onCreate(title, {
      open,
      // Give the typed title back if the server didn't take it and nothing new was typed.
      onError: () => setDraftTitle((current) => (current.length === 0 ? title : current)),
    });
    return true;
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter") {
      event.preventDefault();
      addTask(false);
    } else if (event.key === "Tab" && !event.shiftKey) {
      // An empty line keeps Tab's usual focus move.
      if (addTask(true)) event.preventDefault();
    } else if (event.key === "Escape") {
      setDraftTitle("");
      event.currentTarget.blur();
    }
  };

  return (
    <label className="flex min-h-10.5 items-center gap-3 rounded-xl px-3">
      <svg viewBox="0 0 18 18" fill="none" aria-hidden className="size-4.5 shrink-0">
        <circle
          cx="9"
          cy="9"
          r="7.25"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeDasharray="2 3"
          className="text-muted-foreground/45"
        />
      </svg>
      <input
        ref={inputRef}
        aria-label="New task"
        placeholder={placeholder}
        value={draftTitle}
        onChange={(event) => setDraftTitle(event.target.value)}
        onKeyDown={handleKeyDown}
        className="font-system-ui h-10 min-w-0 flex-1 bg-transparent text-ui text-foreground outline-none placeholder:text-muted-foreground/70"
      />
    </label>
  );
}
