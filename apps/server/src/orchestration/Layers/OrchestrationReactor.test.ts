import { it as effectIt } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber, Layer, Logger, ManagedRuntime, Scope } from "effect";
import { TestClock } from "effect/testing";
import { afterEach, describe, expect, it } from "vitest";

import { CheckpointReactor } from "../Services/CheckpointReactor.ts";
import { ProviderCommandReactor } from "../Services/ProviderCommandReactor.ts";
import { ProviderRuntimeIngestionService } from "../Services/ProviderRuntimeIngestion.ts";
import { SidechatExpiryReactor } from "../Services/SidechatExpiryReactor.ts";
import { HubOutputReactor } from "../Services/HubOutputReactor.ts";
import { ThreadGitMetadataReactor } from "../Services/ThreadGitMetadataReactor.ts";
import { OrchestrationReactor } from "../Services/OrchestrationReactor.ts";
import { makeOrchestrationReactor } from "./OrchestrationReactor.ts";

describe("OrchestrationReactor", () => {
  let runtime: ManagedRuntime.ManagedRuntime<OrchestrationReactor, never> | null = null;

  afterEach(async () => {
    if (runtime) {
      await runtime.dispose();
    }
    runtime = null;
  });

  for (const stalledPhase of ["runtime", "commands"] as const) {
    effectIt.effect(
      `bounds a stalled ${stalledPhase} shutdown drain and reports retained recovery`,
      () =>
        Effect.gen(function* () {
          const entered = Deferred.makeUnsafe<void>();
          const cancelled = Deferred.makeUnsafe<void>();
          const finished = Deferred.makeUnsafe<void>();
          const drained: string[] = [];
          const warnings: string[] = [];
          const drain = (phase: "runtime" | "commands") =>
            Effect.sync(() => drained.push(phase)).pipe(
              Effect.andThen(
                phase === stalledPhase
                  ? Deferred.succeed(entered, undefined).pipe(
                      Effect.andThen(Effect.never),
                      Effect.onInterrupt(() => Deferred.succeed(cancelled, undefined)),
                    )
                  : Effect.void,
              ),
            );
          const reactor = yield* makeOrchestrationReactor.pipe(
            Effect.provideService(ProviderRuntimeIngestionService, {
              start: Effect.void,
              drain: drain("runtime"),
              reconcileSettledOpenTurns: Effect.void,
            }),
            Effect.provideService(ProviderCommandReactor, {
              start: Effect.void,
              drain: drain("commands"),
              listBlockingDeliveries: () => Effect.succeed([]),
              reconcileDelivery: () => Effect.succeed(null),
              regenerateThreadTitle: () => Effect.succeed({ status: "no-context", title: null }),
            }),
            Effect.provideService(CheckpointReactor, { start: Effect.void, drain: Effect.void }),
            Effect.provideService(ThreadGitMetadataReactor, {
              start: Effect.void,
              drain: Effect.void,
            }),
            Effect.provideService(HubOutputReactor, {
              start: Effect.void,
              drain: Effect.void,
              captureBaselineBeforeTurn: () =>
                Effect.succeed({ status: "not-applicable" as const }),
              cancelPendingTurnBaseline: () => Effect.void,
            }),
            Effect.provideService(SidechatExpiryReactor, {
              start: Effect.void,
              viewStarted: () => Effect.void,
              viewEnded: () => Effect.void,
            }),
          );
          const fiber = yield* reactor.drainProviderCommands.pipe(
            Effect.andThen(Deferred.succeed(finished, undefined)),
            Effect.provide(
              Logger.layer([Logger.make(({ message }) => warnings.push(String(message)))], {
                mergeWithExisting: false,
              }),
            ),
            Effect.forkChild,
          );
          yield* Deferred.await(entered);
          yield* TestClock.adjust("4 seconds");
          expect(yield* Deferred.isDone(finished)).toBe(false);
          yield* TestClock.adjust("1 second");
          yield* Fiber.join(fiber);
          expect(yield* Deferred.isDone(cancelled)).toBe(true);
          expect(drained).toEqual(
            stalledPhase === "runtime" ? ["runtime"] : ["runtime", "commands"],
          );
          expect(warnings).toEqual([
            "provider shutdown drain reached its deadline; durable recovery evidence retained",
          ]);
        }).pipe(Effect.scoped),
    );
  }

  it("starts runtime observers before provider command dispatch can begin", async () => {
    const started: string[] = [];
    const stopped: string[] = [];
    const drained: string[] = [];
    let reconciledOpenTurns = 0;

    runtime = ManagedRuntime.make(
      Layer.effect(OrchestrationReactor, makeOrchestrationReactor).pipe(
        Layer.provideMerge(
          Layer.succeed(SidechatExpiryReactor, {
            start: Effect.acquireRelease(
              Effect.sync(() => {
                started.push("sidechat-expiry-reactor");
              }),
              () => Effect.sync(() => stopped.push("sidechat-expiry-reactor")),
            ),
            viewStarted: () => Effect.void,
            viewEnded: () => Effect.void,
          }),
        ),
        Layer.provideMerge(
          Layer.succeed(ProviderRuntimeIngestionService, {
            start: Effect.acquireRelease(
              Effect.sync(() => {
                started.push("provider-runtime-ingestion");
              }),
              () => Effect.sync(() => stopped.push("provider-runtime-ingestion")),
            ),
            drain: Effect.sync(() => drained.push("runtime")),
            reconcileSettledOpenTurns: Effect.sync(() => {
              reconciledOpenTurns += 1;
            }),
          }),
        ),
        Layer.provideMerge(
          Layer.succeed(ProviderCommandReactor, {
            start: Effect.acquireRelease(
              Effect.sync(() => {
                started.push("provider-command-reactor");
              }),
              () => Effect.sync(() => stopped.push("provider-command-reactor")),
            ),
            drain: Effect.sync(() => drained.push("commands")),
            listBlockingDeliveries: () => Effect.succeed([]),
            reconcileDelivery: () => Effect.succeed(null),
            regenerateThreadTitle: () => Effect.succeed({ status: "no-context", title: null }),
          }),
        ),
        Layer.provideMerge(
          Layer.succeed(CheckpointReactor, {
            start: Effect.acquireRelease(
              Effect.sync(() => {
                started.push("checkpoint-reactor");
              }),
              () => Effect.sync(() => stopped.push("checkpoint-reactor")),
            ),
            drain: Effect.void,
          }),
        ),
        Layer.provideMerge(
          Layer.succeed(HubOutputReactor, {
            captureBaselineBeforeTurn: () => Effect.succeed({ status: "not-applicable" as const }),
            cancelPendingTurnBaseline: () => Effect.void,
            start: Effect.acquireRelease(
              Effect.sync(() => {
                started.push("studio-output-reactor");
              }),
              () => Effect.sync(() => stopped.push("studio-output-reactor")),
            ),
            drain: Effect.void,
          }),
        ),
        Layer.provideMerge(
          Layer.succeed(ThreadGitMetadataReactor, {
            start: Effect.acquireRelease(
              Effect.sync(() => {
                started.push("thread-git-metadata-reactor");
              }),
              () => Effect.sync(() => stopped.push("thread-git-metadata-reactor")),
            ),
            drain: Effect.void,
          }),
        ),
      ),
    );

    const reactor = await runtime.runPromise(Effect.service(OrchestrationReactor));
    const scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(reactor.start.pipe(Scope.provide(scope)));
    await Effect.runPromise(reactor.reconcileSettledOpenTurns);

    expect(started).toEqual([
      "studio-output-reactor",
      "checkpoint-reactor",
      "thread-git-metadata-reactor",
      "provider-runtime-ingestion",
      "sidechat-expiry-reactor",
      "provider-command-reactor",
    ]);
    expect(reconciledOpenTurns).toBe(1);
    await runtime.runPromise(reactor.drainProviderCommands);
    expect(drained).toEqual(["runtime", "commands"]);

    await Effect.runPromise(Scope.close(scope, Exit.void));
    expect(stopped).toEqual([
      "provider-command-reactor",
      "sidechat-expiry-reactor",
      "provider-runtime-ingestion",
      "thread-git-metadata-reactor",
      "checkpoint-reactor",
      "studio-output-reactor",
    ]);
  });
});
