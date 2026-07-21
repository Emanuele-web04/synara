// FILE: KanbanNewTaskDialog.logic.ts
// Purpose: Pure helpers for the kanban new-task composer dialog.
// Layer: Kanban UI logic (no React/store side effects)
// Exports: transcript merge and task preview helpers.

export function appendKanbanTaskTranscript(current: string, transcript: string): string {
  const trimmed = transcript.trim();
  if (trimmed.length === 0) {
    return current;
  }
  if (current.trim().length === 0) {
    return trimmed;
  }
  return `${current.trimEnd()} ${trimmed}`;
}

export function buildKanbanTaskPreview(input: {
  readonly trimmedPrompt: string;
  readonly firstImageName?: string | null | undefined;
  readonly assistantSelectionCount: number;
}): string {
  if (input.trimmedPrompt.length > 0) {
    return input.trimmedPrompt;
  }
  if (input.firstImageName) {
    return `Image: ${input.firstImageName}`;
  }
  if (input.assistantSelectionCount > 0) {
    return "Referenced assistant selection";
  }
  return "New task";
}

export function truncateKanbanTaskPreview(preview: string, maxLength = 80): string {
  return preview.length > maxLength ? `${preview.slice(0, maxLength)}…` : preview;
}
