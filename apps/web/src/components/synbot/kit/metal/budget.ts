// FILE: budget.ts
// Purpose: How many liquid metals hold a WebGL context at once (HoloBot's packages/ui
//          rim/budget.ts). WebKit keeps about 16 contexts per page and silently drops the oldest
//          past that, so its metal would vanish. The newest LIVE_METALS draw with the shader; an
//          older one becomes a still picture of its last frame (one image, no context) until
//          enough newer ones unmount.
// Layer: SynBot kit (metal)
// Exports: LIVE_METALS, useLiveMetal

import { useEffect, useState, useSyncExternalStore } from "react";

/** Shader metals that may hold a WebGL context at the same time. */
export const LIVE_METALS = 8;

/** Mounted metals, oldest first. */
let order: number[] = [];
let next = 0;
const listeners = new Set<() => void>();

function changed() {
  for (const listener of listeners) listener();
}

function add(id: number): () => void {
  order = [...order, id];
  changed();
  return () => {
    order = order.filter((other) => other !== id);
    changed();
  };
}

/** Metal `id` may hold a context: it is among the newest LIVE_METALS (or not counted yet). */
function isLive(id: number): boolean {
  const at = order.indexOf(id);
  return at < 0 || at >= order.length - LIVE_METALS;
}

function subscribe(onChange: () => void) {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

/** For a metal: whether it may draw with the shader now. */
export function useLiveMetal(): boolean {
  const [id] = useState(() => ++next);
  useEffect(() => add(id), [id]);
  return useSyncExternalStore(
    subscribe,
    () => isLive(id),
    () => false,
  );
}
