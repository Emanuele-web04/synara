// FILE: useDesktopQuitPreference.ts
// Purpose: Read and change whether an idle desktop quit asks first, shared by
//          the quit dialog and Settings so both show the same choice.
// Layer: Web hook
// Depends on: the desktop bridge. A browser has no quit question, so it asks.

import { useEffect, useSyncExternalStore } from "react";

let asks = true;
let loaded = false;
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
      if (typeof value !== "boolean" || value === asks) return;
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
  asks = next;
  emit();
  const set = window.desktopBridge?.setQuitAsks;
  if (typeof set === "function") {
    void set(next).catch(() => {
      // The visible choice is still this run's choice; the next launch re-reads the file.
    });
  }
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
