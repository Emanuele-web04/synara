// FILE: TaskTextFields.tsx
// Purpose: The task card's editable title and notes. Each field saves on blur, only when
//          the user changed it, so an untouched field never overwrites another window's edit.
// Layer: Tasks UI component
// Exports: TaskTextFields

import type { TodoUpdateInput } from "@synara/contracts";
import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from "react";

import type { TaskRowModel } from "./tasks.logic";

export function TaskTextFields({
  row,
  onUpdate,
  trailing,
  autoFocusNotes = false,
}: {
  row: TaskRowModel;
  onUpdate: (input: TodoUpdateInput) => void;
  /** Sits on the title's first line, e.g. the card's Close button. */
  trailing?: ReactNode;
  /** Puts the cursor in the note once it mounts, for details to hand off with the task. */
  autoFocusNotes?: boolean;
}) {
  const { todo } = row;
  const notesRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (autoFocusNotes) notesRef.current?.focus();
  }, [autoFocusNotes]);
  const [title, setTitle] = useState(todo.title);
  const [notes, setNotes] = useState(todo.notes);
  // Adopt remote edits (another window, the row's inline rename) when not mid-edit.
  const [focusedField, setFocusedField] = useState<"title" | "notes" | null>(null);
  useEffect(() => {
    if (focusedField !== "title") setTitle(todo.title);
  }, [focusedField, todo.title]);
  useEffect(() => {
    if (focusedField !== "notes") setNotes(todo.notes);
  }, [focusedField, todo.notes]);

  // Escape blurs the field too; the blur must not save what Escape discarded.
  const discardTitleOnBlurRef = useRef(false);
  // The value each field held when focused: a blur saves only what the user changed since,
  // so an untouched field never writes back over another window's edit.
  const focusedValueRef = useRef("");
  const focusField = (field: "title" | "notes") => {
    focusedValueRef.current = field === "title" ? title : notes;
    setFocusedField(field);
  };
  const commitTitle = () => {
    setFocusedField(null);
    const next = title.trim();
    if (discardTitleOnBlurRef.current || next === focusedValueRef.current.trim()) {
      discardTitleOnBlurRef.current = false;
      setTitle(todo.title);
      return;
    }
    if (next.length === 0) {
      setTitle(todo.title);
    } else if (next !== todo.title) {
      onUpdate({ id: todo.id, title: next });
    }
  };
  const commitNotes = () => {
    setFocusedField(null);
    if (notes === focusedValueRef.current) {
      setNotes(todo.notes);
      return;
    }
    if (notes !== todo.notes) onUpdate({ id: todo.id, notes });
  };
  const handleTitleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter") {
      event.preventDefault();
      event.currentTarget.blur();
    } else if (event.key === "Escape") {
      discardTitleOnBlurRef.current = true;
      event.currentTarget.blur();
    }
  };

  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-start gap-2">
        <textarea
          aria-label="Task title"
          rows={1}
          value={title}
          onFocus={() => focusField("title")}
          onChange={(event) => setTitle(event.target.value)}
          onBlur={commitTitle}
          onKeyDown={handleTitleKeyDown}
          className="font-system-ui field-sizing-content min-w-0 flex-1 resize-none bg-transparent text-ui-lg font-semibold leading-snug text-foreground outline-none"
        />
        {trailing}
      </div>
      <textarea
        ref={notesRef}
        aria-label="Notes"
        rows={1}
        value={notes}
        placeholder="Add a note"
        onFocus={() => focusField("notes")}
        onChange={(event) => setNotes(event.target.value)}
        onBlur={commitNotes}
        className="font-system-ui field-sizing-content min-h-5 w-full resize-none bg-transparent text-ui-sm leading-relaxed text-muted-foreground outline-none placeholder:text-muted-foreground/70 focus:text-foreground"
      />
    </div>
  );
}
