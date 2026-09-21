// backstop for an alive-but-silent ACP child: session/prompt only settles when the turn finishes, so a wedged child leaves the UI "Working" forever (observed 15+h); real progress resets it, human-input pauses it — not a wall-clock cap on long turns
import { Effect, Fiber, Scope } from "effect";

// mode/command/usage updates are not turn progress — they can keep arriving after output stops and would starve the watchdog
export function isAcpTurnProgressEventTag(tag: string): boolean {
  switch (tag) {
    case "ContentDelta":
    case "ToolCallUpdated":
    case "PlanUpdated":
    case "AssistantItemStarted":
    case "AssistantItemCompleted":
      return true;
    default:
      return false;
  }
}

export interface AcpTurnIdleWatchdogParams {
  readonly idleTimeoutMs: number;
  readonly currentIdleTimeoutMs?: () => number;
  readonly checkIntervalMs: number;
  readonly scope: Scope.Closeable;
  readonly isTurnActive: () => boolean;
  readonly isAwaitingHuman: () => boolean;
  readonly lastActivityAt: () => number;
  readonly touchActivity: () => void;
  readonly onIdleTimeout: (idleMs: number) => Effect.Effect<void>;
}

export type AcpTurnIdleTickDecision = "stop" | "touch" | "timeout" | "continue";

// pure per-tick decision extracted so the reliability-critical logic is unit-testable without clock/fibers
export function evaluateAcpTurnIdleTick(input: {
  readonly isTurnActive: boolean;
  readonly isAwaitingHuman: boolean;
  readonly idleMs: number;
  readonly idleTimeoutMs: number;
}): AcpTurnIdleTickDecision {
  if (!input.isTurnActive) {
    return "stop";
  }
  if (input.isAwaitingHuman) {
    return "touch";
  }
  return input.idleMs >= input.idleTimeoutMs ? "timeout" : "continue";
}

// non-positive/unset/invalid env falls back to defaultMs — a typo can never silently disable the backstop
export function resolveAcpTurnIdleTimeoutMs(input: {
  readonly envVar: string;
  readonly defaultMs: number;
  readonly env?: NodeJS.ProcessEnv;
}): number {
  const raw = (input.env ?? process.env)[input.envVar]?.trim();
  if (!raw) {
    return input.defaultMs;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : input.defaultMs;
}

export const forkAcpTurnIdleWatchdog = (
  params: AcpTurnIdleWatchdogParams,
): Effect.Effect<Fiber.Fiber<void>> =>
  Effect.gen(function* () {
    const loop = Effect.gen(function* () {
      while (true) {
        yield* Effect.sleep(params.checkIntervalMs);
        const idleMs = Date.now() - params.lastActivityAt();
        const currentIdleTimeoutMs = params.currentIdleTimeoutMs?.() ?? params.idleTimeoutMs;
        const decision = evaluateAcpTurnIdleTick({
          isTurnActive: params.isTurnActive(),
          isAwaitingHuman: params.isAwaitingHuman(),
          idleMs,
          idleTimeoutMs: currentIdleTimeoutMs,
        });
        if (decision === "stop") {
          return;
        }
        if (decision === "touch") {
          // The agent is blocked on a human decision, not hung: keep the clock fresh so the turn cannot trip the watchdog the instant it resumes.
          params.touchActivity();
          continue;
        }
        if (decision === "timeout") {
          yield* params.onIdleTimeout(idleMs);
          return;
        }
      }
    });
    return yield* loop.pipe(Effect.forkIn(params.scope));
  });
