import * as path from "node:path";
import { Effect, Semaphore } from "effect";

const ACTIVITY_PERMITS = Number.MAX_SAFE_INTEGER;
const gates = new Map<string, Semaphore.Semaphore>();

function gateFor(homeDir: string) {
  const key = path.resolve(homeDir);
  let gate = gates.get(key);
  if (!gate) {
    gate = Semaphore.makeUnsafe(ACTIVITY_PERMITS);
    gates.set(key, gate);
  }
  return gate;
}

// Normal engine, terminal, settings and automation work remains concurrent.
export function withWorktreeLifecycle<A, E, R>(
  homeDir: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  return Effect.suspend(() => gateFor(homeDir).withPermits(1)(effect));
}

// Cleanup skips an occupied lifecycle instead of delaying active work or
// waiting with Git's mutation lock held. Once admitted it excludes new owners.
export function withWorktreeRemoval<A, E, R>(homeDir: string, effect: Effect.Effect<A, E, R>) {
  return Effect.suspend(() => gateFor(homeDir).withPermitsIfAvailable(ACTIVITY_PERMITS)(effect));
}
