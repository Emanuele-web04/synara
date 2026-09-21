import { cuaTimingLogEnabled } from "./computerCallContext.ts";

type TurnTiming = {
  started: number;
  origin: "provider-turn-start" | "first-computer-call";
  firstObservation?: number;
  lastObservation?: number;
  firstWrite?: number;
};

/** Opt-in local timing only: no screenshots, payloads, or model context. */
export class ComputerTurnTimings {
  private readonly turns = new Map<string, TurnTiming>();

  constructor(
    private readonly now: () => number = performance.now.bind(performance),
    private readonly emit: (value: Record<string, number | string>) => void = (value) =>
      console.info(`[computer-turn-timing] ${JSON.stringify(value)}`),
  ) {}

  start(threadId: string, turnId: string, origin: TurnTiming["origin"] = "provider-turn-start") {
    const key = JSON.stringify([threadId, turnId]);
    if (this.turns.has(key)) return;
    while (this.turns.size >= 256) this.turns.delete(this.turns.keys().next().value!);
    this.turns.set(key, { started: this.now(), origin });
  }

  end(threadId: string, turnId?: string) {
    for (const key of this.turns.keys()) {
      const [thread, turn] = JSON.parse(key) as [string, string];
      if (thread === threadId && (turnId === undefined || turn === turnId)) this.turns.delete(key);
    }
  }

  begin(threadId: string, turnId: string, kind: "observation" | "write") {
    this.start(threadId, turnId, "first-computer-call");
    const key = JSON.stringify([threadId, turnId]);
    const state = this.turns.get(key)!;
    const started = this.now();
    // Capture the preceding observation at dispatch, not completion: a
    // concurrent read must not produce a negative observe-to-write interval.
    const observation = state.lastObservation;
    return (completed: boolean) => {
      if (!completed || this.turns.get(key) !== state) return;
      const ended = this.now();
      if (kind === "observation") {
        state.firstObservation ??= ended;
        state.lastObservation = ended;
      } else {
        state.firstWrite ??= started;
      }
      this.emit({
        threadId,
        turnId,
        origin: state.origin,
        kind,
        call_start_ms: Math.max(0, started - state.started),
        call_end_ms: Math.max(0, ended - state.started),
        ...(state.firstObservation === undefined
          ? {}
          : { time_to_first_observation_ms: Math.max(0, state.firstObservation - state.started) }),
        ...(state.firstWrite === undefined
          ? {}
          : { time_to_first_write_ms: Math.max(0, state.firstWrite - state.started) }),
        ...(kind !== "write" || observation === undefined
          ? {}
          : {
              observe_to_write_start_ms: Math.max(0, started - observation),
              observe_to_write_end_ms: Math.max(0, ended - observation),
            }),
      });
    };
  }
}

const timings = new ComputerTurnTimings();
export function startComputerTurnTiming(threadId: string, turnId: string) {
  if (cuaTimingLogEnabled()) timings.start(threadId, turnId);
}
export function endComputerTurnTiming(threadId: string, turnId?: string) {
  timings.end(threadId, turnId);
}
export function beginComputerTurnCall(
  threadId: string,
  turnId: string | undefined,
  kind: "observation" | "write",
) {
  return cuaTimingLogEnabled() && turnId ? timings.begin(threadId, turnId, kind) : undefined;
}
