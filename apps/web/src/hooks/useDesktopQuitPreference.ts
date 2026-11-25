// FILE: useDesktopQuitPreference.ts
// Purpose: Read and change whether an idle desktop quit asks first, shared by
//          the quit dialog and Settings so both show the same choice.
// Layer: Web hook
// Depends on: the desktop bridge. A browser has no quit question, so it asks.

import { useEffect, useSyncExternalStore } from "react";

let asks = true;
let savedAsks = true;
let loaded = false;
let saveSequence = 0;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function snapshot(): boolean {
  return asks;
}

function load(): void {
  if (loaded) return;
  const get = window.desktopBridge?.getQuitAsks;
  if (typeof get !== "function") return;
  loaded = true;
  void get()
    .then((value) => {
      if (typeof value !== "boolean") return;
      savedAsks = value;
      if (value === asks) return;
      asks = value;
      emit();
    })
    .catch(() => {
      // Let a later mount retry if the handler was not ready yet.
      loaded = false;
    });
}

/** The cached choice, for callbacks that cannot wait on a hook render. */
export function desktopQuitAsks(): boolean {
  return asks;
}

/** Change the choice everywhere, and persist it in the desktop app. */
export function setDesktopQuitAsks(next: boolean): void {
  if (asks === next) return;
  const previous = asks;
  asks = next;
  emit();

  const bridge = window.desktopBridge;
  if (!bridge) {
    savedAsks = next;
    return;
  }
  const set = bridge.setQuitAsks;
  if (typeof set !== "function") {
    savedAsks = next;
    return;
  }

  const sequence = ++saveSequence;
  let result: Promise<boolean> | undefined;
  try {
    result = set(next);
  } catch {
    asks = previous;
    emit();
    return;
  }
  if (!result || typeof result.then !== "function") return;

  void result
    .then((saved) => {
      if (saved) {
        savedAsks = next;
        return;
      }
      if (sequence !== saveSequence) return;
      asks = savedAsks;
      emit();
    })
    .catch(() => {
      if (sequence !== saveSequence) return;
      asks = savedAsks;
      emit();
    });
}

export function useDesktopQuitPreference(): {
  asks: boolean;
  setAsks: (asks: boolean) => void;
} {
  const current = useSyncExternalStore(subscribe, snapshot, snapshot);

  useEffect(() => {
    load();
  }, []);

  return { asks: current, setAsks: setDesktopQuitAsks };
}
