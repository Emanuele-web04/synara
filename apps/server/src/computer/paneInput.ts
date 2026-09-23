/**
 * Marks desktop input the human sends from the Computer pane.
 *
 * The pane forwards a click, a wheel notch or a key as it happens, through the
 * same manager and backend path an agent's action takes, so a backend cannot
 * tell the two apart from the call alone. It needs to for presentation only:
 * the eased glide that makes an agent's pointer readable to someone watching
 * is pure latency on input the human is making themselves, and on a wheel it
 * queued one 180 ms glide per notch. Nothing here grants or relaxes anything —
 * pane input goes through every guard and lease an agent's input does.
 *
 * Carried on AsyncLocalStorage because the manager queues the action and runs
 * it later; the store travels with the queued continuation.
 *
 * @module computer/paneInput
 */
import { AsyncLocalStorage } from "node:async_hooks";

const paneInput = new AsyncLocalStorage<true>();

/** Runs `action` as the human's own pane input. */
export function withPaneInput<A>(action: () => A): A {
  return paneInput.run(true, action);
}

/** Whether the input being dispatched now came from the human at the pane. */
export function isPaneInput(): boolean {
  return paneInput.getStore() === true;
}
