import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Logger, Sink, Stream } from "effect";
import { TestClock } from "effect/testing";
import { ChildProcessSpawner } from "effect/unstable/process";
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
const withRelease = <A, E, R>(run: (release: Deferred.Deferred<void>) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const release = yield* Deferred.make<void>();
    return yield* run(release).pipe(Effect.ensuring(Deferred.succeed(release, undefined)));
  });
const forkAndYield = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.forkChild,
    Effect.tap(() => Effect.yieldNow),
  );

const localStatus = "# branch.head main\0# branch.upstream origin/main\0# branch.ab +0 -0\0";
const statusResult = (input: ExecuteGitInput) => {
  if (input.operation === "GitCore.resolveCurrentUpstream")
    return Effect.succeed({ ...success, stdout: "origin/main\n" });
  if (input.operation === "GitCore.statusDetails.isInsideWorkTree")
    return Effect.succeed({ ...success, stdout: "true\n" });
  if (input.args[0] === "status") {
    return Effect.gen(function* () {
      for (const record of localStatus.split("\0").filter(Boolean))
        if (input.progress?.onStdoutLine) yield* input.progress.onStdoutLine(record);
      return { ...success, stdout: localStatus };
    });
  }
  return Effect.succeed(success);
};

it.layer(TestLayer)("GitCore command admission", (it) => {
  for (const method of ["statusDetails", "readActionStatus"] as const) {
    it.effect(`returns local ${method} while both long slots are occupied`, () =>
      withRelease((release) =>
        Effect.gen(function* () {
          const started: string[] = [];
          const core = yield* makeGitCore({
            executeOverride: (input) => {
              started.push(input.operation);
              return input.operation.startsWith("user-long")
                ? Deferred.await(release).pipe(Effect.as(success))
                : statusResult(input);
            },
          });
          const holders = yield* Effect.forEach([0, 1], (index) =>
            forkAndYield(core.execute(command(`user-long-${index}`, null))),
          );
          const query = yield* forkAndYield(
            core[method]("/unused").pipe(Effect.timeoutOption("100 millis")),
          );
          yield* TestClock.adjust("100 millis");
          const result = yield* Fiber.join(query);
          expect(result._tag).toBe("Some");
          if (result._tag === "Some") expect(result.value.branch).toBe("main");
          expect(started).not.toContain("GitCore.fetchUpstreamRefForStatus");
          yield* Deferred.succeed(release, undefined);
          yield* Effect.forEach(holders, Fiber.join);
        }),
      ),
    );
  }

  it.effect("skips busy background fetches without occupying the user long FIFO", () =>
    withRelease((release) =>
      Effect.gen(function* () {
        const started: string[] = [];
        const attempted = yield* Deferred.make<void>();
        let resolutions = 0;
        const core = yield* makeGitCore({
          executeOverride: (input) => {
            started.push(input.operation);
            if (input.operation === "GitCore.resolveCurrentUpstream") {
              resolutions++;
              if (resolutions === 12) Deferred.doneUnsafe(attempted, Effect.void);
            }
            return input.operation.startsWith("user-long")
              ? Deferred.await(release).pipe(Effect.as(success))
              : statusResult(input);
          },
        });
        const holders = yield* Effect.forEach([0, 1], (index) =>
          forkAndYield(core.execute(command(`user-long-${index}`, null))),
        );
        for (let index = 0; index < 12; index++) yield* core.status({ cwd: `/unused-${index}` });
        const resolved = yield* forkAndYield(
          Deferred.await(attempted).pipe(Effect.timeoutOption("100 millis")),
        );
        yield* TestClock.adjust("100 millis");
        expect((yield* Fiber.join(resolved))._tag).toBe("Some");
        const foreground = yield* forkAndYield(core.execute(command("user-long-next", null)));
        yield* Deferred.succeed(release, undefined);
        yield* Effect.forEach([...holders, foreground], Fiber.join);
        yield* Effect.yieldNow;
        expect(
          started.filter((operation) => operation === "GitCore.fetchUpstreamRefForStatus"),
        ).toHaveLength(0);
        expect(started).toContain("user-long-next");
      }),
    ),
  );

  it.effect("skips the background upstream probe when the read FIFO is busy", () =>
    withRelease((release) =>
      Effect.gen(function* () {
        const started: string[] = [];
        const core = yield* makeGitCore({
          executeOverride: (input) => {
            started.push(input.operation);
            return input.operation.startsWith("holder")
              ? Deferred.await(release).pipe(Effect.as(success))
              : statusResult(input);
          },
        });
        const holders = yield* Effect.forEach([0, 1, 2, 3], (index) =>
          forkAndYield(core.execute(command(`holder-${index}`))),
        );
        // readActionStatus schedules its optional refresh before submitting its
        // own local read. Only that foreground read may join the busy FIFO.
        const query = yield* forkAndYield(core.readActionStatus("/unused"));
        yield* TestClock.adjust("100 millis");
        yield* Deferred.succeed(release, undefined);
        const result = yield* Fiber.join(query);
        yield* Effect.forEach(holders, Fiber.join);
        yield* Effect.yieldNow;
        expect(result.branch).toBe("main");
        expect(started).toContain("GitCore.readActionStatus");
        expect(started).not.toContain("GitCore.resolveCurrentUpstream");
        expect(started).not.toContain("GitCore.fetchUpstreamRefForStatus");
      }),
    ),
  );

  it.effect("admits two checkpoint commands independently of saturated read and long slots", () =>
    withRelease((release) =>
      Effect.gen(function* () {
        const started: ExecuteGitInput[] = [];
        const core = yield* makeGitCore({
          executeOverride: (input) =>
            Effect.gen(function* () {
              started.push(input);
              yield* Deferred.await(release);
              return success;
            }),
        });
        const reads = yield* Effect.forEach(Array.from({ length: 6 }), (_, index) =>
          forkAndYield(core.execute(command(`read-${index}`))),
        );
        const longs = yield* Effect.forEach([0, 1], (index) =>
          forkAndYield(core.execute({ ...command(`long-${index}`, null), args: ["reset"] })),
        );
        const checkpoints = yield* Effect.forEach(
          [
            { ...command("CheckpointStore.captureCheckpoint"), args: ["add", "-A", "--", "."] },
            {
              ...command("CheckpointStore.resolveWorkingIndex"),
              args: ["rev-parse", "--git-path", "index"],
            },
            { ...command("CheckpointStore.reverseCheckpointDiff"), args: ["apply", "--reverse"] },
          ],
          (input) => forkAndYield(core.execute(input)),
        );
        expect(started.map((input) => input.operation)).toEqual([
          "read-0",
          "read-1",
          "read-2",
          "read-3",
          "long-0",
          "long-1",
          "CheckpointStore.captureCheckpoint",
          "CheckpointStore.resolveWorkingIndex",
        ]);
        expect(
          started.filter((input) => input.operation.startsWith("CheckpointStore.")),
        ).toHaveLength(2);
        yield* Deferred.succeed(release, undefined);
        yield* Effect.forEach([...reads, ...longs, ...checkpoints], Fiber.join);
      }),
    ),
  );

  it.effect("bounds checkpoint overload separately from general reads", () =>
    withRelease((release) =>
      Effect.gen(function* () {
        let checkpointStarts = 0;
        const core = yield* makeGitCore({
          executeOverride: (input) =>
            input.operation.startsWith("CheckpointStore.")
              ? Effect.sync(() => {
                  checkpointStarts++;
                }).pipe(Effect.andThen(Deferred.await(release)), Effect.as(success))
              : Effect.succeed(success),
        });
        const checkpoints = yield* Effect.forEach(Array.from({ length: 130 }), () =>
          forkAndYield(
            core.execute({ ...command("CheckpointStore.captureCheckpoint"), args: ["add", "-A"] }),
          ),
        );
        const excess = yield* forkAndYield(
          core
            .execute({
              ...command("CheckpointStore.resolveHeadCommit"),
              args: ["rev-parse", "HEAD"],
            })
            .pipe(Effect.result, Effect.timeoutOption("100 millis")),
        );
        yield* TestClock.adjust("100 millis");
        const result = yield* Fiber.join(excess);
        expect(result._tag).toBe("Some");
        if (result._tag === "Some") {
          expect(result.value._tag).toBe("Failure");
          if (result.value._tag === "Failure")
            expect(result.value.failure.detail).toContain("queue is full");
        }
        expect(checkpointStarts).toBe(2);
        yield* core.execute(command("read-during-checkpoint-overload"));
        yield* Deferred.succeed(release, undefined);
        yield* Effect.forEach(checkpoints, Fiber.join);
        expect(checkpointStarts).toBe(130);
      }),
    ),
  );

  it.effect("releases a granted FIFO permit when caller interruption wins before spawning", () => {
    const queuedObserved = Deferred.makeUnsafe<void>();
    const firstRelease = Deferred.makeUnsafe<void>();
    const logger = Logger.make(({ message }) => {
      if (
        Array.isArray(message) &&
        message.some(
          (value: unknown) =>
            typeof value === "object" &&
            value !== null &&
            "operation" in value &&
            value.operation === "grant-cancelled",
        )
      )
        Deferred.doneUnsafe(queuedObserved, Effect.void);
    });
    return withRelease((release) =>
      Effect.gen(function* () {
        const granted = yield* Deferred.make<void>();
        const started: string[] = [];
        const core = yield* makeGitCore({
          executeOverride: (input) =>
            Effect.gen(function* () {
              if (input.operation === "grant-cancelled") {
                // This handler is reached only after real FIFO admission. Keep its
                // external side effect behind a cancellable gate, like process startup.
                yield* Deferred.succeed(granted, undefined);
                yield* Deferred.await(release);
              }
              started.push(input.operation);
              if (input.operation === "holder-0") yield* Deferred.await(firstRelease);
              if (input.operation === "holder-1") yield* Deferred.await(release);
              return success;
            }),
        });
        const first = yield* forkAndYield(core.execute(command("holder-0", null)));
        const second = yield* forkAndYield(core.execute(command("holder-1", null)));
        const cancelled = yield* forkAndYield(core.execute(command("grant-cancelled", null)));
        yield* TestClock.adjust("2001 millis");
        expect(yield* Deferred.isDone(queuedObserved)).toBe(true);
        const replacement = yield* forkAndYield(core.execute(command("grant-replacement", null)));
        yield* Deferred.succeed(firstRelease, undefined);
        yield* Fiber.join(first);
        expect(yield* Deferred.isDone(granted)).toBe(true);
        yield* Deferred.await(granted);
        yield* Fiber.interrupt(cancelled);
        const completed = yield* forkAndYield(
          Fiber.join(replacement).pipe(Effect.timeoutOption("100 millis")),
        );
        yield* TestClock.adjust("100 millis");
        expect((yield* Fiber.join(completed))._tag).toBe("Some");
        expect(started).toEqual(["holder-0", "holder-1", "grant-replacement"]);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(second);
      }).pipe(Effect.ensuring(Deferred.succeed(firstRelease, undefined))),
    ).pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));
  });

  it.effect("shares four read slots across instances and drains the FIFO queue", () =>
    withRelease((release) =>
      Effect.gen(function* () {
        const started: string[] = [];
        let running = 0;
        let peak = 0;
        const executeOverride: GitCoreShape["execute"] = (input) =>
          Effect.gen(function* () {
            started.push(input.operation);
            running += 1;
            peak = Math.max(peak, running);
            yield* Deferred.await(release);
            running -= 1;
            return success;
          });
        const first = yield* makeGitCore({ executeOverride });
        const second = yield* makeGitCore({ executeOverride });
        const fibers = yield* Effect.forEach(Array.from({ length: 10 }), (_, i) =>
          forkAndYield((i % 2 === 0 ? first : second).execute(command(`short-${i}`))),
        );
        expect(started).toHaveLength(4);
        yield* Deferred.succeed(release, undefined);
        yield* Effect.forEach(fibers, Fiber.join);
        expect(started).toEqual(Array.from({ length: 10 }, (_, i) => `short-${i}`));
        expect(peak).toBe(4);
        expect(running).toBe(0);
      }),
    ),
  );

  it.effect("reserves read and checkpoint capacity while unlimited and network work waits", () =>
    withRelease((release) =>
      Effect.gen(function* () {
        const inputs: ExecuteGitInput[] = [];
        let running = 0;
        let peak = 0;
        const core = yield* makeGitCore({
          executeOverride: (input) =>
            Effect.gen(function* () {
              inputs.push(input);
              running += 1;
              peak = Math.max(peak, running);
              yield* Deferred.await(release);
              running -= 1;
              return success;
            }),
        });
        const longInputs: ExecuteGitInput[] = [
          { ...command("unlimited-local", null), args: ["add", "-A"] },
          { ...command("hooked-commit", 50), args: ["commit", "-m", "test"] },
          { ...command("fetch"), args: ["fetch", "origin"] },
          { ...command("clone"), args: ["clone", "remote", "target"] },
          { ...command("push", null), args: ["push", "origin"] },
          { ...command("configured-fetch"), args: ["-c", "credential.helper=", "fetch"] },
        ];
        const longs = yield* Effect.forEach(longInputs, (input) =>
          forkAndYield(core.execute(input)),
        );
        const reads = yield* Effect.forEach(Array.from({ length: 4 }), (_, i) =>
          forkAndYield(core.execute(command(`read-${i}`))),
        );
        const checkpoints = yield* Effect.forEach(
          ["CheckpointStore.captureCheckpoint", "CheckpointStore.resolveWorkingIndex"],
          (operation) =>
            forkAndYield(core.execute({ ...command(operation), args: ["add", "-A", "--", "."] })),
        );
        expect(inputs.map((input) => input.operation)).toEqual([
          "unlimited-local",
          "hooked-commit",
          ...Array.from({ length: 4 }, (_, i) => `read-${i}`),
          "CheckpointStore.captureCheckpoint",
          "CheckpointStore.resolveWorkingIndex",
        ]);
        expect(inputs.find((input) => input.operation === "hooked-commit")?.timeoutMs).toBe(50);
        expect(
          inputs.find((input) => input.operation === "CheckpointStore.captureCheckpoint")
            ?.timeoutMs,
        ).toBeUndefined();
        yield* Deferred.succeed(release, undefined);
        yield* Effect.forEach([...longs, ...reads, ...checkpoints], Fiber.join);
        expect(peak).toBe(8);
        expect(
          inputs
            .filter((input) => longInputs.some((long) => long.operation === input.operation))
            .map((input) => input.operation),
        ).toEqual(longInputs.map((input) => input.operation));
      }),
    ),
  );

  it.effect(
    "finite pull, fetch, clone, commit and push preserve read and checkpoint reservations",
    () =>
      Effect.gen(function* () {
        for (const subcommand of ["pull", "fetch", "clone", "commit", "push"]) {
          yield* withRelease((release) =>
            Effect.gen(function* () {
              const started: ExecuteGitInput[] = [];
              const core = yield* makeGitCore({
                executeOverride: (input) =>
                  Effect.gen(function* () {
                    started.push(input);
                    yield* Deferred.await(release);
                    return success;
                  }),
              });
              const network = yield* Effect.forEach(Array.from({ length: 8 }), (_, index) =>
                forkAndYield(
                  core.execute({
                    ...command(`finite-${subcommand}-${index}`, 30_000),
                    args: [subcommand],
                  }),
                ),
              );
              const reads = yield* Effect.forEach(Array.from({ length: 4 }), (_, index) =>
                forkAndYield(core.execute(command(`read-${index}`))),
              );
              const checkpoints = yield* Effect.forEach(
                ["CheckpointStore.captureCheckpoint", "CheckpointStore.resolveWorkingIndex"],
                (operation) =>
                  forkAndYield(
                    core.execute({ ...command(operation), args: ["add", "-A", "--", "."] }),
                  ),
              );
              expect(
                started.map((input) => input.operation),
                subcommand,
              ).toEqual([
                `finite-${subcommand}-0`,
                `finite-${subcommand}-1`,
                ...Array.from({ length: 4 }, (_, index) => `read-${index}`),
                "CheckpointStore.captureCheckpoint",
                "CheckpointStore.resolveWorkingIndex",
              ]);
              expect(
                started.filter((input) => input.timeoutMs === 30_000),
                subcommand,
              ).toHaveLength(2);
              yield* Deferred.succeed(release, undefined);
              yield* Effect.forEach([...network, ...reads, ...checkpoints], Fiber.join);
            }),
          );
        }
      }),
  );

  it.effect("cancels the FIFO head without spawning it or leaking a replacement slot", () => {
    const queuedObserved = Deferred.makeUnsafe<void>();
    const logger = Logger.make(({ message }) => {
      if (
        Array.isArray(message) &&
        message.some(
          (value: unknown) =>
            typeof value === "object" &&
            value !== null &&
            "operation" in value &&
            value.operation === "cancelled",
        )
      ) {
        Deferred.doneUnsafe(queuedObserved, Effect.void);
      }
    });
    return withRelease((release) =>
      Effect.gen(function* () {
        const started: string[] = [];
        const core = yield* makeGitCore({
          executeOverride: (input) =>
            Effect.gen(function* () {
              started.push(input.operation);
              if (input.operation.startsWith("holder")) yield* Deferred.await(release);
              return success;
            }),
        });
        const holders = yield* Effect.forEach(Array.from({ length: 4 }), (_, i) =>
          forkAndYield(core.execute(command(`holder-${i}`))),
        );
        const cancelled = yield* forkAndYield(core.execute(command("cancelled")));
        yield* TestClock.adjust("2001 millis");
        // Observe real admission evidence before interruption. A missing warning
        // fails promptly, rather than waiting forever on the fixture's gate.
        expect(yield* Deferred.isDone(queuedObserved)).toBe(true);
        yield* Deferred.await(queuedObserved);
        const replacement = yield* forkAndYield(core.execute(command("replacement")));
        yield* Fiber.interrupt(cancelled);
        expect(started).toHaveLength(4);
        yield* Deferred.succeed(release, undefined);
        yield* Effect.forEach([...holders, replacement], Fiber.join);
        expect(started).not.toContain("cancelled");
        expect(started.at(-1)).toBe("replacement");
        expect(started).toHaveLength(5);
      }),
    ).pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));
  });

  it.effect("releases failed executions before admitting replacement work", () =>
    withRelease((release) =>
      Effect.gen(function* () {
        const fail = yield* Deferred.make<void>();
        const started: string[] = [];
        const core = yield* makeGitCore({
          executeOverride: (input) =>
            Effect.gen(function* () {
              started.push(input.operation);
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
        const failed = yield* forkAndYield(core.execute(command("failure")).pipe(Effect.result));
        const holders = yield* Effect.forEach(Array.from({ length: 3 }), (_, i) =>
          forkAndYield(core.execute(command(`holder-${i}`))),
        );
        const replacement = yield* forkAndYield(core.execute(command("replacement")));
        const beforeFailure = started.length;
        yield* Deferred.succeed(fail, undefined);
        expect((yield* Fiber.join(failed))._tag).toBe("Failure");
        yield* Fiber.join(replacement);
        yield* Deferred.succeed(release, undefined);
        yield* Effect.forEach(holders, Fiber.join);
        expect(beforeFailure).toBe(4);
        expect(started.at(-1)).toBe("replacement");
      }),
    ),
  );

  it.effect("rejects excess long waiters without blocking the short class", () =>
    withRelease((release) =>
      Effect.gen(function* () {
        const started: string[] = [];
        const core = yield* makeGitCore({
          executeOverride: (input) =>
            Effect.gen(function* () {
              started.push(input.operation);
              if (input.timeoutMs === null) yield* Deferred.await(release);
              return success;
            }),
        });
        const fibers = yield* Effect.forEach(Array.from({ length: 130 }), (_, i) =>
          forkAndYield(core.execute(command(`long-${i}`, null))),
        );
        const rejected = yield* forkAndYield(
          core
            .execute(command("overloaded", null))
            .pipe(Effect.result, Effect.timeoutOption("1 second")),
        );
        yield* TestClock.adjust("1 second");
        const result = yield* Fiber.join(rejected);
        expect(result._tag).toBe("Some");
        if (result._tag === "Some") {
          expect(result.value._tag).toBe("Failure");
          if (result.value._tag === "Failure")
            expect(result.value.failure.detail).toContain("queue is full");
        }
        yield* core.execute(command("short-during-overload"));
        expect(started).toContain("short-during-overload");
        yield* Deferred.succeed(release, undefined);
        yield* Effect.forEach(fibers, Fiber.join);
        expect(started).not.toContain("overloaded");
      }),
    ),
  );

  it.effect("warns once for a slow waiter using only its operation", () => {
    const messages: unknown[] = [];
    const logger = Logger.make(({ message }) => {
      messages.push(message);
    });
    return withRelease((release) =>
      Effect.gen(function* () {
        const core = yield* makeGitCore({
          executeOverride: () => Deferred.await(release).pipe(Effect.as(success)),
        });
        const holders = yield* Effect.forEach(Array.from({ length: 4 }), (_, i) =>
          forkAndYield(core.execute(command(`holder-${i}`))),
        );
        const waiter = yield* forkAndYield(
          core.execute({
            ...command("GitCore.test.slow"),
            cwd: "/private/repository",
            args: ["status", "private-file"],
          }),
        );
        yield* TestClock.adjust("2001 millis");
        yield* Effect.yieldNow;
        yield* TestClock.adjust("2 seconds");
        expect(messages).toHaveLength(1);
        const text = JSON.stringify(messages);
        expect(text).toContain("GitCore.test.slow");
        expect(text).not.toContain("/private/repository");
        expect(text).not.toContain("private-file");
        yield* Deferred.succeed(release, undefined);
        yield* Effect.forEach([...holders, waiter], Fiber.join);
      }),
    ).pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));
  });

  it.effect(
    "starts a real 50ms process deadline after admission and holds its slot through kill cleanup",
    () =>
      Effect.gen(function* () {
        const cleanupStarted = yield* Deferred.make<void>();
        const finishCleanup = yield* Deferred.make<void>();
        const queuedStarted = yield* Deferred.make<void>();
        const queuedSettled = yield* Deferred.make<void>();
        const exits = new Map<string, Deferred.Deferred<ChildProcessSpawner.ExitCode>>();
        const started: string[] = [];
        let running = 0;
        let peak = 0;
        const spawner = ChildProcessSpawner.make((raw) =>
          Effect.gen(function* () {
            const cmd = raw as unknown as { args: ReadonlyArray<string> };
            const label = cmd.args[1]!;
            const exit = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
            exits.set(label, exit);
            started.push(label);
            running += 1;
            peak = Math.max(peak, running);
            if (label === "queued") yield* Deferred.succeed(queuedStarted, undefined);
            let killed = false;
            return ChildProcessSpawner.makeHandle({
              pid: ChildProcessSpawner.ProcessId(started.length),
              exitCode: Deferred.await(exit),
              isRunning: Effect.sync(() => !killed),
              kill: () =>
                Effect.gen(function* () {
                  if (killed) return;
                  killed = true;
                  if (label === "queued") {
                    yield* Deferred.succeed(cleanupStarted, undefined);
                    yield* Deferred.await(finishCleanup);
                  }
                  running -= 1;
                }),
              stdin: Sink.drain,
              stdout: Stream.empty,
              stderr: Stream.empty,
              all: Stream.empty,
              getInputFd: () => Sink.drain,
              getOutputFd: () => Stream.empty,
            });
          }),
        );
        const core = yield* makeGitCore().pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        );
        return yield* Effect.gen(function* () {
          const holders = yield* Effect.forEach(Array.from({ length: 4 }), (_, i) =>
            forkAndYield(
              core.execute({ ...command(`holder-${i}`), args: ["status", `holder-${i}`] }),
            ),
          );
          const queued = yield* forkAndYield(
            core
              .execute({ ...command("queued", 50), args: ["status", "queued"] })
              .pipe(Effect.result, Effect.ensuring(Deferred.succeed(queuedSettled, undefined))),
          );
          yield* TestClock.adjust("100 millis");
          expect(started).not.toContain("queued");
          yield* Deferred.succeed(exits.get("holder-0")!, ChildProcessSpawner.ExitCode(0));
          yield* Fiber.join(holders[0]!);
          yield* Deferred.await(queuedStarted);
          yield* TestClock.adjust("49 millis");
          expect(yield* Deferred.isDone(queuedSettled)).toBe(false);
          yield* TestClock.adjust("1 millis");
          yield* Deferred.await(cleanupStarted);
          const replacement = yield* forkAndYield(
            core.execute({ ...command("replacement"), args: ["status", "replacement"] }),
          );
          expect(started).not.toContain("replacement");
          yield* Deferred.succeed(finishCleanup, undefined);
          const result = yield* Fiber.join(queued);
          expect(result._tag).toBe("Failure");
          if (result._tag === "Failure") expect(result.failure.detail).toContain("timed out");
          yield* Effect.yieldNow;
          expect(started).toContain("replacement");
          for (const exit of exits.values())
            yield* Deferred.succeed(exit, ChildProcessSpawner.ExitCode(0));
          yield* Effect.forEach([...holders, replacement], Fiber.join);
          expect(peak).toBe(4);
          expect(running).toBe(0);
        }).pipe(
          Effect.ensuring(
            Effect.gen(function* () {
              yield* Deferred.succeed(finishCleanup, undefined);
              for (const exit of exits.values())
                yield* Deferred.succeed(exit, ChildProcessSpawner.ExitCode(0));
            }),
          ),
        );
      }),
  );

  it.effect(
    "suppresses Git terminal prompts for network commands through the existing process environment",
    () =>
      Effect.gen(function* () {
        const inputs: Array<{
          args: ReadonlyArray<string>;
          options?: { env?: NodeJS.ProcessEnv };
        }> = [];
        const spawner = ChildProcessSpawner.make((raw) => {
          inputs.push(raw as unknown as (typeof inputs)[number]);
          return Effect.succeed(
            ChildProcessSpawner.makeHandle({
              pid: ChildProcessSpawner.ProcessId(1),
              exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
              isRunning: Effect.succeed(false),
              kill: () => Effect.void,
              stdin: Sink.drain,
              stdout: Stream.empty,
              stderr: Stream.empty,
              all: Stream.empty,
              getInputFd: () => Sink.drain,
              getOutputFd: () => Stream.empty,
            }),
          );
        });
        const core = yield* makeGitCore().pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        );
        yield* core.execute({
          ...command("push", null),
          args: ["push", "origin"],
          env: { GIT_TERMINAL_PROMPT: "1", SYNARA_TEST_MARKER: "preserved" },
        });
        yield* core.execute({
          ...command("configured-push", null),
          args: ["-c", "credential.helper=", "push"],
          env: { GIT_TERMINAL_PROMPT: "1" },
        });
        yield* core.execute({
          ...command("commit", null),
          args: ["commit", "-m", "test"],
          env: { GIT_TERMINAL_PROMPT: "1" },
        });
        for (const subcommand of ["fetch", "pull", "clone"])
          yield* core.execute({
            ...command(subcommand),
            args: ["-c", "credential.helper=", subcommand],
            env: { GIT_TERMINAL_PROMPT: "1", SYNARA_TEST_MARKER: "preserved" },
          });
        expect(inputs[0]?.options?.env?.GIT_TERMINAL_PROMPT).toBe("0");
        expect(inputs[0]?.options?.env?.SYNARA_TEST_MARKER).toBe("preserved");
        expect(inputs[1]?.options?.env?.GIT_TERMINAL_PROMPT).toBe("0");
        expect(inputs[2]?.options?.env?.GIT_TERMINAL_PROMPT).toBe("1");
        for (const input of inputs.slice(3)) {
          expect(input.options?.env?.GIT_TERMINAL_PROMPT).toBe("0");
          expect(input.options?.env?.SYNARA_TEST_MARKER).toBe("preserved");
        }
      }),
  );
});
