// FILE: motion.ts
// Purpose: Reduce Motion for the SynBot kit (HoloBot's packages/ui motion.ts): the jump to the
//          latest message lands at once instead of gliding while it is on.
// Layer: SynBot kit (hook)
// Exports: useReducedMotion

import { useSyncExternalStore } from "react";

const REDUCED = "(prefers-reduced-motion: reduce)";

function reducedQuery(): MediaQueryList | null {
  return typeof matchMedia === "function" ? matchMedia(REDUCED) : null;
}

function subscribe(onChange: () => void) {
  const query = reducedQuery();
  query?.addEventListener("change", onChange);
  return () => query?.removeEventListener("change", onChange);
}

/** Reduce Motion is on (follows the system setting live). */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => reducedQuery()?.matches ?? false,
    () => false,
  );
}
