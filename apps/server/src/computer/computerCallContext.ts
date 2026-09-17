import { AsyncLocalStorage } from "node:async_hooks";

import type { ComputerBackendActionResult } from "./ComputerBackend.ts";

/**
 * Per-computer-call context for the action path, carried on
 * AsyncLocalStorage so one tool call's dispatch, settle, and observation see
 * the same record without the gateway handing anything through.
 *
 * The context carries two things, each behind its own flag:
 *
 * - `timing` — a `ComputerCallTiming` the manager and backend record legs
 *   into (resolve, dispatch, settle, observe, the native calls beneath them),
 *   emitted as one `[computer-timing]` line when the outermost call ends.
 *   `SYNARA_CUA_TIMING_LOG=1` only; unset, no record exists and the leg
 *   helpers are passthroughs.
 * - `actionProof` — the delivery verdict of the most recent action in the
 *   call, consumed once by the post-action observer when
 *   `SYNARA_CUA_CONDITIONAL_SETTLE=1` lets a proven effect waive the fixed
 *   settle. Scoped to the call so a stale verdict can never waive a later
 *   call's wait.
 *
 * When neither flag is set no context is created at all, so the default path
 * keeps its exact current shape.
 */

function envFlagEnabled(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "on" || normalized === "yes";
}

/** `SYNARA_CUA_TIMING_LOG=1` emits one `[computer-timing]` line per computer call. */
export function cuaTimingLogEnabled(): boolean {
  return envFlagEnabled(process.env.SYNARA_CUA_TIMING_LOG);
}

/**
 * `SYNARA_CUA_CONDITIONAL_SETTLE=1` lets the post-action settle be skipped
 * when the action's own delivery result already proves its effect.
 */
export function cuaConditionalSettleEnabled(): boolean {
  return envFlagEnabled(process.env.SYNARA_CUA_CONDITIONAL_SETTLE);
}

/**
 * `SYNARA_CUA_ACTION_SETTLE_MS` overrides the fixed post-action settle.
 * Unset or unparsable means the compiled-in default; an explicit 0 removes
 * the wait entirely.
 */
export function cuaActionSettleMsOverride(): number | undefined {
  const raw = process.env.SYNARA_CUA_ACTION_SETTLE_MS;
  if (raw === undefined || raw.trim() === "") return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

/**
 * What the backend established about the input it just delivered, verbatim:
 * `effect` is `verified` only when the driver proved the outcome, and
 * `verified` is `confirmed` only when an independent read-back saw it.
 */
export interface ComputerActionProof {
  readonly effect: ComputerBackendActionResult["effect"];
  readonly verified: ComputerBackendActionResult["verified"];
}

/**
 * One line per computer call: the operation name, each instrumented leg's
 * summed milliseconds, counters for repeated or skipped work, and the call's
 * wall time. Durations, counts, and fixed operation names only — window
 * titles, labels, pixels, and payload bytes never appear here.
 */
export class ComputerCallTiming {
  private operation: string | undefined;
  private readonly startedAt: number;
  private readonly legs = new Map<string, number>();
  private readonly counts = new Map<string, number>();
  private failed = false;
  private finished = false;

  constructor(private readonly now: () => number = Date.now) {
    this.startedAt = now();
  }

  /** First writer wins: the outermost instrumented method names the call. */
  setOperation(operation: string): void {
    this.operation ??= operation;
  }

  markFailed(): void {
    this.failed = true;
  }

  /** Milliseconds spent in one named leg; repeated spans accumulate. */
  record(leg: string, ms: number): void {
    this.legs.set(leg, (this.legs.get(leg) ?? 0) + ms);
  }

  /** An occurrence that is not a duration, like a waived settle. */
  count(name: string, by = 1): void {
    this.counts.set(name, (this.counts.get(name) ?? 0) + by);
  }

  async span<A>(leg: string, run: () => Promise<A>): Promise<A> {
    const started = this.now();
    try {
      return await run();
    } finally {
      this.record(leg, this.now() - started);
    }
  }

  finish(): void {
    if (this.finished) return;
    this.finished = true;
    const parts = [`op=${this.operation ?? "computer_call"}`];
    for (const [leg, ms] of [...this.legs.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      parts.push(`${leg}_ms=${ms.toFixed(1)}`);
    }
    for (const [name, count] of [...this.counts.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      parts.push(`${name}=${count}`);
    }
    parts.push(`total_ms=${(this.now() - this.startedAt).toFixed(1)}`);
    if (this.failed) parts.push("failed=1");
    console.info(`[computer-timing] ${parts.join(" ")}`);
  }
}

export class ComputerCallContext {
  readonly timing: ComputerCallTiming | undefined;
  private proof: ComputerActionProof | undefined;

  constructor(options: { readonly timing?: ComputerCallTiming }) {
    this.timing = options.timing;
  }

  /** The latest action's delivery verdict replaces the previous one's. */
  recordActionProof(result: ComputerBackendActionResult | void): void {
    this.proof = { effect: result?.effect, verified: result?.verified };
  }

  /** Read once by the post-action observer, then cleared. */
  takeActionProof(): ComputerActionProof | undefined {
    const proof = this.proof;
    this.proof = undefined;
    return proof;
  }
}

const computerCalls = new AsyncLocalStorage<ComputerCallContext>();

export function currentComputerCall(): ComputerCallContext | undefined {
  return computerCalls.getStore();
}

export function withComputerCallContext<A>(
  context: ComputerCallContext,
  run: () => Promise<A>,
): Promise<A> {
  return computerCalls.run(context, run);
}

/**
 * The context for one computer call, or nothing when neither flag is set —
 * the default path then allocates nothing and reads nothing back.
 */
export function createComputerCallContext(): ComputerCallContext | undefined {
  const timing = cuaTimingLogEnabled() ? new ComputerCallTiming() : undefined;
  if (timing === undefined && !cuaConditionalSettleEnabled()) return undefined;
  return new ComputerCallContext(timing === undefined ? {} : { timing });
}

/** Records `leg`'s duration on the active call's timing record, when one exists. */
export async function timedComputerLeg<A>(leg: string, run: () => Promise<A>): Promise<A> {
  const timing = currentComputerCall()?.timing;
  return timing === undefined ? run() : timing.span(leg, run);
}

/** Names the active call after the tool-level operation running it. */
export function markComputerCall(operation: string): void {
  currentComputerCall()?.timing?.setOperation(operation);
}
