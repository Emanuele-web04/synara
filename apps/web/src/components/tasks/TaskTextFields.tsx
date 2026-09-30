// FILE: TaskTextFields.tsx
// Purpose: The task card's editable title and notes. Each field saves on blur, only when
//          the user changed it, so an untouched field never overwrites another window's edit.
// Layer: Tasks UI component
// Exports: TaskTextFields

import type { TodoUpdateInput } from "@synara/contracts";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";

import type { TaskRowModel } from "./tasks.logic";

export function TaskTextFields({
  row,
  onUpdate,
}: {
  row: TaskRowModel;
  onUpdate: (input: TodoUpdateInput) => void;
}) {
  const { todo } = row;
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
    <div className="flex flex-col gap-1">
      <textarea
        aria-label="Task title"
        rows={1}
        value={title}
        onFocus={() => focusField("title")}
        onChange={(event) => setTitle(event.target.value)}
        onBlur={commitTitle}
        onKeyDown={handleTitleKeyDown}
        // The card's heading, so it may use a fixed heading size (see uiFontSize.test.ts).
        className="font-system-ui field-sizing-content w-full resize-none bg-transparent text-lg font-semibold leading-snug tracking-tight text-foreground outline-none"
      />
      <textarea
        aria-label="Notes"
        rows={1}
        value={notes}
        placeholder="Add a note"
        onFocus={() => focusField("notes")}
        onChange={(event) => setNotes(event.target.value)}
        onBlur={commitNotes}
        className="font-system-ui field-sizing-content min-h-6 w-full resize-none bg-transparent text-ui leading-relaxed text-muted-foreground outline-none placeholder:text-muted-foreground/70 focus:text-foreground"
      />
    </div>
  );
}
