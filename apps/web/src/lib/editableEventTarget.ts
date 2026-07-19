// FILE: editableEventTarget.ts
// Purpose: Detect when a keyboard event targets (or descends from) a native
// text-editing surface — input, textarea, select, or a contenteditable
// element — so global keyboard-shortcut handlers can avoid hijacking regular
// text editing (e.g. native OS text-navigation bindings like macOS Ctrl+B).
// Layer: Web DOM utilities (no React, no app state).

const EDITABLE_TAG_SELECTOR = "input, textarea, select";

export function isEditableEventTarget(event: globalThis.KeyboardEvent): boolean {
  const target = event.target;
  if (!(target instanceof Element)) return false;
  if (target.closest(EDITABLE_TAG_SELECTOR) !== null) return true;
  // `isContentEditable` already reflects inherited editability from any
  // contenteditable ancestor, so no manual ancestor walk is needed here.
  return target instanceof HTMLElement && target.isContentEditable;
}
