// FILE: cardKeys.ts
// Purpose: Answering an ask card from the keyboard (HoloBot's thread/cardKeys.ts): a card's
//          answers take the letters A, B, C… in the order they show. The keys bubble from the
//          card's own focused controls only (its container's onKeyDown, as Synara's approval
//          panel takes its digits): a bare letter typed anywhere else never answers a card, so
//          a letter meant for a disabled composer cannot approve a command.
// Layer: SynBot thread hooks
// Exports: LETTERS, letterIndex, letterKeyHandler

import type { KeyboardEvent } from "react";

export const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

function isTyping(target: EventTarget | null): boolean {
  if (typeof HTMLElement === "undefined" || !(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT" ||
    target.closest('[contenteditable]:not([contenteditable="false"])') !== null
  );
}

/** The answer index `event` stands for: 0 for A, 1 for B… (-1: not a plain letter). */
export function letterIndex(
  event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey"> & {
    readonly isComposing?: boolean;
  },
): number {
  if (
    event.metaKey ||
    event.ctrlKey ||
    event.altKey ||
    event.shiftKey ||
    event.isComposing ||
    event.key.length !== 1
  ) {
    return -1;
  }
  const code = event.key.toLowerCase().charCodeAt(0) - 97;
  return code >= 0 && code < 26 ? code : -1;
}

/**
 * The card container's onKeyDown: while `count` answers are offered, A… picks the `i`th. Only
 * keys pressed on the card's own controls reach it.
 */
export function letterKeyHandler(
  count: number,
  pick: (index: number) => void,
): (event: KeyboardEvent<HTMLElement>) => void {
  return (event) => {
    if (count === 0 || event.defaultPrevented || isTyping(event.target)) return;
    const index = letterIndex({
      key: event.key,
      metaKey: event.metaKey,
      ctrlKey: event.ctrlKey,
      altKey: event.altKey,
      shiftKey: event.shiftKey,
      isComposing: event.nativeEvent.isComposing,
    });
    if (index < 0 || index >= count) return;
    event.preventDefault();
    pick(index);
  };
}
