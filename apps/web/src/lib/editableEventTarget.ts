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

/** Whether a visible overlay owns keyboard interaction instead of the active chat. */
export function hasOpenDismissibleOverlay(): boolean {
  return Array.from(
    document.querySelectorAll<HTMLElement>(
      '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [data-slot="context-menu-popup"], [data-testid="composer-extras-panel"]',
    ),
  ).some(
    (element) =>
      !element.closest('[inert], [aria-hidden="true"]') && element.getClientRects().length > 0,
  );
}
