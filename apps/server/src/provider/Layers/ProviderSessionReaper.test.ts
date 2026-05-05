import { ThreadId, TurnId, type OrchestrationReadModel } from "@t3tools/contracts";
import { Effect, Exit, Layer, Scope, Stream } from "effect";
import { describe, expect, it, vi } from "vitest";

import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../../orchestration/Services/OrchestrationEngine";
import {
  ProviderSessionDirectory,
  type ProviderSessionDirectoryShape,
} from "../Services/ProviderSessionDirectory";
import { ProviderSessionReaper } from "../Services/ProviderSessionReaper";
import { ProviderService, type ProviderServiceShape } from "../Services/ProviderService";
import { makeProviderSessionReaperLive } from "./ProviderSessionReaper";

const unsupported = () => Effect.die(new Error("Unsupported test call")) as never;

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for predicate");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function makeReadModel(input: {
  readonly threadId: ThreadId;
  readonly activeTurnId: TurnId | null;
}): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    updatedAt: new Date().toISOString(),
    projects: [],
    threads: [
      {
        id: input.threadId,
        session: input.activeTurnId
          ? {
              activeTurnId: input.activeTurnId,
            }
          : null,
      },
    ],
  } as unknown as OrchestrationReadModel;
}

function makeLayer(input: {
  readonly readModel: OrchestrationReadModel;
  readonly directory: ProviderSessionDirectoryShape;
  readonly providerService: ProviderServiceShape;
}) {
  const orchestrationEngine: OrchestrationEngineShape = {
    getReadModel: () => Effect.succeed(input.readModel),
    readEvents: () => Stream.empty,
    dispatch: () => unsupported(),
    repairState: () => unsupported(),
    streamDomainEvents: Stream.empty,
  };

  return makeProviderSessionReaperLive({
    inactivityThresholdMs: 1,
    sweepIntervalMs: 60_000,
  }).pipe(
    Layer.provide(Layer.succeed(ProviderSessionDirectory, input.directory)),
    Layer.provide(Layer.succeed(ProviderService, input.providerService)),
    Layer.provide(Layer.succeed(OrchestrationEngineService, orchestrationEngine)),
  );
}

describe("ProviderSessionReaperLive", () => {
  it("stops stale sessions without active turns", async () => {
    const threadId = ThreadId.makeUnsafe("thread-reaper-stale");
    const stopSession = vi.fn<ProviderServiceShape["stopSession"]>(() => Effect.void);
    const directory: ProviderSessionDirectoryShape = {
      upsert: () => Effect.void,
      getProvider: () => unsupported(),
      getBinding: () => unsupported(),
      remove: () => Effect.void,
      listThreadIds: () => Effect.succeed([]),
      listBindings: () =>
        Effect.succeed([
          {
            threadId,
            provider: "codex",
            status: "running",
            lastSeenAt: "2026-01-01T00:00:00.000Z",
          },
        ]),
    };
    const providerService: ProviderServiceShape = {
      startSession: () => unsupported(),
      sendTurn: () => unsupported(),
      steerTurn: () => unsupported(),
      startReview: () => unsupported(),
      interruptTurn: () => unsupported(),
      respondToRequest: () => unsupported(),
      respondToUserInput: () => unsupported(),
      stopSession,
      listSessions: () => Effect.succeed([]),
      getCapabilities: () => unsupported(),
      rollbackConversation: () => unsupported(),
      compactThread: () => unsupported(),
      streamEvents: Stream.empty,
    };

    const scope = await Effect.runPromise(Scope.make());
    try {
      await Effect.gen(function* () {
        const reaper = yield* ProviderSessionReaper;
        yield* Scope.provide(reaper.start(), scope);
      }).pipe(
        Effect.provide(
          makeLayer({
            readModel: makeReadModel({ threadId, activeTurnId: null }),
            directory,
            providerService,
          }),
        ),
        Effect.runPromise,
      );
      await waitFor(() => stopSession.mock.calls.length === 1);
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }

    expect(stopSession).toHaveBeenCalledWith({ threadId });
  });

  it("skips stale sessions with active turns", async () => {
    const threadId = ThreadId.makeUnsafe("thread-reaper-active");
    const turnId = TurnId.makeUnsafe("turn-reaper-active");
    const stopSession = vi.fn<ProviderServiceShape["stopSession"]>(() => Effect.void);
    const directory: ProviderSessionDirectoryShape = {
      upsert: () => Effect.void,
      getProvider: () => unsupported(),
      getBinding: () => unsupported(),
      remove: () => Effect.void,
      listThreadIds: () => Effect.succeed([]),
      listBindings: () =>
        Effect.succeed([
          {
            threadId,
            provider: "codex",
            status: "running",
            lastSeenAt: "2026-01-01T00:00:00.000Z",
          },
        ]),
    };
    const providerService: ProviderServiceShape = {
      startSession: () => unsupported(),
      sendTurn: () => unsupported(),
      steerTurn: () => unsupported(),
      startReview: () => unsupported(),
      interruptTurn: () => unsupported(),
      respondToRequest: () => unsupported(),
      respondToUserInput: () => unsupported(),
      stopSession,
      listSessions: () => Effect.succeed([]),
      getCapabilities: () => unsupported(),
      rollbackConversation: () => unsupported(),
      compactThread: () => unsupported(),
      streamEvents: Stream.empty,
    };

    const scope = await Effect.runPromise(Scope.make());
    try {
      await Effect.gen(function* () {
        const reaper = yield* ProviderSessionReaper;
        yield* Scope.provide(reaper.start(), scope);
      }).pipe(
        Effect.provide(
          makeLayer({
            readModel: makeReadModel({ threadId, activeTurnId: turnId }),
            directory,
            providerService,
          }),
        ),
        Effect.runPromise,
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }

    expect(stopSession).not.toHaveBeenCalled();
  });
});
