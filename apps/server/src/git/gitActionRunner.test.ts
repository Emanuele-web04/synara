import { WsRpcError, type GitRunStackedActionInput } from "@synara/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Deferred, Duration, Effect, Exit, Fiber, Layer, Scope, Stream } from "effect";
import { TestClock } from "effect/testing";
import { expect, it } from "vitest";

import { SessionCredentialServiceLive } from "../auth/Layers/SessionCredentialService";
import { ServerSecretStoreLive } from "../auth/Layers/ServerSecretStore";
import { SessionCredentialService } from "../auth/Services/SessionCredentialService";
import { ServerConfig } from "../config";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite";
import { CurrentManagedAttachmentPrincipal } from "../managedAttachmentPrincipal";
import { makeGitActionRunner } from "./gitActionRunner";

const input: GitRunStackedActionInput = {
  actionId: "original",
  cwd: "/repo",
  action: "push",
  recoverable: true,
};

const sessionLayer = SessionCredentialServiceLive.pipe(
  Layer.provide(SqlitePersistenceMemory),
  Layer.provide(ServerSecretStoreLive),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "synara-git-session-test-" })),
  Layer.provide(NodeServices.layer),
);

it("cancels legacy client work when its observer stops waiting", async () => {
  await Effect.scoped(
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      let finalized = false;
      const observe = yield* makeGitActionRunner(() =>
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(
            Effect.sync(() => {
              finalized = true;
            }),
          ),
        ),
      );
      const { recoverable: _, ...legacyInput } = input;
      const observer = yield* observe(legacyInput).pipe(Stream.runDrain, Effect.forkChild);
      yield* Deferred.await(started);
      yield* Fiber.interrupt(observer);
      expect(finalized).toBe(true);
    }),
  ).pipe(Effect.runPromise);
});

it.each(["revocation", "expiry"])(
  "cancels detached Git work at durable session %s",
  async (reason) => {
    await Effect.scoped(
      Effect.gen(function* () {
        const sessions = yield* SessionCredentialService;
        const issued = yield* sessions.issue({ ttl: Duration.seconds(1) });
        const started = yield* Deferred.make<void>();
        const finalized = yield* Deferred.make<void>();
        const observe = yield* makeGitActionRunner(() =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(Deferred.succeed(finalized, undefined)),
          ),
        );
        const observer = yield* observe(input).pipe(
          Stream.runDrain,
          Effect.provideService(CurrentManagedAttachmentPrincipal, {
            ownerKind: "session",
            ownerId: issued.sessionId,
          }),
          Effect.forkChild,
        );
        yield* Deferred.await(started);
        yield* Fiber.interrupt(observer);
        expect(yield* Deferred.isDone(finalized)).toBe(false);
        if (reason === "revocation") yield* sessions.revoke(issued.sessionId);
        else yield* TestClock.adjust("2 seconds");
        const stopped = yield* TestClock.withLive(
          Deferred.await(finalized).pipe(Effect.timeoutOption("1 second")),
        );
        expect(stopped._tag).toBe("Some");
        const failure = yield* observe({ ...input, resume: true }).pipe(
          Stream.runDrain,
          Effect.provideService(CurrentManagedAttachmentPrincipal, {
            ownerKind: "session",
            ownerId: issued.sessionId,
          }),
          Effect.flip,
        );
        expect(failure.message).toBe("Git action authorization ended.");
      }),
    ).pipe(Effect.provide(Layer.merge(sessionLayer, TestClock.layer())), Effect.runPromise);
  },
);

it("rebuilds the current phase and hook after missing structural events during disconnect", async () => {
  await Effect.scoped(
    Effect.gen(function* () {
      const initial = yield* Deferred.make<void>();
      const advance = yield* Deferred.make<void>();
      const advanced = yield* Deferred.make<void>();
      const observe = yield* makeGitActionRunner((_input, publish) =>
        Effect.gen(function* () {
          yield* publish({ ...input, kind: "action_started", phases: ["branch", "commit"] });
          yield* publish({
            ...input,
            kind: "phase_started",
            phase: "branch",
            label: "Preparing branch...",
          });
          yield* Deferred.succeed(initial, undefined);
          yield* Deferred.await(advance);
          yield* publish({
            ...input,
            kind: "phase_started",
            phase: "commit",
            label: "Committing...",
          });
          yield* publish({ ...input, kind: "hook_started", hookName: "pre-commit" });
          for (let index = 0; index < 150; index++) {
            yield* publish({
              ...input,
              kind: "hook_output",
              hookName: "pre-commit",
              stream: "stdout",
              text: `line ${index}`,
            });
          }
          yield* Deferred.succeed(advanced, undefined);
          yield* Effect.never;
        }),
      );
      const first = yield* observe(input).pipe(Stream.runDrain, Effect.forkChild);
      yield* Deferred.await(initial);
      yield* Fiber.interrupt(first);
      yield* Deferred.succeed(advance, undefined);
      yield* Deferred.await(advanced);
      const events = yield* observe({ ...input, resume: true }).pipe(
        Stream.takeUntil((event) => event.kind === "hook_output"),
        Stream.runCollect,
      );
      expect(events).toMatchObject([
        { kind: "action_started" },
        { kind: "phase_started", phase: "commit" },
        { kind: "hook_started", hookName: "pre-commit" },
        { kind: "hook_output", text: "line 149" },
      ]);
    }),
  ).pipe(Effect.runPromise);
});

it("replays a failed action, rejects changed inputs and foreign or missing receipts without executing", async () => {
  let runs = 0;
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const observe = yield* makeGitActionRunner(() => {
          runs++;
          return Effect.fail(new WsRpcError({ message: "remote rejected push" }));
        });
        for (const request of [input, { ...input, resume: true }]) {
          const failure = yield* observe(request).pipe(Stream.runDrain, Effect.flip);
          expect(failure.message).toBe("remote rejected push");
        }
        const changed = yield* observe({ ...input, action: "commit", resume: true }).pipe(
          Stream.runDrain,
          Effect.flip,
        );
        expect(changed.message).toContain("different inputs");
        const missing = yield* observe({ ...input, actionId: "missing", resume: true }).pipe(
          Stream.runDrain,
          Effect.flip,
        );
        expect(missing.message).toContain("result is unavailable");
        const foreign = yield* observe({ ...input, resume: true }).pipe(
          Stream.runDrain,
          Effect.provideService(CurrentManagedAttachmentPrincipal, {
            ownerKind: "session" as const,
            ownerId: "other-session",
          }),
          Effect.flip,
        );
        expect(foreign.message).toContain("result is unavailable");
        expect(runs).toBe(1);
      }),
    ),
  );
});

it("retains running actions through observer cancellation but interrupts them on server shutdown", async () => {
  let finalized = false;
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const serverScope = yield* Scope.make();
        const started = yield* Deferred.make<void>();
        const observe = yield* makeGitActionRunner(() =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(
              Effect.sync(() => {
                finalized = true;
              }),
            ),
          ),
        ).pipe(Scope.provide(serverScope));
        const observer = yield* observe(input).pipe(Stream.runDrain, Effect.forkChild);
        yield* Deferred.await(started);
        yield* Fiber.interrupt(observer);
        expect(finalized).toBe(false);
        yield* Scope.close(serverScope, Exit.void);
        expect(finalized).toBe(true);
      }),
    ),
  );
});
