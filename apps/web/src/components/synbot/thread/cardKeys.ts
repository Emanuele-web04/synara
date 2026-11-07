// FILE: cardKeys.ts
// Purpose: Answering an ask card from the keyboard (HoloBot's thread/cardKeys.ts): the focused
//          card's answers take the letters A, B, C… in the order they show. One card is focused
//          at a time (the newest open ask of the thread, `CardFocus`). Letters are taken only when
//          no text is being typed, no modifier is held and no dialog or menu is open.
// Layer: SynBot thread hooks
// Exports: CardFocus, LETTERS, letterIndex, useLetterKeys

import { createContext, useContext, useEffect, useRef } from "react";

/** The card inside answers the letters. */
export const CardFocus = createContext(false);

export const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT"
  );
}

function somethingOver(): boolean {
  return document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"]') !== null;
}

/** The answer index `event` stands for: 0 for A, 1 for B… (-1: not a plain letter). */
export function letterIndex(
  event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "isComposing">,
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

/** While the card is focused and `count` answers are offered, A… picks the `i`th. */
export function useLetterKeys(count: number, pick: (index: number) => void): void {
  const focused = useContext(CardFocus);
  const latest = useRef(pick);
  useEffect(() => {
    latest.current = pick;
  });
  useEffect(() => {
    if (!focused || count === 0) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isTyping(event.target) || somethingOver()) return;
      const index = letterIndex(event);
      if (index < 0 || index >= count) return;
      event.preventDefault();
      latest.current(index);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [focused, count]);
}
