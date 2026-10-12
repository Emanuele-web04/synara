import { performance } from "node:perf_hooks";

const MAX_TICK_MS = 250;

/**
 * Calls `onExpire` once the event loop has been free to run for `budgetMs`.
 *
 * A plain `setTimeout` cannot bound async I/O across a stall: when the loop
 * unblocks, expired timers run before the poll phase delivers I/O that finished
 * meanwhile, so one multi-second stall expires work that was healthy. Each tick
 * charges at most one tick interval, so a stalled gap costs a single tick while
 * a genuinely hung operation on a responsive loop still expires on time.
 *
 * Returns a function that cancels the deadline.
 */
export function startEventLoopDeadline(
  budgetMs: number,
  onExpire: () => void,
  now: () => number = () => performance.now(),
): () => void {
  const tickMs = Math.max(1, Math.min(MAX_TICK_MS, Math.ceil(budgetMs / 4)));
  let spentMs = 0;
  let lastTickAt = now();
  const timer = setInterval(() => {
    const tickAt = now();
    spentMs += Math.min(Math.max(0, tickAt - lastTickAt), tickMs);
    lastTickAt = tickAt;
    if (spentMs < budgetMs) return;
    clearInterval(timer);
    onExpire();
  }, tickMs);
  timer.unref();
  return () => clearInterval(timer);
}
