const EDITABLE_TAG_SELECTOR = "input, textarea, select";

export function isEditableEventTarget(event: globalThis.KeyboardEvent): boolean {
  const target = event.target;
  if (!(target instanceof Element)) return false;
  if (target.closest(EDITABLE_TAG_SELECTOR) !== null) return true;
  // `isContentEditable` already reflects inherited editability from any contenteditable ancestor, so no manual ancestor walk is needed here.
  return target instanceof HTMLElement && target.isContentEditable;
}
