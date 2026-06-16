import { Cause, Duration, Effect, Layer, Schedule } from "effect";

import { AutomationService } from "../Services/AutomationService.ts";
import {
  AutomationScheduler,
  type AutomationSchedulerShape,
} from "../Services/AutomationScheduler.ts";

const DEFAULT_AUTOMATION_SCHEDULER_INTERVAL_MS = 60_000;

export interface AutomationSchedulerLiveOptions {
  readonly intervalMs?: number;
}

export const makeAutomationSchedulerLive = (options?: AutomationSchedulerLiveOptions) =>
  Layer.effect(
    AutomationScheduler,
    Effect.gen(function* () {
      const automationService = yield* AutomationService;
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

      const start: AutomationSchedulerShape["start"] = () =>
        Effect.forkScoped(
          runPassSafely.pipe(Effect.repeat(Schedule.spaced(Duration.millis(intervalMs)))),
        ).pipe(Effect.asVoid);

      return { start } satisfies AutomationSchedulerShape;
    }),
  );

export const AutomationSchedulerLive = makeAutomationSchedulerLive();
