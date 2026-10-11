// FILE: processSpawnOutcome.ts
// Purpose: Records positive evidence that an owned Node child never spawned.
// Layer: Shared platform runtime

import type { ChildProcess } from "node:child_process";
import { errorMonitor, type EventEmitter } from "node:events";

const failedSpawns = new WeakSet<object>();

/**
 * Observe at the spawn boundary, before SDK error handlers can request teardown.
 * errorMonitor preserves Node's error delivery (and unhandled-error behavior).
 * An absent PID alone is deliberately not evidence of a failed spawn.
 */
export function trackProcessSpawn<T extends ChildProcess>(child: T): T {
  // ChildProcess narrows once() to string events; EventEmitter supports symbols.
  const emitter: EventEmitter = child;
  const onSpawn = () => emitter.removeListener(errorMonitor, onError);
  const onError = () => {
    emitter.removeListener("spawn", onSpawn);
    if (child.pid === undefined) failedSpawns.add(child);
  };
  emitter.once(errorMonitor, onError);
  emitter.once("spawn", onSpawn);
  return child;
}

export function didProcessFailToSpawn(child: object): boolean {
  return failedSpawns.has(child);
}
