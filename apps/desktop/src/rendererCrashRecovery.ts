// FILE: rendererCrashRecovery.ts
// Purpose: Pure recovery policy for main-window renderer crashes: which exit reasons may
//          be reloaded automatically, the reload backoff, and the cap that stops a loop.
// Layer: Desktop window supervision
// Exports: RendererCrashPolicy, rendererReloadDelayMs, isRecoverableRendererCrashReason

/** First backoff step; doubles per crash inside the same streak. */
export const RENDERER_RELOAD_BASE_DELAY_MS = 500;
export const RENDERER_RELOAD_MAX_DELAY_MS = 4_000;

/**
 * Automatic reloads allowed inside one crash streak before the user is asked instead.
 *
 * A renderer that dies deterministically (a crash on first paint, a leak that OOMs the
 * moment state is restored) would otherwise reload forever, burning CPU and rewriting
 * the same crash to disk. Three attempts across ~3.5s of backoff rides out a transient
 * GPU or OOM kill, and stops well short of a spin loop.
 */
export const RENDERER_MAX_AUTOMATIC_RELOADS = 3;

/**
 * Crashes further apart than this are unrelated incidents, not a loop, so the streak
 * restarts. Bounded by time rather than cleared on a successful load: a reloaded window
 * always finishes loading, so clearing on load would refill the budget every attempt
 * and defeat the cap entirely.
 */
export const RENDERER_CRASH_STREAK_WINDOW_MS = 60_000;

/**
 * Only these reasons are reloaded without asking.
 *
 * "crashed" and "oom" are the recoverable ones: the renderer died on its own and a
 * fresh one usually comes back. "killed"/"abnormal-exit" are typically the OS or the
 * user acting on the process, "launch-failed"/"integrity-failure" repeat on every
 * attempt by construction, and "clean-exit" is not a failure at all.
 */
const RECOVERABLE_RENDERER_CRASH_REASONS: ReadonlySet<string> = new Set(["crashed", "oom"]);

export function isRecoverableRendererCrashReason(reason: string): boolean {
  return RECOVERABLE_RENDERER_CRASH_REASONS.has(reason);
}

export function rendererReloadDelayMs(attempt: number): number {
  const step = Math.max(1, Math.floor(attempt)) - 1;
  return Math.min(RENDERER_RELOAD_BASE_DELAY_MS * 2 ** step, RENDERER_RELOAD_MAX_DELAY_MS);
}

export type RendererCrashResponse =
  /** Shutting down, or the renderer exited cleanly: the caller does nothing. */
  | { readonly kind: "ignore" }
  | { readonly kind: "reload"; readonly delayMs: number; readonly attempt: number }
  /** Recovery needs a human: show the affordance instead of leaving a blank window. */
  | {
      readonly kind: "prompt";
      readonly cause: "unrecoverable" | "reload-budget-exhausted";
      readonly crashes: number;
    };

export interface RendererCrashInput {
  /** `RenderProcessGoneDetails["reason"]`, kept as a string so new Chromium reasons still compile. */
  readonly reason: string;
  readonly quitting: boolean;
  readonly nowMs: number;
}

/** Tracks a streak of renderer crashes and decides reload vs. ask-the-user. */
export class RendererCrashPolicy {
  private crashes = 0;
  private lastCrashAtMs: number | null = null;

  get crashStreak(): number {
    return this.crashes;
  }

  /** Clears the streak for a deliberate, user-driven reload. */
  reset(): void {
    this.crashes = 0;
    this.lastCrashAtMs = null;
  }

  respondToCrash(input: RendererCrashInput): RendererCrashResponse {
    if (input.quitting || input.reason === "clean-exit") {
      return { kind: "ignore" };
    }

    if (
      this.lastCrashAtMs !== null &&
      input.nowMs - this.lastCrashAtMs > RENDERER_CRASH_STREAK_WINDOW_MS
    ) {
      this.crashes = 0;
    }
    this.lastCrashAtMs = input.nowMs;
    this.crashes += 1;

    if (!isRecoverableRendererCrashReason(input.reason)) {
      return { kind: "prompt", cause: "unrecoverable", crashes: this.crashes };
    }

    if (this.crashes > RENDERER_MAX_AUTOMATIC_RELOADS) {
      return { kind: "prompt", cause: "reload-budget-exhausted", crashes: this.crashes };
    }

    return {
      kind: "reload",
      delayMs: rendererReloadDelayMs(this.crashes),
      attempt: this.crashes,
    };
  }
}
