import { type AutomationStreamEvent } from "@t3tools/contracts";
import { Cause, Duration, Effect, Layer, Queue, Stream } from "effect";

import { AutomationRepository } from "../../persistence/Services/AutomationRepository.ts";
import { AutomationService } from "../Services/AutomationService.ts";
import {
  AutomationScheduler,
  type AutomationSchedulerShape,
} from "../Services/AutomationScheduler.ts";

const DEFAULT_AUTOMATION_SCHEDULER_INTERVAL_MS = 60_000;

function shouldWakeScheduler(event: AutomationStreamEvent): boolean {
  return (
    event.type === "definition-upserted" ||
    event.type === "definition-deleted" ||
    (event.type === "run-upserted" &&
      event.run.result?.completionEvaluation !== undefined)
  );
}

export interface AutomationSchedulerLiveOptions {
  readonly intervalMs?: number;
}

export const makeAutomationSchedulerLive = (options?: AutomationSchedulerLiveOptions) =>
  Layer.effect(
    AutomationScheduler,
    Effect.gen(function* () {
      const automationService = yield* AutomationService;
      const automationRepository = yield* AutomationRepository;
      const intervalMs = Math.max(
        1,
        options?.intervalMs ?? DEFAULT_AUTOMATION_SCHEDULER_INTERVAL_MS,
      );

      // Each pass first reconciles in-flight runs against their thread state (a backstop for
      // any completion the event reactor missed), then starts newly-due runs.
      const runPassSafely = automationService.reconcileActiveRuns().pipe(
        Effect.flatMap(() => automationService.runDueOnce()),
        Effect.catchCause((cause) =>
          Effect.logWarning("automation scheduler pass failed", {
            cause: Cause.pretty(cause),
          }),
        ),
      );

      const nextDelayMs = () =>
        automationRepository.getEarliestNextRunAt({ now: new Date().toISOString() }).pipe(
          Effect.map((nextRunAt) => {
            if (!nextRunAt) {
              return intervalMs;
            }
            const dueInMs = Date.parse(nextRunAt) - Date.now();
            return Math.min(
              intervalMs,
              Math.max(1_000, Number.isFinite(dueInMs) ? dueInMs : intervalMs),
            );
          }),
          Effect.catch(() => Effect.succeed(intervalMs)),
        );

      const start: AutomationSchedulerShape["start"] = () =>
        Effect.forkScoped(
          Effect.gen(function* () {
            const wakeups = yield* Queue.sliding<void>(1);
            yield* automationService.streamEvents.pipe(
              Stream.filter(shouldWakeScheduler),
              Stream.runForEach(() => Queue.offer(wakeups, undefined).pipe(Effect.asVoid)),
              Effect.forkScoped,
            );

            while (true) {
              yield* runPassSafely;
              const delayMs = yield* nextDelayMs();
              // Definition changes can create a nearer one-shot run while we are sleeping.
              yield* Effect.sleep(Duration.millis(delayMs)).pipe(
                Effect.raceFirst(Queue.take(wakeups)),
                Effect.asVoid,
              );
            }
          }),
        ).pipe(Effect.asVoid);

      return { start } satisfies AutomationSchedulerShape;
    }),
  );

export const AutomationSchedulerLive = makeAutomationSchedulerLive();
