import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer } from "effect";
import { expect } from "vitest";

import { ServerConfig } from "../../config";
import { GitCommandError } from "../Errors";
import type { ExecuteGitInput, GitCoreShape } from "../Services/GitCore";
import { makeGitCore } from "./GitCore";

const TestLayer = Layer.provideMerge(
  ServerConfig.layerTest(process.cwd(), { prefix: "synara-git-concurrency-test-" }),
  NodeServices.layer,
);
const success = { code: 0, stdout: "", stderr: "" };
const command = (operation: string, timeoutMs?: number | null): ExecuteGitInput => ({
  operation,
  cwd: "/unused",
  args: ["status"],
  ...(timeoutMs !== undefined ? { timeoutMs } : {}),
});

it.layer(TestLayer)("GitCore command admission", (it) => {
  it.effect(
    "bounds short executions across instances and drains waiting commands after completion",
    () =>
      Effect.gen(function* () {
        const occupied = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let running = 0;
        let peak = 0;
        let started = 0;
        const executeOverride: GitCoreShape["execute"] = () =>
          Effect.gen(function* () {
            started += 1;
            running += 1;
            peak = Math.max(peak, running);
            if (started === 8) yield* Deferred.succeed(occupied, undefined);
            yield* Deferred.await(release);
            running -= 1;
            return success;
          });
        const firstCore = yield* makeGitCore({ executeOverride });
        const secondCore = yield* makeGitCore({ executeOverride });
        const fibers = yield* Effect.forEach(Array.from({ length: 12 }), (_, index) =>
          (index % 2 === 0 ? firstCore : secondCore)
            .execute(command(`short-${index}`, index % 2 === 0 ? undefined : 30_000))
            .pipe(Effect.forkChild),
        );
        yield* Deferred.await(occupied);
        yield* Effect.yieldNow;
        expect(started).toBe(8);
        expect(peak).toBe(8);
        yield* Deferred.succeed(release, undefined);
        yield* Effect.forEach(fibers, Fiber.join);
        expect(started).toBe(12);
        expect(running).toBe(0);
        expect(peak).toBe(8);
      }),
  );

  it.effect("removes a cancelled waiter without executing it or losing a slot", () =>
    Effect.gen(function* () {
      const occupied = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const started: string[] = [];
      const core = yield* makeGitCore({
        executeOverride: (input) =>
          Effect.gen(function* () {
            started.push(input.operation);
            if (started.length === 8) yield* Deferred.succeed(occupied, undefined);
            if (input.operation.startsWith("holder")) yield* Deferred.await(release);
            return success;
          }),
      });
      const holders = yield* Effect.forEach(Array.from({ length: 8 }), (_, index) =>
        core.execute(command(`holder-${index}`)).pipe(Effect.forkChild),
      );
      yield* Deferred.await(occupied);
      const cancelled = yield* core.execute(command("cancelled")).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(cancelled);
      yield* Deferred.succeed(release, undefined);
      yield* Effect.forEach(holders, Fiber.join);
      yield* core.execute(command("replacement"));
      expect(started).not.toContain("cancelled");
      expect(started).toHaveLength(9);
      expect(started.at(-1)).toBe("replacement");
    }),
  );

  it.effect("keeps a cancelled execution's slot until its owned cleanup finishes", () =>
    Effect.gen(function* () {
      const occupied = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const cleanupStarted = yield* Deferred.make<void>();
      const finishCleanup = yield* Deferred.make<void>();
      const replacementStarted = yield* Deferred.make<void>();
      let started = 0;
      const core = yield* makeGitCore({
        executeOverride: (input) =>
          Effect.scoped(
            Effect.gen(function* () {
              started += 1;
              if (started === 8) yield* Deferred.succeed(occupied, undefined);
              if (input.operation === "cancelled") {
                yield* Effect.addFinalizer(() =>
                  Deferred.succeed(cleanupStarted, undefined).pipe(
                    Effect.andThen(Deferred.await(finishCleanup)),
                  ),
                );
              }
              if (input.operation === "replacement") {
                yield* Deferred.succeed(replacementStarted, undefined);
              } else {
                yield* Deferred.await(release);
              }
              return success;
            }),
          ),
      });
      const cancelled = yield* core.execute(command("cancelled")).pipe(Effect.forkChild);
      const holders = yield* Effect.forEach(Array.from({ length: 7 }), (_, index) =>
        core.execute(command(`holder-${index}`)).pipe(Effect.forkChild),
      );
      yield* Deferred.await(occupied);
      const interrupt = yield* Fiber.interrupt(cancelled).pipe(Effect.forkChild);
      yield* Deferred.await(cleanupStarted);
      const replacement = yield* core.execute(command("replacement")).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      const startedBeforeCleanup = started;
      yield* Deferred.succeed(finishCleanup, undefined);
      yield* Fiber.join(interrupt);
      yield* Deferred.await(replacementStarted);
      yield* Fiber.join(replacement);
      yield* Deferred.succeed(release, undefined);
      yield* Effect.forEach(holders, Fiber.join);
      expect(startedBeforeCleanup).toBe(8);
      expect(started).toBe(9);
    }),
  );

  it.effect("releases admission after command failure", () =>
    Effect.gen(function* () {
      const occupied = yield* Deferred.make<void>();
      const fail = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let started = 0;
      const core = yield* makeGitCore({
        executeOverride: (input) =>
          Effect.gen(function* () {
            started += 1;
            if (started === 8) yield* Deferred.succeed(occupied, undefined);
            if (input.operation === "failure") {
              yield* Deferred.await(fail);
              return yield* new GitCommandError({
                operation: input.operation,
                command: "git status",
                cwd: input.cwd,
                detail: "Failed command",
              });
            }
            if (input.operation.startsWith("holder")) yield* Deferred.await(release);
            return success;
          }),
      });
      const failed = yield* core.execute(command("failure")).pipe(Effect.result, Effect.forkChild);
      const holders = yield* Effect.forEach(Array.from({ length: 7 }), (_, index) =>
        core.execute(command(`holder-${index}`)).pipe(Effect.forkChild),
      );
      yield* Deferred.await(occupied);
      const replacement = yield* core.execute(command("replacement")).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      const startedBeforeFailure = started;
      yield* Deferred.succeed(fail, undefined);
      expect((yield* Fiber.join(failed))._tag).toBe("Failure");
      yield* Fiber.join(replacement);
      yield* Deferred.succeed(release, undefined);
      yield* Effect.forEach(holders, Fiber.join);
      expect(startedBeforeFailure).toBe(8);
      expect(started).toBe(9);
    }),
  );

  it.effect(
    "shares eight slots across checkpoint writes, unlimited mutations and queued short commands without changing deadlines",
    () =>
      Effect.gen(function* () {
        const occupied = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const inputs: ExecuteGitInput[] = [];
        let running = 0;
        let peak = 0;
        const executeOverride: GitCoreShape["execute"] = (input) =>
          Effect.gen(function* () {
            inputs.push(input);
            running += 1;
            peak = Math.max(peak, running);
            if (inputs.length === 8) yield* Deferred.succeed(occupied, undefined);
            yield* Deferred.await(release);
            running -= 1;
            return success;
          });
        const core = yield* makeGitCore({ executeOverride });
        const holders = yield* Effect.forEach(Array.from({ length: 12 }), (_, index) =>
          core
            .execute(
              index % 2 === 0
                ? { ...command(`checkpoint-${index}`, 180_000), args: ["add", "-A"] }
                : { ...command(`mutation-${index}`, null), args: ["commit", "-m", "test"] },
            )
            .pipe(Effect.forkChild),
        );
        yield* Deferred.await(occupied);
        const queuedShort = yield* core.execute(command("queued-short")).pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        const startedBeforeRelease = inputs.length;
        yield* Deferred.succeed(release, undefined);
        yield* Effect.forEach(holders, Fiber.join);
        yield* Fiber.join(queuedShort);
        expect(startedBeforeRelease).toBe(8);
        expect(peak).toBe(8);
        expect(
          inputs.filter(
            (input) => input.timeoutMs === 180_000 && input.args.join(" ") === "add -A",
          ),
        ).toHaveLength(6);
        expect(inputs.filter((input) => input.timeoutMs === null)).toHaveLength(6);
        expect(
          inputs.find((input) => input.operation === "queued-short")?.timeoutMs,
        ).toBeUndefined();
      }),
  );
});
