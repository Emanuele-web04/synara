// FILE: AutomationScheduler.test.ts
// Purpose: Verifies scheduler loop timing behavior around automation definition changes.
// Layer: Automation service test
// Depends on: AutomationSchedulerLive with fake AutomationService and AutomationRepository layers.

import { assert, it } from "@effect/vitest";
import {
  AutomationId,
  type AutomationDefinition,
  type AutomationStreamEvent,
} from "@t3tools/contracts";
import { Effect, Layer, PubSub, Stream } from "effect";

import { AutomationRepository } from "../../persistence/Services/AutomationRepository.ts";
import type { AutomationRepositoryShape } from "../../persistence/Services/AutomationRepository.ts";
import { AutomationScheduler } from "../Services/AutomationScheduler.ts";
import { AutomationService } from "../Services/AutomationService.ts";
import type { AutomationServiceShape } from "../Services/AutomationService.ts";
import { makeAutomationSchedulerLive } from "./AutomationScheduler.ts";

function unusedEffect(): Effect.Effect<never> {
  return Effect.die("unused scheduler test method");
}

it.effect("wakes a long sleep when an automation definition changes", () =>
  Effect.gen(function* () {
    let runDuePasses = 0;
    const events = yield* PubSub.unbounded<AutomationStreamEvent>();
    const automationService = {
      list: unusedEffect,
      create: unusedEffect,
      update: unusedEffect,
      delete: unusedEffect,
      runNow: unusedEffect,
      cancelRun: unusedEffect,
      markRunRead: unusedEffect,
      archiveRun: unusedEffect,
      runDueOnce: () =>
        Effect.sync(() => {
          runDuePasses += 1;
          return [];
        }),
      reconcileThread: unusedEffect,
      reconcileActiveRuns: () => Effect.void,
      recoverPendingRuns: unusedEffect,
      streamEvents: Stream.fromPubSub(events),
    } satisfies AutomationServiceShape;
    const automationRepository = {
      getEarliestNextRunAt: () => Effect.succeed(null),
    } as unknown as AutomationRepositoryShape;
    const layer = makeAutomationSchedulerLive({ intervalMs: 60_000 }).pipe(
      Layer.provide(Layer.succeed(AutomationService, automationService)),
      Layer.provide(Layer.succeed(AutomationRepository, automationRepository)),
    );

    yield* Effect.gen(function* () {
      const scheduler = yield* AutomationScheduler;
      yield* scheduler.start();
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      assert.strictEqual(runDuePasses, 1);

      yield* PubSub.publish(events, {
        type: "definition-upserted",
        definition: {
          id: AutomationId.makeUnsafe("automation-short-timer"),
        } as AutomationDefinition,
      });
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;

      assert.strictEqual(runDuePasses, 2);
    }).pipe(Effect.provide(layer), Effect.scoped);
  }),
);

it.effect("wakes a pending heartbeat sleep when a stop evaluation is recorded", () =>
  Effect.gen(function* () {
    let runDuePasses = 0;
    const events = yield* PubSub.unbounded<AutomationStreamEvent>();
    const automationService = {
      list: unusedEffect,
      create: unusedEffect,
      update: unusedEffect,
      delete: unusedEffect,
      runNow: unusedEffect,
      cancelRun: unusedEffect,
      markRunRead: unusedEffect,
      archiveRun: unusedEffect,
      runDueOnce: () =>
        Effect.sync(() => {
          runDuePasses += 1;
          return [];
        }),
      reconcileThread: unusedEffect,
      reconcileActiveRuns: () => Effect.void,
      recoverPendingRuns: unusedEffect,
      streamEvents: Stream.fromPubSub(events),
    } satisfies AutomationServiceShape;
    const automationRepository = {
      getEarliestNextRunAt: () => Effect.succeed(null),
    } as unknown as AutomationRepositoryShape;
    const layer = makeAutomationSchedulerLive({ intervalMs: 60_000 }).pipe(
      Layer.provide(Layer.succeed(AutomationService, automationService)),
      Layer.provide(Layer.succeed(AutomationRepository, automationRepository)),
    );

    yield* Effect.gen(function* () {
      const scheduler = yield* AutomationScheduler;
      yield* scheduler.start();
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      assert.strictEqual(runDuePasses, 1);

      yield* PubSub.publish(events, {
        type: "run-upserted",
        run: {
          result: {
            completionEvaluation: {
              stopMatched: false,
              confidence: 0.4,
              reason: "Still waiting.",
            },
          },
        },
      } as AutomationStreamEvent);
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;

      assert.strictEqual(runDuePasses, 2);
    }).pipe(Effect.provide(layer), Effect.scoped);
  }),
);
