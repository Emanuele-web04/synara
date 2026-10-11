// FILE: newTaskShortcut.ts
// Purpose: The "new task" shortcut shared by Kanban and Tasks: ⌘⌥T on macOS, Ctrl+Alt+T
//          elsewhere — the app's mod convention and its ⌘⌥ "create new X" family.
// Layer: Web keyboard helper
// Exports: NEW_TASK_SHORTCUT_LABEL, isNewTaskShortcut

import { isMacNavigatorPlatform } from "~/lib/utils";

export const NEW_TASK_SHORTCUT_LABEL = isMacNavigatorPlatform() ? "⌥⌘T" : "Ctrl+Alt+T";

/** Matched on event.code so it survives Alt remapping the produced character on some layouts. */
export function isNewTaskShortcut(event: KeyboardEvent): boolean {
  if (event.code !== "KeyT" || event.repeat || event.shiftKey || !event.altKey) {
    return false;
  }
  return isMacNavigatorPlatform()
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey;
}
