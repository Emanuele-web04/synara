import type { KeyboardEvent } from "react";

export function isContextMenuKeyboardEvent(
  event: Pick<KeyboardEvent, "key" | "shiftKey">,
): boolean {
  return event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey);
}

export function getKeyboardContextMenuPoint(
  rect: Pick<DOMRect, "left" | "top" | "width" | "height">,
) {
  return {
    x: rect.left + Math.min(16, rect.width / 2),
    y: rect.top + rect.height,
  };
}

export function openContextMenuFromKeyboard(event: KeyboardEvent<HTMLElement>): boolean {
  if (!isContextMenuKeyboardEvent(event)) {
    return false;
  }

  event.preventDefault();
  event.stopPropagation();
  const point = getKeyboardContextMenuPoint(event.currentTarget.getBoundingClientRect());
  event.currentTarget.dispatchEvent(
    new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: point.x,
      clientY: point.y,
      button: 2,
    }),
  );
  return true;
}
