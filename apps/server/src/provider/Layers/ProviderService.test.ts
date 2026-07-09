import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type {
  ProviderApprovalDecision,
  ProviderRuntimeEvent,
  ProviderSendTurnInput,
  ProviderSession,
  ProviderTurnStartResult,
} from "@t3tools/contracts";
import {
  ApprovalRequestId,
  EventId,
  type ProviderKind,
  ProviderSessionStartInput,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { it, assert, vi } from "@effect/vitest";
import { assertFailure } from "@effect/vitest/utils";

import { Effect, Fiber, Layer, Option, PubSub, Ref, Stream } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  ProviderAdapterSessionNotFoundError,
  ProviderUnsupportedError,
  ProviderValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import { ProviderAdapterRegistry } from "../Services/ProviderAdapterRegistry.ts";
import { ProviderService } from "../Services/ProviderService.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";
import { makeProviderServiceLive } from "./ProviderService.ts";
import { ProviderSessionDirectoryLive } from "./ProviderSessionDirectory.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderSessionRuntimeRepositoryLive } from "../../persistence/Layers/ProviderSessionRuntime.ts";
import { ProviderSessionRuntimeRepository } from "../../persistence/Services/ProviderSessionRuntime.ts";
import {
  makeSqlitePersistenceLive,
  SqlitePersistenceMemory,
} from "../../persistence/Layers/Sqlite.ts";
import { AnalyticsService } from "../../telemetry/Services/AnalyticsService.ts";

const asRequestId = (value: string): ApprovalRequestId => ApprovalRequestId.makeUnsafe(value);
const asEventId = (value: string): EventId => EventId.makeUnsafe(value);
const asThreadId = (value: string): ThreadId => ThreadId.makeUnsafe(value);
const asTurnId = (value: string): TurnId => TurnId.makeUnsafe(value);

type LegacyProviderRuntimeEvent = {
  readonly type: string;
  readonly eventId: EventId;
  readonly provider: ProviderKind;
  readonly createdAt: string;
  readonly threadId: ThreadId;
  readonly turnId?: string | undefined;
  readonly itemId?: string | undefined;
  readonly requestId?: string | undefined;
  readonly payload?: unknown | undefined;
  readonly [key: string]: unknown;
};

type ReleaseListSessions = (sessions: ReadonlyArray<ProviderSession>) => void;

// Converts deferred listSessions callbacks into typed release handles for race tests.
function requireReleaseListSessions(release: ReleaseListSessions | undefined): ReleaseListSessions {
  if (typeof release !== "function") {
    assert.fail("Expected listSessions release callback");
  }
  return release;
}

function makeFakeCodexAdapter(provider: ProviderKind = "codex") {
  const sessions = new Map<ThreadId, ProviderSession>();
  const runtimeEventPubSub = Effect.runSync(PubSub.unbounded<ProviderRuntimeEvent>());

  const startSession = vi.fn((input: ProviderSessionStartInput) =>
    Effect.sync(() => {
      const now = new Date().toISOString();
      const session: ProviderSession = {
        provider,
        status: "ready",
        runtimeMode: input.runtimeMode,
        threadId: input.threadId,
        resumeCursor: input.resumeCursor ?? { opaque: `resume-${String(input.threadId)}` },
        cwd: input.cwd ?? process.cwd(),
        createdAt: now,
        updatedAt: now,
      };
      sessions.set(session.threadId, session);
      return session;
    }),
  );

  const sendTurn = vi.fn(
    (
      input: ProviderSendTurnInput,
    ): Effect.Effect<ProviderTurnStartResult, ProviderAdapterError> => {
      if (!sessions.has(input.threadId)) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({
            provider,
            threadId: input.threadId,
          }),
        );
      }

      return Effect.succeed({
        threadId: input.threadId,
        turnId: TurnId.makeUnsafe(`turn-${String(input.threadId)}`),
      });
    },
  );

  const interruptTurn = vi.fn(
    (
      _threadId: ThreadId,
      _turnId?: TurnId,
      _providerThreadId?: string,
    ): Effect.Effect<void, ProviderAdapterError> => Effect.void,
  );

  const respondToRequest = vi.fn(
    (
      _threadId: ThreadId,
      _requestId: string,
      _decision: ProviderApprovalDecision,
    ): Effect.Effect<void, ProviderAdapterError> => Effect.void,
  );

  const respondToUserInput = vi.fn(
    (
      _threadId: ThreadId,
      _requestId: string,
      _answers: Record<string, unknown>,
    ): Effect.Effect<void, ProviderAdapterError> => Effect.void,
  );

  const stopSession = vi.fn(
    (threadId: ThreadId): Effect.Effect<void, ProviderAdapterError> =>
      Effect.sync(() => {
        sessions.delete(threadId);
      }),
  );

  const listSessions = vi.fn(
    (): Effect.Effect<ReadonlyArray<ProviderSession>> =>
      Effect.sync(() => Array.from(sessions.values())),
  );

  const hasSession = vi.fn(
    (threadId: ThreadId): Effect.Effect<boolean> => Effect.succeed(sessions.has(threadId)),
  );

  const readThread = vi.fn(
    (
      threadId: ThreadId,
    ): Effect.Effect<
      {
        threadId: ThreadId;
        turns: ReadonlyArray<{ id: TurnId; items: readonly [] }>;
      },
      ProviderAdapterError
    > =>
      Effect.succeed({
        threadId,
        turns: [{ id: asTurnId("turn-1"), items: [] }],
      }),
  );

  const rollbackThread = vi.fn(
    (
      threadId: ThreadId,
      _numTurns: number,
    ): Effect.Effect<{ threadId: ThreadId; turns: readonly [] }, ProviderAdapterError> =>
      Effect.succeed({ threadId, turns: [] }),
  );

  const compactThread = vi.fn(
    (_threadId: ThreadId): Effect.Effect<void, ProviderAdapterError> => Effect.void,
  );

  const stopAll = vi.fn(
    (): Effect.Effect<void, ProviderAdapterError> =>
      Effect.sync(() => {
        sessions.clear();
      }),
  );

  const adapter: ProviderAdapterShape<ProviderAdapterError> = {
    provider,
    capabilities: {
      sessionModelSwitch: "in-session",
    },
    startSession,
    sendTurn,
    interruptTurn,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions,
    hasSession,
    readThread,
    rollbackThread,
    compactThread,
    stopAll,
    streamEvents: Stream.fromPubSub(runtimeEventPubSub),
  };

  const emit = (event: LegacyProviderRuntimeEvent): void => {
    Effect.runSync(PubSub.publish(runtimeEventPubSub, event as unknown as ProviderRuntimeEvent));
  };

  const waitForRuntimeSubscribers = (count = 1): Effect.Effect<void> =>
    waitUntil(
      () => runtimeEventPubSub.subscribers.size >= count,
      500,
      20,
      `${provider} runtime event subscriber`,
    );

  const updateSession = (
    threadId: ThreadId,
    update: (session: ProviderSession) => ProviderSession,
  ): void => {
    const existing = sessions.get(threadId);
    if (!existing) {
      return;
    }
    sessions.set(threadId, update(existing));
  };

  return {
    adapter,
    emit,
    waitForRuntimeSubscribers,
    updateSession,
    startSession,
    sendTurn,
    interruptTurn,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions,
    hasSession,
    readThread,
    rollbackThread,
    compactThread,
    stopAll,
  };
}

const sleep = (ms: number) =>
  Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));

const waitUntil = (
  predicate: () => boolean,
  timeoutMs = 500,
  intervalMs = 20,
  description = "condition",
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const deadline = Date.now() + timeoutMs;
    while (!predicate() && Date.now() < deadline) {
      yield* sleep(intervalMs);
    }
    if (!predicate()) {
      assert.fail(`Timed out waiting for ${description}`);
    }
  });

const waitUntilEffect = <E = never, R = never>(
  predicate: () => Effect.Effect<boolean, E, R>,
  timeoutMs = 500,
  intervalMs = 20,
  description = "condition",
): Effect.Effect<void, E, R> =>
  Effect.gen(function* () {
    const deadline = Date.now() + timeoutMs;
    let matched = yield* predicate();
    while (!matched && Date.now() < deadline) {
      yield* sleep(intervalMs);
      matched = yield* predicate();
    }
    if (!matched) {
      assert.fail(`Timed out waiting for ${description}`);
    }
  });

function makeProviderServiceLayer(options?: Parameters<typeof makeProviderServiceLive>[0]) {
  const codex = makeFakeCodexAdapter();
  const claude = makeFakeCodexAdapter("claudeAgent");
  const registry: typeof ProviderAdapterRegistry.Service = {
    getByProvider: (provider) =>
      provider === "codex"
        ? Effect.succeed(codex.adapter)
        : provider === "claudeAgent"
          ? Effect.succeed(claude.adapter)
          : Effect.fail(new ProviderUnsupportedError({ provider })),
    listProviders: () => Effect.succeed(["codex", "claudeAgent"]),
  };

  const providerAdapterLayer = Layer.succeed(ProviderAdapterRegistry, registry);
  const runtimeRepositoryLayer = ProviderSessionRuntimeRepositoryLive.pipe(
    Layer.provide(SqlitePersistenceMemory),
  );
  const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer));

  const layer = it.layer(
    Layer.mergeAll(
      makeProviderServiceLive(options).pipe(
        Layer.provide(providerAdapterLayer),
        Layer.provide(directoryLayer),
        Layer.provideMerge(AnalyticsService.layerTest),
      ),
      directoryLayer,

      runtimeRepositoryLayer,
      NodeServices.layer,
    ),
  );

  return {
    codex,
    claude,
    layer,
  };
}

const routing = makeProviderServiceLayer();
it.effect("ProviderServiceLive keeps persisted resumable sessions on startup", () =>
  Effect.gen(function* () {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-provider-service-"));
    const dbPath = path.join(tempDir, "orchestration.sqlite");

    const codex = makeFakeCodexAdapter();
    const registry: typeof ProviderAdapterRegistry.Service = {
      getByProvider: (provider) =>
        provider === "codex"
          ? Effect.succeed(codex.adapter)
          : Effect.fail(new ProviderUnsupportedError({ provider })),
      listProviders: () => Effect.succeed(["codex"]),
    };

    const persistenceLayer = makeSqlitePersistenceLive(dbPath);
    const runtimeRepositoryLayer = ProviderSessionRuntimeRepositoryLive.pipe(
      Layer.provide(persistenceLayer),
    );
    const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer));

    yield* Effect.gen(function* () {
      const directory = yield* ProviderSessionDirectory;
      yield* directory.upsert({
        provider: "codex",
        threadId: ThreadId.makeUnsafe("thread-stale"),
      });
    }).pipe(Effect.provide(directoryLayer));

    const providerLayer = makeProviderServiceLive().pipe(
      Layer.provide(Layer.succeed(ProviderAdapterRegistry, registry)),
      Layer.provide(directoryLayer),
      Layer.provide(AnalyticsService.layerTest),
    );

    yield* Effect.gen(function* () {
      yield* ProviderService;
    }).pipe(Effect.provide(providerLayer));

    const persistedProvider = yield* Effect.gen(function* () {
      const directory = yield* ProviderSessionDirectory;
      return yield* directory.getProvider(asThreadId("thread-stale"));
    }).pipe(Effect.provide(directoryLayer));
    assert.equal(persistedProvider, "codex");

    const runtime = yield* Effect.gen(function* () {
      const repository = yield* ProviderSessionRuntimeRepository;
      return yield* repository.getByThreadId({ threadId: asThreadId("thread-stale") });
    }).pipe(Effect.provide(runtimeRepositoryLayer));
    assert.equal(Option.isSome(runtime), true);

    const legacyTableRows = yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return yield* sql<{ readonly name: string }>`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table' AND name = 'provider_sessions'
      `;
    }).pipe(Effect.provide(persistenceLayer));
    assert.equal(legacyTableRows.length, 0);

    fs.rmSync(tempDir, { recursive: true, force: true });
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "ProviderServiceLive persists active sessions as stopped before adapter cleanup runs",
  () =>
    Effect.gen(function* () {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-provider-service-stopall-"));
      const dbPath = path.join(tempDir, "orchestration.sqlite");
      const persistenceLayer = makeSqlitePersistenceLive(dbPath);
      const runtimeRepositoryLayer = ProviderSessionRuntimeRepositoryLive.pipe(
        Layer.provide(persistenceLayer),
      );

      const codex = makeFakeCodexAdapter();
      const threadId = asThreadId("thread-stopall");
      const resumeCursor = {
        threadId,
        resume: "resume-session-stopall",
        resumeSessionAt: "assistant-message-stopall",
        turnCount: 1,
      };
      codex.stopAll.mockImplementation(() =>
        Effect.fail(
          new ProviderAdapterSessionNotFoundError({
            provider: "codex",
            threadId,
          }),
        ),
      );

      const registry: typeof ProviderAdapterRegistry.Service = {
        getByProvider: (provider) =>
          provider === "codex"
            ? Effect.succeed(codex.adapter)
            : Effect.fail(new ProviderUnsupportedError({ provider })),
        listProviders: () => Effect.succeed(["codex"]),
      };

      const providerLayer = makeProviderServiceLive().pipe(
        Layer.provide(Layer.succeed(ProviderAdapterRegistry, registry)),
        Layer.provide(ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer))),
        Layer.provide(AnalyticsService.layerTest),
      );

      yield* Effect.gen(function* () {
        const provider = yield* ProviderService;
        yield* provider.startSession(threadId, {
          provider: "codex",
          cwd: "/tmp/project",
          runtimeMode: "full-access",
          threadId,
        });
        codex.updateSession(threadId, (existing) => ({
          ...existing,
          status: "running",
          activeTurnId: asTurnId("turn-stopall"),
          resumeCursor,
        }));
      }).pipe(Effect.provide(providerLayer));

      const persisted = yield* Effect.gen(function* () {
        const repository = yield* ProviderSessionRuntimeRepository;
        return yield* repository.getByThreadId({ threadId });
      }).pipe(Effect.provide(runtimeRepositoryLayer));

      assert.equal(Option.isSome(persisted), true);
      if (Option.isSome(persisted)) {
        const runtimePayload = persisted.value.runtimePayload as Record<string, unknown>;
        assert.equal(persisted.value.status, "stopped");
        assert.deepEqual(persisted.value.resumeCursor, resumeCursor);
        assert.equal(runtimePayload.activeTurnId, null);
        assert.equal(runtimePayload.lastRuntimeEvent, "provider.stopAll");
      }

      fs.rmSync(tempDir, { recursive: true, force: true });
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "ProviderServiceLive restores rollback routing after restart using persisted thread mapping",
  () =>
    Effect.gen(function* () {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-provider-service-restart-"));
      const dbPath = path.join(tempDir, "orchestration.sqlite");
      const persistenceLayer = makeSqlitePersistenceLive(dbPath);
      const runtimeRepositoryLayer = ProviderSessionRuntimeRepositoryLive.pipe(
        Layer.provide(persistenceLayer),
      );

      const firstCodex = makeFakeCodexAdapter();
      const firstRegistry: typeof ProviderAdapterRegistry.Service = {
        getByProvider: (provider) =>
          provider === "codex"
            ? Effect.succeed(firstCodex.adapter)
            : Effect.fail(new ProviderUnsupportedError({ provider })),
        listProviders: () => Effect.succeed(["codex"]),
      };

      const firstDirectoryLayer = ProviderSessionDirectoryLive.pipe(
        Layer.provide(runtimeRepositoryLayer),
      );
      const firstProviderLayer = makeProviderServiceLive().pipe(
        Layer.provide(Layer.succeed(ProviderAdapterRegistry, firstRegistry)),
        Layer.provide(firstDirectoryLayer),
        Layer.provide(AnalyticsService.layerTest),
      );
      const updatedResumeCursor = {
        threadId: asThreadId("thread-1"),
        resume: "resume-session-1",
        resumeSessionAt: "assistant-message-1",
        turnCount: 1,
      };

      const startedSession = yield* Effect.gen(function* () {
        const provider = yield* ProviderService;
        const threadId = asThreadId("thread-1");
        const session = yield* provider.startSession(threadId, {
          provider: "codex",
          cwd: "/tmp/project",
          runtimeMode: "full-access",
          threadId,
        });
        firstCodex.updateSession(threadId, (existing) => ({
          ...existing,
          status: "ready",
          resumeCursor: updatedResumeCursor,
          updatedAt: new Date(Date.now() + 1_000).toISOString(),
        }));
        return session;
      }).pipe(Effect.provide(firstProviderLayer));

      const persistedAfterStopAll = yield* Effect.gen(function* () {
        const repository = yield* ProviderSessionRuntimeRepository;
        return yield* repository.getByThreadId({ threadId: startedSession.threadId });
      }).pipe(Effect.provide(runtimeRepositoryLayer));
      assert.equal(Option.isSome(persistedAfterStopAll), true);
      if (Option.isSome(persistedAfterStopAll)) {
        assert.equal(persistedAfterStopAll.value.status, "stopped");
        assert.deepEqual(persistedAfterStopAll.value.resumeCursor, updatedResumeCursor);
      }

      const secondCodex = makeFakeCodexAdapter();
      const secondRegistry: typeof ProviderAdapterRegistry.Service = {
        getByProvider: (provider) =>
          provider === "codex"
            ? Effect.succeed(secondCodex.adapter)
            : Effect.fail(new ProviderUnsupportedError({ provider })),
        listProviders: () => Effect.succeed(["codex"]),
      };
      const secondDirectoryLayer = ProviderSessionDirectoryLive.pipe(
        Layer.provide(runtimeRepositoryLayer),
      );
      const secondProviderLayer = makeProviderServiceLive().pipe(
        Layer.provide(Layer.succeed(ProviderAdapterRegistry, secondRegistry)),
        Layer.provide(secondDirectoryLayer),
        Layer.provide(AnalyticsService.layerTest),
      );

      secondCodex.startSession.mockClear();
      secondCodex.rollbackThread.mockClear();

      yield* Effect.gen(function* () {
        const provider = yield* ProviderService;
        yield* provider.rollbackConversation({
          threadId: startedSession.threadId,
          numTurns: 1,
        });
      }).pipe(Effect.provide(secondProviderLayer));

      assert.equal(secondCodex.startSession.mock.calls.length, 1);
      const resumedStartInput = secondCodex.startSession.mock.calls[0]?.[0];
      assert.equal(typeof resumedStartInput === "object" && resumedStartInput !== null, true);
      if (resumedStartInput && typeof resumedStartInput === "object") {
        const startPayload = resumedStartInput as {
          provider?: string;
          cwd?: string;
          resumeCursor?: unknown;
          threadId?: string;
        };
        assert.equal(startPayload.provider, "codex");
        assert.equal(startPayload.cwd, "/tmp/project");
        assert.deepEqual(startPayload.resumeCursor, updatedResumeCursor);
        assert.equal(startPayload.threadId, startedSession.threadId);
      }
      assert.equal(secondCodex.rollbackThread.mock.calls.length, 1);
      const rollbackCall = secondCodex.rollbackThread.mock.calls[0];
      assert.equal(typeof rollbackCall?.[0], "string");
      assert.equal(rollbackCall?.[1], 1);

      fs.rmSync(tempDir, { recursive: true, force: true });
    }).pipe(Effect.provide(NodeServices.layer)),
);

routing.layer("ProviderServiceLive routing", (it) => {
  it.effect("routes provider operations and rollback conversation", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;

      const session = yield* provider.startSession(asThreadId("thread-1"), {
        provider: "codex",
        threadId: asThreadId("thread-1"),
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });
      assert.equal(session.provider, "codex");

      const sessions = yield* provider.listSessions();
      assert.equal(sessions.length, 1);

      yield* provider.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });
      assert.equal(routing.codex.sendTurn.mock.calls.length, 1);

      yield* provider.interruptTurn({ threadId: session.threadId });
      assert.deepEqual(routing.codex.interruptTurn.mock.calls, [
        [session.threadId, undefined, undefined],
      ]);

      yield* provider.respondToRequest({
        threadId: session.threadId,
        requestId: asRequestId("req-1"),
        decision: "accept",
      });
      assert.deepEqual(routing.codex.respondToRequest.mock.calls, [
        [session.threadId, asRequestId("req-1"), "accept"],
      ]);

      yield* provider.respondToUserInput({
        threadId: session.threadId,
        requestId: asRequestId("req-user-input-1"),
        answers: {
          sandbox_mode: "workspace-write",
        },
      });
      assert.deepEqual(routing.codex.respondToUserInput.mock.calls, [
        [
          session.threadId,
          asRequestId("req-user-input-1"),
          {
            sandbox_mode: "workspace-write",
          },
        ],
      ]);

      yield* provider.rollbackConversation({
        threadId: session.threadId,
        numTurns: 0,
      });

      yield* provider.stopSession({ threadId: session.threadId });
      const sendAfterStop = yield* Effect.result(
        provider.sendTurn({
          threadId: session.threadId,
          input: "after-stop",
          attachments: [],
        }),
      );
      assertFailure(
        sendAfterStop,
        new ProviderValidationError({
          operation: "ProviderService.sendTurn",
          issue: `Cannot route thread '${session.threadId}' because no persisted provider binding exists.`,
        }),
      );
    }),
  );

  it.effect(
    "routes early approval and user-input responses to live sessions before persistence",
    () =>
      Effect.gen(function* () {
        const provider = yield* ProviderService;
        const directory = yield* ProviderSessionDirectory;
        const threadId = asThreadId("thread-live-startup-prompt");

        routing.codex.respondToRequest.mockClear();
        routing.codex.respondToUserInput.mockClear();
        yield* routing.codex.adapter.startSession({
          provider: "codex",
          threadId,
          runtimeMode: "approval-required",
        });

        const bindingBeforeResponse = yield* directory.getBinding(threadId);
        assert.equal(Option.isNone(bindingBeforeResponse), true);

        yield* provider.respondToRequest({
          threadId,
          requestId: asRequestId("req-live-approval"),
          decision: "accept",
        });
        yield* provider.respondToUserInput({
          threadId,
          requestId: asRequestId("req-live-user-input"),
          answers: {
            answer: "continue",
          },
        });

        assert.deepEqual(routing.codex.respondToRequest.mock.calls, [
          [threadId, asRequestId("req-live-approval"), "accept"],
        ]);
        assert.deepEqual(routing.codex.respondToUserInput.mock.calls, [
          [
            threadId,
            asRequestId("req-live-user-input"),
            {
              answer: "continue",
            },
          ],
        ]);
      }),
  );

  it.effect("recovers stale persisted sessions for rollback by resuming thread identity", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;

      const initial = yield* provider.startSession(asThreadId("thread-1"), {
        provider: "codex",
        threadId: asThreadId("thread-1"),
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });
      yield* routing.codex.stopSession(initial.threadId);
      routing.codex.startSession.mockClear();
      routing.codex.rollbackThread.mockClear();

      yield* provider.rollbackConversation({
        threadId: initial.threadId,
        numTurns: 1,
      });

      assert.equal(routing.codex.startSession.mock.calls.length, 1);
      const resumedStartInput = routing.codex.startSession.mock.calls[0]?.[0];
      assert.equal(typeof resumedStartInput === "object" && resumedStartInput !== null, true);
      if (resumedStartInput && typeof resumedStartInput === "object") {
        const startPayload = resumedStartInput as {
          provider?: string;
          cwd?: string;
          resumeCursor?: unknown;
          threadId?: string;
        };
        assert.equal(startPayload.provider, "codex");
        assert.equal(startPayload.cwd, "/tmp/project");
        assert.deepEqual(startPayload.resumeCursor, initial.resumeCursor);
        assert.equal(startPayload.threadId, initial.threadId);
      }
      assert.equal(routing.codex.rollbackThread.mock.calls.length, 1);
      const rollbackCall = routing.codex.rollbackThread.mock.calls[0];
      assert.equal(rollbackCall?.[1], 1);
    }),
  );

  it.effect("routes explicit claudeAgent provider session starts to the claude adapter", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;

      const session = yield* provider.startSession(asThreadId("thread-claude"), {
        provider: "claudeAgent",
        threadId: asThreadId("thread-claude"),
        cwd: "/tmp/project-claude",
        runtimeMode: "full-access",
      });

      assert.equal(session.provider, "claudeAgent");
      assert.equal(routing.claude.startSession.mock.calls.length, 1);
      const startInput = routing.claude.startSession.mock.calls[0]?.[0];
      assert.equal(typeof startInput === "object" && startInput !== null, true);
      if (startInput && typeof startInput === "object") {
        const startPayload = startInput as { provider?: string; cwd?: string };
        assert.equal(startPayload.provider, "claudeAgent");
        assert.equal(startPayload.cwd, "/tmp/project-claude");
      }
    }),
  );

  it.effect("recovers stale sessions for sendTurn using persisted cwd", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;

      const initial = yield* provider.startSession(asThreadId("thread-1"), {
        provider: "codex",
        threadId: asThreadId("thread-1"),
        cwd: "/tmp/project-send-turn",
        runtimeMode: "full-access",
      });

      yield* routing.codex.stopAll();
      routing.codex.startSession.mockClear();
      routing.codex.sendTurn.mockClear();

      yield* provider.sendTurn({
        threadId: initial.threadId,
        input: "resume",
        attachments: [],
      });

      assert.equal(routing.codex.startSession.mock.calls.length, 1);
      const resumedStartInput = routing.codex.startSession.mock.calls[0]?.[0];
      assert.equal(typeof resumedStartInput === "object" && resumedStartInput !== null, true);
      if (resumedStartInput && typeof resumedStartInput === "object") {
        const startPayload = resumedStartInput as {
          provider?: string;
          cwd?: string;
          resumeCursor?: unknown;
          threadId?: string;
        };
        assert.equal(startPayload.provider, "codex");
        assert.equal(startPayload.cwd, "/tmp/project-send-turn");
        assert.deepEqual(startPayload.resumeCursor, initial.resumeCursor);
        assert.equal(startPayload.threadId, initial.threadId);
      }
      assert.equal(routing.codex.sendTurn.mock.calls.length, 1);
    }),
  );

  it.effect("recovers stale claudeAgent sessions for sendTurn using persisted cwd", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;

      const initial = yield* provider.startSession(asThreadId("thread-claude-send-turn"), {
        provider: "claudeAgent",
        threadId: asThreadId("thread-claude-send-turn"),
        cwd: "/tmp/project-claude-send-turn",
        modelSelection: {
          provider: "claudeAgent",
          model: "claude-opus-4-6",
          options: {
            effort: "max",
          },
        },
        runtimeMode: "full-access",
      });

      yield* routing.claude.stopAll();
      routing.claude.startSession.mockClear();
      routing.claude.sendTurn.mockClear();

      yield* provider.sendTurn({
        threadId: initial.threadId,
        input: "resume with claude",
        attachments: [],
      });

      assert.equal(routing.claude.startSession.mock.calls.length, 1);
      const resumedStartInput = routing.claude.startSession.mock.calls[0]?.[0];
      assert.equal(typeof resumedStartInput === "object" && resumedStartInput !== null, true);
      if (resumedStartInput && typeof resumedStartInput === "object") {
        const startPayload = resumedStartInput as {
          provider?: string;
          cwd?: string;
          modelSelection?: unknown;
          resumeCursor?: unknown;
          threadId?: string;
        };
        assert.equal(startPayload.provider, "claudeAgent");
        assert.equal(startPayload.cwd, "/tmp/project-claude-send-turn");
        assert.deepEqual(startPayload.modelSelection, {
          provider: "claudeAgent",
          model: "claude-opus-4-6",
          options: {
            effort: "max",
          },
        });
        assert.deepEqual(startPayload.resumeCursor, initial.resumeCursor);
        assert.equal(startPayload.threadId, initial.threadId);
      }
      assert.equal(routing.claude.sendTurn.mock.calls.length, 1);
    }),
  );

  it.effect("lists no sessions after adapter runtime clears", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;

      yield* provider.startSession(asThreadId("thread-1"), {
        provider: "codex",
        threadId: asThreadId("thread-1"),
        runtimeMode: "full-access",
      });
      yield* provider.startSession(asThreadId("thread-2"), {
        provider: "codex",
        threadId: asThreadId("thread-2"),
        runtimeMode: "full-access",
      });

      yield* routing.codex.stopAll();
      yield* routing.claude.stopAll();

      const remaining = yield* provider.listSessions();
      assert.equal(remaining.length, 0);
    }),
  );

  it.effect("persists runtime status transitions in provider_session_runtime", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const runtimeRepository = yield* ProviderSessionRuntimeRepository;

      const session = yield* provider.startSession(asThreadId("thread-1"), {
        provider: "codex",
        threadId: asThreadId("thread-1"),
        runtimeMode: "full-access",
      });
      yield* provider.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      const runningRuntime = yield* runtimeRepository.getByThreadId({
        threadId: session.threadId,
      });
      assert.equal(Option.isSome(runningRuntime), true);
      if (Option.isSome(runningRuntime)) {
        assert.equal(runningRuntime.value.status, "running");
        assert.deepEqual(runningRuntime.value.resumeCursor, session.resumeCursor);
        const payload = runningRuntime.value.runtimePayload;
        assert.equal(payload !== null && typeof payload === "object", true);
        if (payload !== null && typeof payload === "object" && !Array.isArray(payload)) {
          const runtimePayload = payload as {
            cwd: string;
            model: string | null;
            activeTurnId: string | null;
            lastError: string | null;
            lastRuntimeEvent: string | null;
          };
          assert.equal(runtimePayload.cwd, process.cwd());
          assert.equal(runtimePayload.model, null);
          assert.equal(runtimePayload.activeTurnId, `turn-${String(session.threadId)}`);
          assert.equal(runtimePayload.lastError, null);
          assert.equal(runtimePayload.lastRuntimeEvent, "provider.sendTurn");
        }
      }
    }),
  );

  it.effect("clears persisted active turn metadata when a runtime turn completes", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const runtimeRepository = yield* ProviderSessionRuntimeRepository;

      const session = yield* provider.startSession(asThreadId("thread-runtime-complete"), {
        provider: "codex",
        threadId: asThreadId("thread-runtime-complete"),
        runtimeMode: "full-access",
      });
      const turn = yield* provider.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
        modelSelection: {
          provider: "opencode",
          model: "opencode/minimax-m2.5-free",
        },
      });
      yield* sleep(50);

      routing.codex.emit({
        type: "turn.completed",
        eventId: asEventId("runtime-complete-event"),
        provider: "codex",
        createdAt: "2026-02-27T00:04:00.000Z",
        threadId: session.threadId,
        turnId: turn.turnId,
        payload: { state: "completed" },
      });
      yield* sleep(50);

      const runtime = yield* runtimeRepository.getByThreadId({
        threadId: session.threadId,
      });
      assert.equal(Option.isSome(runtime), true);
      if (Option.isSome(runtime)) {
        assert.equal(runtime.value.status, "stopped");
        const payload = runtime.value.runtimePayload;
        assert.equal(payload !== null && typeof payload === "object", true);
        if (payload !== null && typeof payload === "object" && !Array.isArray(payload)) {
          const runtimePayload = payload as {
            activeTurnId: string | null;
            lastRuntimeEvent: string | null;
            modelSelection?: unknown;
          };
          assert.equal(runtimePayload.activeTurnId, null);
          assert.equal(runtimePayload.lastRuntimeEvent, "turn.completed");
          assert.deepEqual(runtimePayload.modelSelection, {
            provider: "opencode",
            model: "opencode/minimax-m2.5-free",
          });
        }
      }
    }),
  );

  it.effect("refreshes persisted resume cursor immediately on model reroutes", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const runtimeRepository = yield* ProviderSessionRuntimeRepository;

      const session = yield* provider.startSession(asThreadId("thread-runtime-resume-refresh"), {
        provider: "claudeAgent",
        threadId: asThreadId("thread-runtime-resume-refresh"),
        runtimeMode: "full-access",
      });
      const updatedResumeCursor = {
        threadId: session.threadId,
        resume: "550e8400-e29b-41d4-a716-446655440000",
        resumeSessionAt: "assistant-message-refresh",
        turnCount: 2,
        rerouteOriginalApiModelId: "claude-fable-5",
        rerouteFallbackApiModelId: "claude-opus-4-8",
      };

      routing.claude.updateSession(session.threadId, (existing) => ({
        ...existing,
        resumeCursor: updatedResumeCursor,
      }));
      routing.claude.emit({
        type: "model.rerouted",
        eventId: asEventId("runtime-model-rerouted-refresh"),
        provider: "claudeAgent",
        createdAt: "2026-02-27T00:04:00.000Z",
        threadId: session.threadId,
        payload: {
          fromModel: "claude-fable-5",
          toModel: "claude-opus-4-8",
          reason: "Model safeguards rerouted this request.",
        },
      });
      yield* sleep(50);

      const runtime = yield* runtimeRepository.getByThreadId({
        threadId: session.threadId,
      });
      assert.equal(Option.isSome(runtime), true);
      if (Option.isSome(runtime)) {
        assert.deepEqual(runtime.value.resumeCursor, updatedResumeCursor);
      }
    }),
  );

  it.effect("marks persisted runtime bindings errored on runtime errors", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const runtimeRepository = yield* ProviderSessionRuntimeRepository;

      const session = yield* provider.startSession(asThreadId("thread-runtime-error"), {
        provider: "codex",
        threadId: asThreadId("thread-runtime-error"),
        runtimeMode: "full-access",
      });
      const turn = yield* provider.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      routing.codex.emit({
        type: "runtime.error",
        eventId: asEventId("runtime-error-event"),
        provider: "codex",
        createdAt: "2026-02-27T00:05:00.000Z",
        threadId: session.threadId,
        turnId: turn.turnId,
        payload: { message: "Provider crashed", class: "provider_error" },
      });
      yield* sleep(50);

      const runtime = yield* runtimeRepository.getByThreadId({
        threadId: session.threadId,
      });
      assert.equal(Option.isSome(runtime), true);
      if (Option.isSome(runtime)) {
        assert.equal(runtime.value.status, "error");
        const payload = runtime.value.runtimePayload;
        assert.equal(payload !== null && typeof payload === "object", true);
        if (payload !== null && typeof payload === "object" && !Array.isArray(payload)) {
          const runtimePayload = payload as {
            activeTurnId: string | null;
            lastError: string | null;
            lastRuntimeEvent: string | null;
          };
          assert.equal(runtimePayload.activeTurnId, null);
          assert.equal(runtimePayload.lastError, "Provider crashed");
          assert.equal(runtimePayload.lastRuntimeEvent, "runtime.error");
        }
      }
    }),
  );

  it.effect("marks terminal thread state changes stopped or errored", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const runtimeRepository = yield* ProviderSessionRuntimeRepository;

      const session = yield* provider.startSession(asThreadId("thread-runtime-state-error"), {
        provider: "codex",
        threadId: asThreadId("thread-runtime-state-error"),
        runtimeMode: "full-access",
      });

      routing.codex.emit({
        type: "thread.state.changed",
        eventId: asEventId("runtime-thread-state-error"),
        provider: "codex",
        createdAt: "2026-02-27T00:05:00.000Z",
        threadId: session.threadId,
        payload: { state: "error" },
      });
      yield* sleep(50);

      const runtime = yield* runtimeRepository.getByThreadId({
        threadId: session.threadId,
      });
      assert.equal(Option.isSome(runtime), true);
      if (Option.isSome(runtime)) {
        assert.equal(runtime.value.status, "error");
        const payload = runtime.value.runtimePayload;
        assert.equal(payload !== null && typeof payload === "object", true);
        if (payload !== null && typeof payload === "object" && !Array.isArray(payload)) {
          assert.equal((payload as Record<string, unknown>).activeTurnId, null);
          assert.equal(
            (payload as Record<string, unknown>).lastRuntimeEvent,
            "thread.state.changed",
          );
        }
      }
    }),
  );

  it.effect("preserves active turns across compacted thread state boundaries", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const runtimeRepository = yield* ProviderSessionRuntimeRepository;

      const session = yield* provider.startSession(asThreadId("thread-runtime-compact-boundary"), {
        provider: "codex",
        threadId: asThreadId("thread-runtime-compact-boundary"),
        runtimeMode: "full-access",
      });
      const turn = yield* provider.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      routing.codex.emit({
        type: "thread.state.changed",
        eventId: asEventId("runtime-thread-compact-boundary"),
        provider: "codex",
        createdAt: "2026-02-27T00:05:00.000Z",
        threadId: session.threadId,
        payload: { state: "compacted" },
      });
      yield* sleep(50);

      const runtime = yield* runtimeRepository.getByThreadId({
        threadId: session.threadId,
      });
      assert.equal(Option.isSome(runtime), true);
      if (Option.isSome(runtime)) {
        assert.equal(runtime.value.status, "running");
        const payload = runtime.value.runtimePayload;
        assert.equal(payload !== null && typeof payload === "object", true);
        if (payload !== null && typeof payload === "object" && !Array.isArray(payload)) {
          assert.equal((payload as Record<string, unknown>).activeTurnId, turn.turnId);
          assert.equal(
            (payload as Record<string, unknown>).lastRuntimeEvent,
            "thread.state.changed",
          );
        }
      }
    }),
  );

  it.effect("reuses persisted resume cursor when startSession is called after a restart", () =>
    Effect.gen(function* () {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-provider-service-start-"));
      const dbPath = path.join(tempDir, "orchestration.sqlite");
      const persistenceLayer = makeSqlitePersistenceLive(dbPath);
      const runtimeRepositoryLayer = ProviderSessionRuntimeRepositoryLive.pipe(
        Layer.provide(persistenceLayer),
      );

      const firstClaude = makeFakeCodexAdapter("claudeAgent");
      const firstRegistry: typeof ProviderAdapterRegistry.Service = {
        getByProvider: (provider) =>
          provider === "claudeAgent"
            ? Effect.succeed(firstClaude.adapter)
            : Effect.fail(new ProviderUnsupportedError({ provider })),
        listProviders: () => Effect.succeed(["claudeAgent"]),
      };
      const firstDirectoryLayer = ProviderSessionDirectoryLive.pipe(
        Layer.provide(runtimeRepositoryLayer),
      );
      const firstProviderLayer = makeProviderServiceLive().pipe(
        Layer.provide(Layer.succeed(ProviderAdapterRegistry, firstRegistry)),
        Layer.provide(firstDirectoryLayer),
        Layer.provide(AnalyticsService.layerTest),
      );

      const initial = yield* Effect.gen(function* () {
        const provider = yield* ProviderService;
        return yield* provider.startSession(asThreadId("thread-claude-start"), {
          provider: "claudeAgent",
          threadId: asThreadId("thread-claude-start"),
          cwd: "/tmp/project-claude-start",
          runtimeMode: "full-access",
        });
      }).pipe(Effect.provide(firstProviderLayer));

      yield* Effect.gen(function* () {
        const provider = yield* ProviderService;
        yield* provider.listSessions();
      }).pipe(Effect.provide(firstProviderLayer));

      const secondClaude = makeFakeCodexAdapter("claudeAgent");
      const secondRegistry: typeof ProviderAdapterRegistry.Service = {
        getByProvider: (provider) =>
          provider === "claudeAgent"
            ? Effect.succeed(secondClaude.adapter)
            : Effect.fail(new ProviderUnsupportedError({ provider })),
        listProviders: () => Effect.succeed(["claudeAgent"]),
      };
      const secondDirectoryLayer = ProviderSessionDirectoryLive.pipe(
        Layer.provide(runtimeRepositoryLayer),
      );
      const secondProviderLayer = makeProviderServiceLive().pipe(
        Layer.provide(Layer.succeed(ProviderAdapterRegistry, secondRegistry)),
        Layer.provide(secondDirectoryLayer),
        Layer.provide(AnalyticsService.layerTest),
      );

      secondClaude.startSession.mockClear();

      yield* Effect.gen(function* () {
        const provider = yield* ProviderService;
        yield* provider.startSession(initial.threadId, {
          provider: "claudeAgent",
          threadId: initial.threadId,
          cwd: "/tmp/project-claude-start",
          runtimeMode: "full-access",
        });
      }).pipe(Effect.provide(secondProviderLayer));

      assert.equal(secondClaude.startSession.mock.calls.length, 1);
      const resumedStartInput = secondClaude.startSession.mock.calls[0]?.[0];
      assert.equal(typeof resumedStartInput === "object" && resumedStartInput !== null, true);
      if (resumedStartInput && typeof resumedStartInput === "object") {
        const startPayload = resumedStartInput as {
          provider?: string;
          cwd?: string;
          resumeCursor?: unknown;
          threadId?: string;
        };
        assert.equal(startPayload.provider, "claudeAgent");
        assert.equal(startPayload.cwd, "/tmp/project-claude-start");
        assert.deepEqual(startPayload.resumeCursor, initial.resumeCursor);
        assert.equal(startPayload.threadId, initial.threadId);
      }

      fs.rmSync(tempDir, { recursive: true, force: true });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("clears stale resume cursor while preserving provider options for fresh restart", () =>
    Effect.gen(function* () {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-provider-service-clear-"));
      const dbPath = path.join(tempDir, "orchestration.sqlite");
      const persistenceLayer = makeSqlitePersistenceLive(dbPath);
      const runtimeRepositoryLayer = ProviderSessionRuntimeRepositoryLive.pipe(
        Layer.provide(persistenceLayer),
      );
      const providerOptions = {
        codex: {
          homePath: "/tmp/custom-codex-home",
          binaryPath: "/usr/local/bin/codex",
        },
      };

      const firstCodex = makeFakeCodexAdapter("codex");
      const firstRegistry: typeof ProviderAdapterRegistry.Service = {
        getByProvider: (provider) =>
          provider === "codex"
            ? Effect.succeed(firstCodex.adapter)
            : Effect.fail(new ProviderUnsupportedError({ provider })),
        listProviders: () => Effect.succeed(["codex"]),
      };
      const firstDirectoryLayer = ProviderSessionDirectoryLive.pipe(
        Layer.provide(runtimeRepositoryLayer),
      );
      const firstProviderLayer = makeProviderServiceLive().pipe(
        Layer.provide(Layer.succeed(ProviderAdapterRegistry, firstRegistry)),
        Layer.provide(firstDirectoryLayer),
        Layer.provide(AnalyticsService.layerTest),
      );

      const initial = yield* Effect.gen(function* () {
        const provider = yield* ProviderService;
        const session = yield* provider.startSession(asThreadId("thread-clear-resume"), {
          provider: "codex",
          threadId: asThreadId("thread-clear-resume"),
          cwd: "/tmp/project-clear-resume",
          providerOptions,
          runtimeMode: "full-access",
        });
        assert.equal(typeof provider.clearSessionResumeCursor, "function");
        if (provider.clearSessionResumeCursor) {
          yield* provider.clearSessionResumeCursor({ threadId: session.threadId });
        }
        return session;
      }).pipe(Effect.provide(firstProviderLayer));

      const secondCodex = makeFakeCodexAdapter("codex");
      const secondRegistry: typeof ProviderAdapterRegistry.Service = {
        getByProvider: (provider) =>
          provider === "codex"
            ? Effect.succeed(secondCodex.adapter)
            : Effect.fail(new ProviderUnsupportedError({ provider })),
        listProviders: () => Effect.succeed(["codex"]),
      };
      const secondDirectoryLayer = ProviderSessionDirectoryLive.pipe(
        Layer.provide(runtimeRepositoryLayer),
      );
      const secondProviderLayer = makeProviderServiceLive().pipe(
        Layer.provide(Layer.succeed(ProviderAdapterRegistry, secondRegistry)),
        Layer.provide(secondDirectoryLayer),
        Layer.provide(AnalyticsService.layerTest),
      );

      yield* Effect.gen(function* () {
        const provider = yield* ProviderService;
        yield* provider.startSession(initial.threadId, {
          provider: "codex",
          threadId: initial.threadId,
          cwd: "/tmp/project-clear-resume",
          runtimeMode: "full-access",
        });
      }).pipe(Effect.provide(secondProviderLayer));

      assert.equal(secondCodex.startSession.mock.calls.length, 1);
      const restartedInput = secondCodex.startSession.mock.calls[0]?.[0];
      assert.equal(typeof restartedInput === "object" && restartedInput !== null, true);
      if (restartedInput && typeof restartedInput === "object") {
        const startPayload = restartedInput as {
          providerOptions?: unknown;
          resumeCursor?: unknown;
        };
        assert.deepEqual(startPayload.providerOptions, providerOptions);
        assert.equal(startPayload.resumeCursor, null);
      }

      fs.rmSync(tempDir, { recursive: true, force: true });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("stops the live runtime while preserving resume cursor and provider options", () =>
    Effect.gen(function* () {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-provider-service-stop-runtime-"));
      const dbPath = path.join(tempDir, "orchestration.sqlite");
      const persistenceLayer = makeSqlitePersistenceLive(dbPath);
      const runtimeRepositoryLayer = ProviderSessionRuntimeRepositoryLive.pipe(
        Layer.provide(persistenceLayer),
      );
      const providerOptions = {
        claudeAgent: {
          binaryPath: "/usr/local/bin/claude",
          permissionMode: "acceptEdits",
        },
      };

      const firstClaude = makeFakeCodexAdapter("claudeAgent");
      const firstRegistry: typeof ProviderAdapterRegistry.Service = {
        getByProvider: (provider) =>
          provider === "claudeAgent"
            ? Effect.succeed(firstClaude.adapter)
            : Effect.fail(new ProviderUnsupportedError({ provider })),
        listProviders: () => Effect.succeed(["claudeAgent"]),
      };
      const firstDirectoryLayer = ProviderSessionDirectoryLive.pipe(
        Layer.provide(runtimeRepositoryLayer),
      );
      const firstProviderLayer = makeProviderServiceLive().pipe(
        Layer.provide(Layer.succeed(ProviderAdapterRegistry, firstRegistry)),
        Layer.provide(firstDirectoryLayer),
        Layer.provide(AnalyticsService.layerTest),
      );

      const initial = yield* Effect.gen(function* () {
        const provider = yield* ProviderService;
        const session = yield* provider.startSession(asThreadId("thread-stop-runtime"), {
          provider: "claudeAgent",
          threadId: asThreadId("thread-stop-runtime"),
          cwd: "/tmp/project-stop-runtime",
          providerOptions,
          runtimeMode: "full-access",
        });
        assert.equal(typeof provider.stopRuntimeSession, "function");
        if (provider.stopRuntimeSession) {
          yield* provider.stopRuntimeSession({ threadId: session.threadId });
        }
        return session;
      }).pipe(Effect.provide(firstProviderLayer));

      assert.equal(firstClaude.stopSession.mock.calls.length, 1);

      const secondClaude = makeFakeCodexAdapter("claudeAgent");
      const secondRegistry: typeof ProviderAdapterRegistry.Service = {
        getByProvider: (provider) =>
          provider === "claudeAgent"
            ? Effect.succeed(secondClaude.adapter)
            : Effect.fail(new ProviderUnsupportedError({ provider })),
        listProviders: () => Effect.succeed(["claudeAgent"]),
      };
      const secondDirectoryLayer = ProviderSessionDirectoryLive.pipe(
        Layer.provide(runtimeRepositoryLayer),
      );
      const secondProviderLayer = makeProviderServiceLive().pipe(
        Layer.provide(Layer.succeed(ProviderAdapterRegistry, secondRegistry)),
        Layer.provide(secondDirectoryLayer),
        Layer.provide(AnalyticsService.layerTest),
      );

      yield* Effect.gen(function* () {
        const provider = yield* ProviderService;
        yield* provider.startSession(initial.threadId, {
          provider: "claudeAgent",
          threadId: initial.threadId,
          cwd: "/tmp/project-stop-runtime",
          runtimeMode: "full-access",
        });
      }).pipe(Effect.provide(secondProviderLayer));

      assert.equal(secondClaude.startSession.mock.calls.length, 1);
      const restartedInput = secondClaude.startSession.mock.calls[0]?.[0];
      assert.equal(typeof restartedInput === "object" && restartedInput !== null, true);
      if (restartedInput && typeof restartedInput === "object") {
        const startPayload = restartedInput as {
          providerOptions?: unknown;
          resumeCursor?: unknown;
        };
        assert.deepEqual(startPayload.providerOptions, providerOptions);
        assert.deepEqual(startPayload.resumeCursor, initial.resumeCursor);
      }

      fs.rmSync(tempDir, { recursive: true, force: true });
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

const idleCleanup = makeProviderServiceLayer({ runtimeIdleStopMs: 100 });
idleCleanup.layer("ProviderServiceLive idle cleanup", (it) => {
  it.effect(
    "stops idle ready runtime using the persisted cursor when the live snapshot omits it",
    () =>
      Effect.gen(function* () {
        const provider = yield* ProviderService;
        const runtimeRepository = yield* ProviderSessionRuntimeRepository;

        const session = yield* provider.startSession(asThreadId("thread-idle-persisted-cursor"), {
          provider: "codex",
          threadId: asThreadId("thread-idle-persisted-cursor"),
          runtimeMode: "full-access",
        });

        const persistedBefore = yield* runtimeRepository.getByThreadId({
          threadId: session.threadId,
        });
        assert.equal(Option.isSome(persistedBefore), true);
        if (Option.isSome(persistedBefore)) {
          assert.deepEqual(persistedBefore.value.resumeCursor, session.resumeCursor);
        }

        idleCleanup.codex.updateSession(session.threadId, (existing) => {
          const { resumeCursor: _omittedResumeCursor, ...withoutResumeCursor } = existing;
          return withoutResumeCursor;
        });
        yield* idleCleanup.codex.waitForRuntimeSubscribers();
        idleCleanup.codex.emit({
          type: "turn.completed",
          eventId: asEventId("runtime-idle-persisted-cursor-complete"),
          provider: "codex",
          createdAt: "2026-02-27T00:04:00.000Z",
          threadId: session.threadId,
          payload: { state: "completed" },
        });

        yield* waitUntil(
          () => idleCleanup.codex.stopSession.mock.calls.length > 0,
          500,
          20,
          "idle runtime stop",
        );

        assert.equal(idleCleanup.codex.stopSession.mock.calls.length, 1);
        assert.deepEqual(idleCleanup.codex.stopSession.mock.calls[0]?.[0], session.threadId);

        const persistedAfter = yield* runtimeRepository.getByThreadId({
          threadId: session.threadId,
        });
        assert.equal(Option.isSome(persistedAfter), true);
        if (Option.isSome(persistedAfter)) {
          assert.equal(persistedAfter.value.status, "stopped");
          assert.deepEqual(persistedAfter.value.resumeCursor, session.resumeCursor);
        }
      }),
  );

  it.effect("clears a pending idle stop before dispatching new turn work", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const runtimeRepository = yield* ProviderSessionRuntimeRepository;
      const threadId = asThreadId("thread-idle-new-turn");

      idleCleanup.codex.stopSession.mockClear();
      const session = yield* provider.startSession(threadId, {
        provider: "codex",
        threadId,
        runtimeMode: "full-access",
      });
      idleCleanup.codex.updateSession(threadId, (existing) => {
        const { resumeCursor: _omittedResumeCursor, ...withoutResumeCursor } = existing;
        return withoutResumeCursor;
      });
      yield* idleCleanup.codex.waitForRuntimeSubscribers();
      idleCleanup.codex.emit({
        type: "turn.completed",
        eventId: asEventId("runtime-idle-before-new-turn"),
        provider: "codex",
        createdAt: "2026-02-27T00:04:00.000Z",
        threadId,
        payload: { state: "completed" },
      });

      yield* waitUntilEffect(
        () =>
          runtimeRepository.getByThreadId({ threadId }).pipe(
            Effect.map((runtime) => {
              if (Option.isNone(runtime)) {
                return false;
              }
              const payload = runtime.value.runtimePayload;
              return (
                payload !== null &&
                typeof payload === "object" &&
                !Array.isArray(payload) &&
                (payload as Record<string, unknown>).lastRuntimeEvent === "turn.completed"
              );
            }),
          ),
        500,
        20,
        "runtime completion persistence",
      );

      yield* provider.sendTurn({
        threadId: session.threadId,
        input: "new turn before idle stop",
        attachments: [],
      });
      yield* sleep(150);

      assert.equal(idleCleanup.codex.stopSession.mock.calls.length, 0);
    }),
  );

  it.effect("clears a pending idle stop when a runtime turn starts", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const runtimeRepository = yield* ProviderSessionRuntimeRepository;
      const threadId = asThreadId("thread-idle-runtime-turn-start");

      idleCleanup.codex.stopSession.mockClear();
      const session = yield* provider.startSession(threadId, {
        provider: "codex",
        threadId,
        runtimeMode: "full-access",
      });
      idleCleanup.codex.updateSession(threadId, (existing) => {
        const { resumeCursor: _omittedResumeCursor, ...withoutResumeCursor } = existing;
        return withoutResumeCursor;
      });
      yield* idleCleanup.codex.waitForRuntimeSubscribers();
      idleCleanup.codex.emit({
        type: "turn.completed",
        eventId: asEventId("runtime-idle-before-runtime-turn-start"),
        provider: "codex",
        createdAt: "2026-02-27T00:04:00.000Z",
        threadId,
        payload: { state: "completed" },
      });

      yield* waitUntilEffect(
        () =>
          runtimeRepository.getByThreadId({ threadId }).pipe(
            Effect.map((runtime) => {
              if (Option.isNone(runtime)) {
                return false;
              }
              const payload = runtime.value.runtimePayload;
              return (
                payload !== null &&
                typeof payload === "object" &&
                !Array.isArray(payload) &&
                (payload as Record<string, unknown>).lastRuntimeEvent === "turn.completed"
              );
            }),
          ),
        500,
        20,
        "runtime completion persistence",
      );

      idleCleanup.codex.emit({
        type: "turn.started",
        eventId: asEventId("runtime-turn-start-clears-idle"),
        provider: "codex",
        createdAt: "2026-02-27T00:04:01.000Z",
        threadId: session.threadId,
        turnId: asTurnId("turn-runtime-clears-idle"),
        payload: { state: "running" },
      });
      yield* sleep(150);

      assert.equal(idleCleanup.codex.stopSession.mock.calls.length, 0);
    }),
  );

  it.effect("serializes a fired idle stop before starting new turn work", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const runtimeRepository = yield* ProviderSessionRuntimeRepository;
      const threadId = asThreadId("thread-idle-fired-new-turn");
      let listSessionsStarted = false;
      let releaseListSessions: ReleaseListSessions | undefined;

      idleCleanup.codex.stopSession.mockClear();
      const session = yield* provider.startSession(threadId, {
        provider: "codex",
        threadId,
        runtimeMode: "full-access",
      });
      const { resumeCursor: _omittedResumeCursor, ...staleReadySession } = session;

      idleCleanup.codex.listSessions
        .mockImplementationOnce(() => Effect.succeed([session]))
        .mockImplementationOnce(() =>
          Effect.promise(
            () =>
              new Promise<ReadonlyArray<ProviderSession>>((resolve) => {
                listSessionsStarted = true;
                releaseListSessions = resolve;
              }),
          ),
        );

      yield* idleCleanup.codex.waitForRuntimeSubscribers();
      idleCleanup.codex.emit({
        type: "turn.completed",
        eventId: asEventId("runtime-idle-fired-before-new-turn"),
        provider: "codex",
        createdAt: "2026-02-27T00:04:00.000Z",
        threadId,
        payload: { state: "completed" },
      });

      yield* waitUntilEffect(
        () =>
          runtimeRepository.getByThreadId({ threadId }).pipe(
            Effect.map((runtime) => {
              if (Option.isNone(runtime)) {
                return false;
              }
              const payload = runtime.value.runtimePayload;
              return (
                payload !== null &&
                typeof payload === "object" &&
                !Array.isArray(payload) &&
                (payload as Record<string, unknown>).lastRuntimeEvent === "turn.completed"
              );
            }),
          ),
        500,
        20,
        "runtime completion persistence",
      );
      yield* waitUntil(() => listSessionsStarted, 500, 20, "idle listSessions start");

      const sendTurnFiber = yield* provider
        .sendTurn({
          threadId,
          input: "new turn after idle timeout fired",
          attachments: [],
        })
        .pipe(Effect.forkChild);

      const release = releaseListSessions;
      requireReleaseListSessions(release)([staleReadySession]);
      yield* Fiber.join(sendTurnFiber);
      yield* sleep(100);

      assert.equal(idleCleanup.codex.stopSession.mock.calls.length, 1);
      const persistedAfter = yield* runtimeRepository.getByThreadId({ threadId });
      assert.equal(Option.isSome(persistedAfter), true);
      if (Option.isSome(persistedAfter)) {
        assert.equal(persistedAfter.value.status, "running");
        const payload = persistedAfter.value.runtimePayload;
        assert.equal(
          payload !== null &&
            typeof payload === "object" &&
            !Array.isArray(payload) &&
            (payload as Record<string, unknown>).activeTurnId === `turn-${String(threadId)}`,
          true,
        );
      }
    }),
  );

  it.effect("restores idle cleanup when new turn dispatch is interrupted", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const runtimeRepository = yield* ProviderSessionRuntimeRepository;
      const threadId = asThreadId("thread-idle-interrupted-dispatch");

      idleCleanup.codex.stopSession.mockClear();
      const session = yield* provider.startSession(threadId, {
        provider: "codex",
        threadId,
        runtimeMode: "full-access",
      });
      idleCleanup.codex.updateSession(threadId, (existing) => {
        const { resumeCursor: _omittedResumeCursor, ...withoutResumeCursor } = existing;
        return withoutResumeCursor;
      });
      yield* idleCleanup.codex.waitForRuntimeSubscribers();
      idleCleanup.codex.emit({
        type: "turn.completed",
        eventId: asEventId("runtime-idle-before-interrupted-dispatch"),
        provider: "codex",
        createdAt: "2026-02-27T00:04:00.000Z",
        threadId,
        payload: { state: "completed" },
      });

      yield* waitUntilEffect(
        () =>
          runtimeRepository.getByThreadId({ threadId }).pipe(
            Effect.map((runtime) => {
              if (Option.isNone(runtime)) {
                return false;
              }
              const payload = runtime.value.runtimePayload;
              return (
                payload !== null &&
                typeof payload === "object" &&
                !Array.isArray(payload) &&
                (payload as Record<string, unknown>).lastRuntimeEvent === "turn.completed"
              );
            }),
          ),
        500,
        20,
        "runtime completion persistence",
      );

      idleCleanup.codex.sendTurn.mockImplementationOnce(() => Effect.interrupt);
      yield* Effect.exit(
        provider.sendTurn({
          threadId: session.threadId,
          input: "new turn interrupted before runtime events",
          attachments: [],
        }),
      );

      yield* waitUntil(
        () => idleCleanup.codex.stopSession.mock.calls.length > 0,
        500,
        20,
        "idle runtime stop after interrupted dispatch",
      );
      assert.deepEqual(idleCleanup.codex.stopSession.mock.calls[0]?.[0], threadId);
    }),
  );

  it.effect("reschedules idle cleanup after successful rollback work", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const runtimeRepository = yield* ProviderSessionRuntimeRepository;
      const threadId = asThreadId("thread-idle-rollback-success");

      yield* provider.startSession(threadId, {
        provider: "codex",
        threadId,
        runtimeMode: "full-access",
      });
      idleCleanup.codex.updateSession(threadId, (existing) => {
        const { resumeCursor: _omittedResumeCursor, ...withoutResumeCursor } = existing;
        return withoutResumeCursor;
      });
      yield* idleCleanup.codex.waitForRuntimeSubscribers();
      idleCleanup.codex.emit({
        type: "turn.completed",
        eventId: asEventId("runtime-idle-before-rollback"),
        provider: "codex",
        createdAt: "2026-02-27T00:04:00.000Z",
        threadId,
        payload: { state: "completed" },
      });

      yield* waitUntilEffect(
        () =>
          runtimeRepository.getByThreadId({ threadId }).pipe(
            Effect.map((runtime) => {
              if (Option.isNone(runtime)) {
                return false;
              }
              const payload = runtime.value.runtimePayload;
              return (
                payload !== null &&
                typeof payload === "object" &&
                !Array.isArray(payload) &&
                (payload as Record<string, unknown>).lastRuntimeEvent === "turn.completed"
              );
            }),
          ),
        500,
        20,
        "runtime completion persistence",
      );

      idleCleanup.codex.stopSession.mockClear();
      yield* provider.rollbackConversation({
        threadId,
        numTurns: 1,
      });

      yield* waitUntil(
        () => idleCleanup.codex.stopSession.mock.calls.length > 0,
        500,
        20,
        "idle runtime stop after successful rollback",
      );
      assert.deepEqual(idleCleanup.codex.stopSession.mock.calls[0]?.[0], threadId);
    }),
  );

  it.effect("waits for fired idle cleanup before removing an explicit stop binding", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const directory = yield* ProviderSessionDirectory;
      const runtimeRepository = yield* ProviderSessionRuntimeRepository;
      const threadId = asThreadId("thread-idle-stop-remove-race");
      let listSessionsStarted = false;
      let releaseListSessions: ReleaseListSessions | undefined;

      const session = yield* provider.startSession(threadId, {
        provider: "codex",
        threadId,
        runtimeMode: "full-access",
      });
      const { resumeCursor: _omittedResumeCursor, ...staleReadySession } = session;
      idleCleanup.codex.listSessions
        .mockImplementationOnce(() => Effect.succeed([session]))
        .mockImplementationOnce(() =>
          Effect.promise(
            () =>
              new Promise<ReadonlyArray<ProviderSession>>((resolve) => {
                listSessionsStarted = true;
                releaseListSessions = resolve;
              }),
          ),
        );

      yield* idleCleanup.codex.waitForRuntimeSubscribers();
      idleCleanup.codex.emit({
        type: "turn.completed",
        eventId: asEventId("runtime-idle-before-explicit-stop"),
        provider: "codex",
        createdAt: "2026-02-27T00:04:00.000Z",
        threadId,
        payload: { state: "completed" },
      });
      yield* waitUntilEffect(
        () =>
          runtimeRepository.getByThreadId({ threadId }).pipe(
            Effect.map((runtime) => {
              if (Option.isNone(runtime)) {
                return false;
              }
              const payload = runtime.value.runtimePayload;
              return (
                payload !== null &&
                typeof payload === "object" &&
                !Array.isArray(payload) &&
                (payload as Record<string, unknown>).lastRuntimeEvent === "turn.completed"
              );
            }),
          ),
        500,
        20,
        "runtime completion persistence",
      );
      yield* waitUntil(() => listSessionsStarted, 500, 20, "idle listSessions start");

      const stopFiber = yield* provider.stopSession({ threadId }).pipe(Effect.forkChild);
      const release = releaseListSessions;
      requireReleaseListSessions(release)([staleReadySession]);
      yield* Fiber.join(stopFiber);

      const binding = yield* directory.getBinding(threadId);
      assert.equal(Option.isNone(binding), true);
    }),
  );

  it.effect("waits for fired idle cleanup before explicit runtime stop", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const runtimeRepository = yield* ProviderSessionRuntimeRepository;
      const threadId = asThreadId("thread-idle-runtime-stop-race");
      let listSessionsStarted = false;
      let releaseListSessions: ReleaseListSessions | undefined;

      const session = yield* provider.startSession(threadId, {
        provider: "codex",
        threadId,
        runtimeMode: "full-access",
      });
      const { resumeCursor: _omittedResumeCursor, ...staleReadySession } = session;
      idleCleanup.codex.stopSession.mockClear();
      idleCleanup.codex.listSessions
        .mockImplementationOnce(() => Effect.succeed([session]))
        .mockImplementationOnce(() =>
          Effect.promise(
            () =>
              new Promise<ReadonlyArray<ProviderSession>>((resolve) => {
                listSessionsStarted = true;
                releaseListSessions = resolve;
              }),
          ),
        );

      yield* idleCleanup.codex.waitForRuntimeSubscribers();
      idleCleanup.codex.emit({
        type: "turn.completed",
        eventId: asEventId("runtime-idle-before-runtime-stop"),
        provider: "codex",
        createdAt: "2026-02-27T00:04:00.000Z",
        threadId,
        payload: { state: "completed" },
      });
      yield* waitUntilEffect(
        () =>
          runtimeRepository.getByThreadId({ threadId }).pipe(
            Effect.map((runtime) => {
              if (Option.isNone(runtime)) {
                return false;
              }
              const payload = runtime.value.runtimePayload;
              return (
                payload !== null &&
                typeof payload === "object" &&
                !Array.isArray(payload) &&
                (payload as Record<string, unknown>).lastRuntimeEvent === "turn.completed"
              );
            }),
          ),
        500,
        20,
        "runtime completion persistence",
      );
      yield* waitUntil(() => listSessionsStarted, 500, 20, "idle listSessions start");

      assert.equal(typeof provider.stopRuntimeSession, "function");
      if (!provider.stopRuntimeSession) {
        assert.fail("stopRuntimeSession unavailable");
      }
      const stopFiber = yield* provider.stopRuntimeSession({ threadId }).pipe(Effect.forkChild);
      const release = releaseListSessions;
      requireReleaseListSessions(release)([staleReadySession]);
      yield* Fiber.join(stopFiber);

      assert.equal(idleCleanup.codex.stopSession.mock.calls.length, 1);
      assert.deepEqual(idleCleanup.codex.stopSession.mock.calls[0]?.[0], threadId);
    }),
  );

  it.effect("reschedules idle cleanup after successful compact work", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const runtimeRepository = yield* ProviderSessionRuntimeRepository;
      const threadId = asThreadId("thread-idle-compact-success");

      yield* provider.startSession(threadId, {
        provider: "codex",
        threadId,
        runtimeMode: "full-access",
      });
      idleCleanup.codex.updateSession(threadId, (existing) => {
        const { resumeCursor: _omittedResumeCursor, ...withoutResumeCursor } = existing;
        return withoutResumeCursor;
      });
      yield* idleCleanup.codex.waitForRuntimeSubscribers();
      idleCleanup.codex.emit({
        type: "turn.completed",
        eventId: asEventId("runtime-idle-before-compact-success"),
        provider: "codex",
        createdAt: "2026-02-27T00:04:00.000Z",
        threadId,
        payload: { state: "completed" },
      });

      yield* waitUntilEffect(
        () =>
          runtimeRepository.getByThreadId({ threadId }).pipe(
            Effect.map((runtime) => {
              if (Option.isNone(runtime)) {
                return false;
              }
              const payload = runtime.value.runtimePayload;
              return (
                payload !== null &&
                typeof payload === "object" &&
                !Array.isArray(payload) &&
                (payload as Record<string, unknown>).lastRuntimeEvent === "turn.completed"
              );
            }),
          ),
        500,
        20,
        "runtime completion persistence",
      );

      idleCleanup.codex.stopSession.mockClear();
      idleCleanup.codex.compactThread.mockImplementationOnce((inputThreadId) =>
        Effect.sync(() => {
          idleCleanup.codex.updateSession(inputThreadId, (existing) => ({
            ...existing,
            status: "running",
            activeTurnId: undefined,
          }));
        }),
      );
      yield* provider.compactThread({ threadId });

      yield* waitUntil(
        () => idleCleanup.codex.stopSession.mock.calls.length > 0,
        500,
        20,
        "idle runtime stop after successful compact",
      );
      assert.deepEqual(idleCleanup.codex.stopSession.mock.calls[0]?.[0], threadId);
    }),
  );

  it.effect("schedules idle cleanup for closed thread state changes", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const threadId = asThreadId("thread-idle-closed-state");

      yield* provider.startSession(threadId, {
        provider: "codex",
        threadId,
        runtimeMode: "full-access",
      });
      idleCleanup.codex.stopSession.mockClear();
      yield* idleCleanup.codex.waitForRuntimeSubscribers();
      idleCleanup.codex.emit({
        type: "thread.state.changed",
        eventId: asEventId("runtime-idle-closed-state"),
        provider: "codex",
        createdAt: "2026-02-27T00:04:00.000Z",
        threadId,
        payload: { state: "closed" },
      });

      yield* waitUntil(
        () => idleCleanup.codex.stopSession.mock.calls.length > 0,
        500,
        20,
        "idle runtime stop after closed thread state",
      );
      assert.deepEqual(idleCleanup.codex.stopSession.mock.calls[0]?.[0], threadId);
    }),
  );

  it.effect("stops a compacted runtime that remains running without an active turn", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const threadId = asThreadId("thread-idle-compact-running");

      yield* provider.startSession(threadId, {
        provider: "codex",
        threadId,
        runtimeMode: "full-access",
      });
      idleCleanup.codex.stopSession.mockClear();
      idleCleanup.codex.updateSession(threadId, (existing) => ({
        ...existing,
        status: "running",
        activeTurnId: undefined,
      }));
      yield* idleCleanup.codex.waitForRuntimeSubscribers();
      idleCleanup.codex.emit({
        type: "thread.state.changed",
        eventId: asEventId("runtime-idle-compact-completed"),
        provider: "codex",
        createdAt: "2026-02-27T00:04:00.000Z",
        threadId,
        payload: { state: "compacted" },
      });

      yield* waitUntil(
        () => idleCleanup.codex.stopSession.mock.calls.length > 0,
        500,
        20,
        "idle runtime stop after compact",
      );
      assert.deepEqual(idleCleanup.codex.stopSession.mock.calls[0]?.[0], threadId);
    }),
  );

  it.effect("restores idle cleanup when new turn dispatch fails before runtime events", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const runtimeRepository = yield* ProviderSessionRuntimeRepository;
      const threadId = asThreadId("thread-idle-failed-dispatch");
      const dispatchFailure = new ProviderAdapterSessionNotFoundError({
        provider: "codex",
        threadId,
      });

      idleCleanup.codex.stopSession.mockClear();
      const session = yield* provider.startSession(threadId, {
        provider: "codex",
        threadId,
        runtimeMode: "full-access",
      });
      idleCleanup.codex.updateSession(threadId, (existing) => {
        const { resumeCursor: _omittedResumeCursor, ...withoutResumeCursor } = existing;
        return withoutResumeCursor;
      });
      yield* idleCleanup.codex.waitForRuntimeSubscribers();
      idleCleanup.codex.emit({
        type: "turn.completed",
        eventId: asEventId("runtime-idle-before-failed-dispatch"),
        provider: "codex",
        createdAt: "2026-02-27T00:04:00.000Z",
        threadId,
        payload: { state: "completed" },
      });

      yield* waitUntilEffect(
        () =>
          runtimeRepository.getByThreadId({ threadId }).pipe(
            Effect.map((runtime) => {
              if (Option.isNone(runtime)) {
                return false;
              }
              const payload = runtime.value.runtimePayload;
              return (
                payload !== null &&
                typeof payload === "object" &&
                !Array.isArray(payload) &&
                (payload as Record<string, unknown>).lastRuntimeEvent === "turn.completed"
              );
            }),
          ),
        500,
        20,
        "runtime completion persistence",
      );

      idleCleanup.codex.sendTurn.mockImplementationOnce(() => Effect.fail(dispatchFailure));
      const failedTurn = yield* Effect.result(
        provider.sendTurn({
          threadId: session.threadId,
          input: "new turn that fails before runtime events",
          attachments: [],
        }),
      );
      assertFailure(failedTurn, dispatchFailure);

      yield* waitUntil(
        () => idleCleanup.codex.stopSession.mock.calls.length > 0,
        500,
        20,
        "idle runtime stop after failed dispatch",
      );
      assert.deepEqual(idleCleanup.codex.stopSession.mock.calls[0]?.[0], threadId);
    }),
  );
});

const fanout = makeProviderServiceLayer();
fanout.layer("ProviderServiceLive fanout", (it) => {
  it.effect("fans out adapter turn completion events", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const session = yield* provider.startSession(asThreadId("thread-1"), {
        provider: "codex",
        threadId: asThreadId("thread-1"),
        runtimeMode: "full-access",
      });

      const eventsRef = yield* Ref.make<Array<ProviderRuntimeEvent>>([]);
      const consumer = yield* Stream.runForEach(provider.streamEvents, (event) =>
        Ref.update(eventsRef, (current) => [...current, event]),
      ).pipe(Effect.forkChild);
      yield* sleep(50);

      const completedEvent: LegacyProviderRuntimeEvent = {
        type: "turn.completed",
        eventId: asEventId("evt-1"),
        provider: "codex",
        createdAt: new Date().toISOString(),
        threadId: session.threadId,
        turnId: asTurnId("turn-1"),
        status: "completed",
      };

      fanout.codex.emit(completedEvent);
      yield* sleep(50);

      const events = yield* Ref.get(eventsRef);
      yield* Fiber.interrupt(consumer);

      assert.equal(
        events.some((entry) => entry.type === "turn.completed"),
        true,
      );
    }),
  );

  it.effect("fans out canonical runtime events in emission order", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const session = yield* provider.startSession(asThreadId("thread-seq"), {
        provider: "codex",
        threadId: asThreadId("thread-seq"),
        runtimeMode: "full-access",
      });

      const receivedRef = yield* Ref.make<Array<ProviderRuntimeEvent>>([]);
      const consumer = yield* Stream.take(provider.streamEvents, 3).pipe(
        Stream.runForEach((event) => Ref.update(receivedRef, (current) => [...current, event])),
        Effect.forkChild,
      );
      yield* sleep(50);

      fanout.codex.emit({
        type: "tool.started",
        eventId: asEventId("evt-seq-1"),
        provider: "codex",
        createdAt: new Date().toISOString(),
        threadId: session.threadId,
        turnId: asTurnId("turn-1"),
        toolKind: "command",
        title: "Ran command",
      });
      fanout.codex.emit({
        type: "tool.completed",
        eventId: asEventId("evt-seq-2"),
        provider: "codex",
        createdAt: new Date().toISOString(),
        threadId: session.threadId,
        turnId: asTurnId("turn-1"),
        toolKind: "command",
        title: "Ran command",
      });
      fanout.codex.emit({
        type: "turn.completed",
        eventId: asEventId("evt-seq-3"),
        provider: "codex",
        createdAt: new Date().toISOString(),
        threadId: session.threadId,
        turnId: asTurnId("turn-1"),
        status: "completed",
      });

      yield* Fiber.join(consumer);
      const received = yield* Ref.get(receivedRef);
      assert.deepEqual(
        received.map((event) => event.eventId),
        [asEventId("evt-seq-1"), asEventId("evt-seq-2"), asEventId("evt-seq-3")],
      );
    }),
  );

  it.effect("keeps subscriber delivery ordered and isolates failing subscribers", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const session = yield* provider.startSession(asThreadId("thread-1"), {
        provider: "codex",
        threadId: asThreadId("thread-1"),
        runtimeMode: "full-access",
      });

      const receivedByHealthy: string[] = [];
      const expectedEventIds = new Set<string>(["evt-ordered-1", "evt-ordered-2", "evt-ordered-3"]);
      const healthyFiber = yield* Stream.take(provider.streamEvents, 3).pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            receivedByHealthy.push(event.eventId);
          }),
        ),
        Effect.forkChild,
      );
      const failingFiber = yield* Stream.take(provider.streamEvents, 1).pipe(
        Stream.runForEach(() => Effect.fail("listener crash")),
        Effect.forkChild,
      );
      yield* sleep(50);

      const events: ReadonlyArray<LegacyProviderRuntimeEvent> = [
        {
          type: "tool.completed",
          eventId: asEventId("evt-ordered-1"),
          provider: "codex",
          createdAt: new Date().toISOString(),
          threadId: session.threadId,
          turnId: asTurnId("turn-1"),
          toolKind: "command",
          title: "Ran command",
          detail: "echo one",
        },
        {
          type: "message.delta",
          eventId: asEventId("evt-ordered-2"),
          provider: "codex",
          createdAt: new Date().toISOString(),
          threadId: session.threadId,
          turnId: asTurnId("turn-1"),
          delta: "hello",
        },
        {
          type: "turn.completed",
          eventId: asEventId("evt-ordered-3"),
          provider: "codex",
          createdAt: new Date().toISOString(),
          threadId: session.threadId,
          turnId: asTurnId("turn-1"),
          status: "completed",
        },
      ];

      for (const event of events) {
        fanout.codex.emit(event);
      }
      const failingResult = yield* Effect.result(Fiber.join(failingFiber));
      assert.equal(failingResult._tag, "Failure");
      yield* Fiber.join(healthyFiber);

      assert.deepEqual(
        receivedByHealthy.filter((eventId) => expectedEventIds.has(eventId)).slice(0, 3),
        ["evt-ordered-1", "evt-ordered-2", "evt-ordered-3"],
      );
    }),
  );

  it.effect("clears persisted active turn when provider session reports ready", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const directory = yield* ProviderSessionDirectory;
      const threadId = asThreadId("thread-ready");
      yield* provider.startSession(threadId, {
        provider: "codex",
        threadId,
        runtimeMode: "full-access",
      });
      yield* provider.sendTurn({ threadId, input: "hello" });
      yield* sleep(50);

      fanout.codex.emit({
        type: "session.state.changed",
        eventId: asEventId("evt-ready"),
        provider: "codex",
        createdAt: new Date().toISOString(),
        threadId,
        payload: {
          state: "ready",
        },
      });
      yield* sleep(50);

      const binding = Option.getOrUndefined(yield* directory.getBinding(threadId));
      const runtimePayload =
        binding?.runtimePayload && typeof binding.runtimePayload === "object"
          ? (binding.runtimePayload as Record<string, unknown>)
          : {};
      assert.equal(runtimePayload.activeTurnId, null);
    }),
  );
});

const validation = makeProviderServiceLayer();
validation.layer("ProviderServiceLive validation", (it) => {
  it.effect("returns ProviderValidationError for invalid input payloads", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;

      const failure = yield* Effect.result(
        provider.startSession(asThreadId("thread-validation"), {
          threadId: asThreadId("thread-validation"),
          provider: "invalid-provider",
          runtimeMode: "full-access",
        } as never),
      );

      assert.equal(failure._tag, "Failure");
      if (failure._tag !== "Failure") {
        return;
      }
      assert.equal(failure.failure._tag, "ProviderValidationError");
      if (failure.failure._tag !== "ProviderValidationError") {
        return;
      }
      assert.equal(failure.failure.operation, "ProviderService.startSession");
      assert.equal(failure.failure.issue.includes("invalid-provider"), true);
    }),
  );

  it.effect("accepts startSession when adapter has not emitted provider thread id yet", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const runtimeRepository = yield* ProviderSessionRuntimeRepository;

      validation.codex.startSession.mockImplementationOnce((input: ProviderSessionStartInput) =>
        Effect.sync(() => {
          const now = new Date().toISOString();
          return {
            provider: "codex",
            status: "ready",
            threadId: input.threadId,
            runtimeMode: input.runtimeMode,
            cwd: input.cwd ?? process.cwd(),
            createdAt: now,
            updatedAt: now,
          } satisfies ProviderSession;
        }),
      );

      const session = yield* provider.startSession(asThreadId("thread-missing"), {
        provider: "codex",
        threadId: asThreadId("thread-missing"),
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });

      assert.equal(session.threadId, asThreadId("thread-missing"));

      const runtime = yield* runtimeRepository.getByThreadId({
        threadId: session.threadId,
      });
      assert.equal(Option.isSome(runtime), true);
      if (Option.isSome(runtime)) {
        assert.equal(runtime.value.threadId, session.threadId);
      }
    }),
  );
});

const liveFallback = makeProviderServiceLayer();
liveFallback.layer("ProviderServiceLive live-fallback settled turns", (it) => {
  it.effect("persists the first binding row as stopped when the turn settles pre-write", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const directory = yield* ProviderSessionDirectory;
      const threadId = asThreadId("thread-live-fallback-settled");
      const turnId = asTurnId("turn-live-fallback-settled");

      // The adapter owns a live session but startSession has not persisted a
      // binding row yet (the startup window resolveRoutableSession allows).
      liveFallback.codex.hasSession.mockImplementation((candidate: ThreadId) =>
        Effect.succeed(candidate === threadId),
      );
      liveFallback.codex.sendTurn.mockImplementationOnce((input: ProviderSendTurnInput) =>
        Effect.gen(function* () {
          // The terminal runtime event is fully processed before sendTurn
          // returns, so the post-dispatch write takes the settled-turn branch.
          liveFallback.codex.emit({
            type: "turn.completed",
            eventId: asEventId("evt-live-fallback-settled"),
            provider: "codex",
            createdAt: new Date().toISOString(),
            threadId: input.threadId,
            turnId,
            payload: { state: "cancelled" },
          });
          yield* sleep(100);
          return { threadId: input.threadId, turnId };
        }),
      );
      yield* liveFallback.codex.waitForRuntimeSubscribers();

      yield* provider.sendTurn({ threadId, input: "hello" });

      const binding = Option.getOrUndefined(yield* directory.getBinding(threadId));
      assert.equal(binding?.status, "stopped");
    }),
  );
});
