import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

import type {
  ProviderApprovalDecision,
  ProviderRuntimeEvent,
  ProviderSendTurnInput,
  ProviderSession,
  ProviderTurnStartResult,
} from "@synara/contracts";
import {
  ApprovalRequestId,
  EventId,
  type ServerSettings,
  type ProviderKind,
  type ProviderInstanceId,
  ProviderSessionStartInput,
  ThreadId,
  TurnId,
} from "@synara/contracts";
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
import type {
  ProviderAdapterForkThreadInput,
  ProviderAdapterSessionStartInput,
  ProviderAdapterShape,
} from "../Services/ProviderAdapter.ts";
import { ProviderAdapterRegistry } from "../Services/ProviderAdapterRegistry.ts";
import { ProviderService } from "../Services/ProviderService.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";
import { makeProviderServiceLive } from "./ProviderService.ts";
import { ProviderSessionDirectoryLive } from "./ProviderSessionDirectory.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ServerSecretStore } from "../../auth/Services/ServerSecretStore.ts";
import { ProviderSessionRuntimeRepositoryLive } from "../../persistence/Layers/ProviderSessionRuntime.ts";
import { ProviderSessionRuntimeRepository } from "../../persistence/Services/ProviderSessionRuntime.ts";
import {
  makeSqlitePersistenceLive,
  SqlitePersistenceMemory,
} from "../../persistence/Layers/Sqlite.ts";
import { AnalyticsService } from "../../telemetry/Services/AnalyticsService.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import {
  buildCodexProcessEnv,
  buildCodexProcessLaunchContext,
  isCodexSharedContinuationStatePrepared,
  readCodexSharedContinuationGeneration,
} from "../../codexProcessEnv.ts";
import { resolveActiveCodexHomeWritePath } from "../../codexHomePaths.ts";

const asRequestId = (value: string): ApprovalRequestId => ApprovalRequestId.makeUnsafe(value);
const asEventId = (value: string): EventId => EventId.makeUnsafe(value);
const asProviderInstanceId = (value: string): ProviderInstanceId => value as ProviderInstanceId;
const asThreadId = (value: string): ThreadId => ThreadId.makeUnsafe(value);
const asTurnId = (value: string): TurnId => TurnId.makeUnsafe(value);

function makeSharedCodexContinuationFixture(
  accountIds: readonly string[],
  preparedAccountIds: readonly string[] = accountIds,
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "synara-provider-continuation-"));
  const homePath = path.join(root, "codex-home");
  const runtimeHomePath = path.join(root, "synara-runtime");
  const environment = { SYNARA_HOME: runtimeHomePath };
  fs.mkdirSync(homePath, { recursive: true });
  fs.writeFileSync(path.join(homePath, "config.toml"), "", "utf8");
  const shadowHomePaths = new Map<string, string>();
  const preparedAccounts = new Set(preparedAccountIds);
  for (const accountId of accountIds) {
    const shadowHomePath = path.join(root, `codex-shadow-${accountId}`);
    fs.mkdirSync(shadowHomePath, { recursive: true });
    fs.writeFileSync(path.join(shadowHomePath, "auth.json"), JSON.stringify({ accountId }), "utf8");
    shadowHomePaths.set(accountId, shadowHomePath);
    if (preparedAccounts.has(accountId)) {
      buildCodexProcessEnv({
        env: { ...process.env, ...environment },
        homePath,
        shadowHomePath,
        accountId,
      });
    }
  }
  return {
    root,
    homePath,
    environment,
    instanceEnvironment: Object.entries(environment).map(([name, value]) => ({
      name,
      value,
      sensitive: false,
    })),
    shadowHomePath: (accountId: string) => shadowHomePaths.get(accountId)!,
  };
}

const providerServiceSecretBytes = new Map<string, Uint8Array>();
const ProviderServiceTestSecretStoreLayer = Layer.succeed(ServerSecretStore, {
  get: (name) => Effect.succeed(providerServiceSecretBytes.get(name) ?? null),
  set: (name, value) =>
    Effect.sync(() => {
      providerServiceSecretBytes.set(name, Uint8Array.from(value));
    }),
  getOrCreateRandom: (name, bytes) =>
    Effect.sync(() => {
      const existing = providerServiceSecretBytes.get(name);
      if (existing) return existing;
      const generated = Uint8Array.from({ length: bytes }, (_, index) => (index * 17 + 23) % 256);
      providerServiceSecretBytes.set(name, generated);
      return generated;
    }),
  remove: (name) =>
    Effect.sync(() => {
      providerServiceSecretBytes.delete(name);
    }),
});

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
  let beforeStartSession: ((input: ProviderAdapterSessionStartInput) => void) | undefined;

  const startSession = vi.fn((input: ProviderAdapterSessionStartInput) =>
    Effect.sync(() => {
      beforeStartSession?.(input);
      const now = new Date().toISOString();
      const session: ProviderSession = {
        provider,
        status: "ready",
        runtimeMode: input.runtimeMode,
        threadId: input.threadId,
        ...(input.providerInstanceId ? { providerInstanceId: input.providerInstanceId } : {}),
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

  const forkThread = vi.fn((input: ProviderAdapterForkThreadInput) =>
    Effect.succeed({
      threadId: input.threadId,
      resumeCursor: { opaque: `fork-${String(input.threadId)}` },
    }),
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
    forkThread,
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
    setBeforeStartSession: (
      hook: ((input: ProviderAdapterSessionStartInput) => void) | undefined,
    ) => {
      beforeStartSession = hook;
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
    forkThread,
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

function makeProviderServiceLayer(
  options?: Parameters<typeof makeProviderServiceLive>[0],
  settings?: Partial<ServerSettings>,
) {
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
  const serverSettingsLayer = ServerSettingsService.layerTest(settings);

  const layer = it.layer(
    Layer.mergeAll(
      makeProviderServiceLive(options).pipe(
        Layer.provide(providerAdapterLayer),
        Layer.provide(directoryLayer),
        Layer.provideMerge(AnalyticsService.layerTest),
        Layer.provide(serverSettingsLayer),
        Layer.provide(ProviderServiceTestSecretStoreLayer),
      ),
      serverSettingsLayer,
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
const disabledRouting = makeProviderServiceLayer(undefined, {
  providerInstances: {
    claude_disabled: {
      driver: "claudeAgent",
      enabled: false,
      config: {
        homePath: "/tmp/claude-disabled",
      },
    },
  },
});

routing.layer("ProviderServiceLive native forks", (it) => {
  it.effect("forks across Codex account instances sharing continuation storage", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const serverSettings = yield* ServerSettingsService;
      const directory = yield* ProviderSessionDirectory;
      const sourceThreadId = asThreadId("thread-fork-source-personal");
      const targetThreadId = asThreadId("thread-fork-target-work");
      const fixture = makeSharedCodexContinuationFixture(["personal", "work"], ["personal"]);
      const sharedHomePath = fixture.homePath;

      yield* serverSettings.updateSettings({
        providerInstances: {
          codex_personal: {
            driver: "codex",
            environment: fixture.instanceEnvironment,
            config: {
              homePath: sharedHomePath,
              shadowHomePath: fixture.shadowHomePath("personal"),
              accountId: "personal",
            },
          },
          codex_work: {
            driver: "codex",
            environment: fixture.instanceEnvironment,
            config: {
              homePath: sharedHomePath,
              shadowHomePath: fixture.shadowHomePath("work"),
              accountId: "work",
            },
          },
        },
      });

      const source = yield* provider.startSession(sourceThreadId, {
        provider: "codex",
        providerInstanceId: "codex_personal",
        threadId: sourceThreadId,
        runtimeMode: "full-access",
      });
      assert.equal(
        isCodexSharedContinuationStatePrepared({
          env: { ...process.env, ...fixture.environment },
          homePath: sharedHomePath,
          shadowHomePath: fixture.shadowHomePath("work"),
          accountId: "work",
        }),
        false,
      );
      routing.codex.forkThread.mockClear();

      assert.equal(typeof provider.forkThread, "function");
      if (!provider.forkThread) {
        return;
      }

      const result = yield* provider.forkThread({
        sourceThreadId,
        threadId: targetThreadId,
        modelSelection: {
          instanceId: "codex_work",
          model: "gpt-5.4",
        },
        runtimeMode: "full-access",
      });

      assert.notEqual(result, null);
      assert.equal(
        isCodexSharedContinuationStatePrepared({
          env: { ...process.env, ...fixture.environment },
          homePath: sharedHomePath,
          shadowHomePath: fixture.shadowHomePath("work"),
          accountId: "work",
        }),
        true,
      );
      assert.equal(routing.codex.forkThread.mock.calls.length, 1);
      const forkInput = routing.codex.forkThread.mock.calls[0]?.[0];
      assert.deepEqual(forkInput?.sourceResumeCursor, source.resumeCursor);
      assert.equal(
        forkInput?.expectedCodexContinuationGeneration,
        readCodexSharedContinuationGeneration({
          env: { ...process.env, ...fixture.environment },
          homePath: sharedHomePath,
          shadowHomePath: fixture.shadowHomePath("work"),
          accountId: "work",
        }),
      );
      assert.equal(forkInput?.modelSelection?.instanceId, "codex_work");
      assert.deepEqual(forkInput?.providerOptions, {
        codex: {
          homePath: sharedHomePath,
          shadowHomePath: fixture.shadowHomePath("work"),
          accountId: "work",
          environment: fixture.environment,
        },
      });
      const targetBinding = Option.getOrUndefined(yield* directory.getBinding(targetThreadId));
      assert.ok(targetBinding);
      assert.match(
        String(
          targetBinding.runtimePayload && typeof targetBinding.runtimePayload === "object"
            ? (targetBinding.runtimePayload as Record<string, unknown>).continuationIdentity
            : "",
        ),
        /^codex:shared-v2:[0-9a-f-]{36}:/,
      );
      assert.equal(
        targetBinding.runtimePayload && typeof targetBinding.runtimePayload === "object"
          ? (targetBinding.runtimePayload as Record<string, unknown>).continuationResetRequested
          : undefined,
        undefined,
      );
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }),
  );

  it.effect("does not recreate damaged shared source state before a native fork", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const serverSettings = yield* ServerSettingsService;
      const sourceThreadId = asThreadId("thread-fork-damaged-source");
      const targetThreadId = asThreadId("thread-fork-damaged-source-target");
      const fixture = makeSharedCodexContinuationFixture(["personal", "work"], ["personal"]);
      yield* serverSettings.updateSettings({
        providerInstances: {
          codex_personal: {
            driver: "codex",
            environment: fixture.instanceEnvironment,
            config: {
              homePath: fixture.homePath,
              shadowHomePath: fixture.shadowHomePath("personal"),
              accountId: "personal",
            },
          },
          codex_work: {
            driver: "codex",
            environment: fixture.instanceEnvironment,
            config: {
              homePath: fixture.homePath,
              shadowHomePath: fixture.shadowHomePath("work"),
              accountId: "work",
            },
          },
        },
      });
      yield* provider.startSession(sourceThreadId, {
        provider: "codex",
        providerInstanceId: "codex_personal",
        threadId: sourceThreadId,
        runtimeMode: "full-access",
      });
      const workOverlayHomePath = resolveActiveCodexHomeWritePath({
        env: { ...process.env, ...fixture.environment },
        homePath: fixture.homePath,
        shadowHomePath: fixture.shadowHomePath("work"),
        accountId: "work",
      });
      assert.equal(fs.existsSync(workOverlayHomePath), false);
      const sourceSessionsPath = path.join(fixture.homePath, "sessions");
      fs.rmSync(sourceSessionsPath, { recursive: true, force: true });
      routing.codex.forkThread.mockClear();

      assert.equal(typeof provider.forkThread, "function");
      if (!provider.forkThread) return;
      const result = yield* Effect.result(
        provider.forkThread({
          sourceThreadId,
          threadId: targetThreadId,
          modelSelection: { instanceId: "codex_work", model: "gpt-5.4" },
          runtimeMode: "full-access",
        }),
      );

      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.match(String(result.failure), /missing (?:or damaged|'sessions')/);
      }
      assert.equal(routing.codex.forkThread.mock.calls.length, 0);
      assert.equal(fs.existsSync(sourceSessionsPath), false);
      assert.equal(fs.existsSync(workOverlayHomePath), false);
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }),
  );

  it.effect("falls back without invoking native fork across incompatible Codex homes", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const serverSettings = yield* ServerSettingsService;
      const sourceThreadId = asThreadId("thread-fork-source-home-a");
      const targetThreadId = asThreadId("thread-fork-target-home-b");

      yield* serverSettings.updateSettings({
        providerInstances: {
          codex_personal: {
            driver: "codex",
            config: {
              homePath: "/tmp/codex-fork-home-a",
              shadowHomePath: "/tmp/codex-fork-home-a-auth",
              accountId: "personal",
            },
          },
          codex_work: {
            driver: "codex",
            config: {
              homePath: "/tmp/codex-fork-home-b",
              shadowHomePath: "/tmp/codex-fork-home-b-auth",
              accountId: "work",
            },
          },
        },
      });

      yield* provider.startSession(sourceThreadId, {
        provider: "codex",
        providerInstanceId: "codex_personal",
        threadId: sourceThreadId,
        runtimeMode: "full-access",
      });
      routing.codex.forkThread.mockClear();

      assert.equal(typeof provider.forkThread, "function");
      if (!provider.forkThread) {
        return;
      }

      const result = yield* provider.forkThread({
        sourceThreadId,
        threadId: targetThreadId,
        modelSelection: {
          instanceId: "codex_work",
          model: "gpt-5.4",
        },
        runtimeMode: "full-access",
      });

      assert.equal(result, null);
      assert.equal(routing.codex.forkThread.mock.calls.length, 0);
    }),
  );
});

it.effect("ProviderServiceLive keeps persisted resumable sessions on startup", () =>
  Effect.gen(function* () {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "synara-provider-service-"));
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
        providerInstanceId: "codex",
        threadId: ThreadId.makeUnsafe("thread-stale"),
      });
    }).pipe(Effect.provide(directoryLayer));

    const providerLayer = makeProviderServiceLive().pipe(
      Layer.provide(Layer.succeed(ProviderAdapterRegistry, registry)),
      Layer.provide(directoryLayer),
      Layer.provide(AnalyticsService.layerTest),
      Layer.provide(ServerSettingsService.layerTest()),
      Layer.provide(ProviderServiceTestSecretStoreLayer),
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
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "synara-provider-service-stopall-"));
      const dbPath = path.join(tempDir, "orchestration.sqlite");
      const persistenceLayer = makeSqlitePersistenceLive(dbPath);
      const runtimeRepositoryLayer = ProviderSessionRuntimeRepositoryLive.pipe(
        Layer.provide(persistenceLayer),
      );

      const codex = makeFakeCodexAdapter();
      const threadId = asThreadId("thread-stopall");
      const providerInstanceId = asProviderInstanceId("codex_work");
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
        Layer.provide(
          ServerSettingsService.layerTest({
            providerInstances: {
              codex_work: {
                driver: "codex",
                config: {
                  homePath: "/tmp/codex-work",
                },
              },
            },
          }),
        ),
        Layer.provide(ProviderServiceTestSecretStoreLayer),
      );

      yield* Effect.gen(function* () {
        const provider = yield* ProviderService;
        yield* provider.startSession(threadId, {
          provider: "codex",
          providerInstanceId,
          cwd: "/tmp/project",
          runtimeMode: "full-access",
          threadId,
        });
        codex.updateSession(threadId, (existing) => {
          const { providerInstanceId: _providerInstanceId, ...sessionWithoutInstance } = existing;
          return {
            ...sessionWithoutInstance,
            status: "running",
            activeTurnId: asTurnId("turn-stopall"),
            resumeCursor,
          };
        });
      }).pipe(Effect.provide(providerLayer));

      const persisted = yield* Effect.gen(function* () {
        const repository = yield* ProviderSessionRuntimeRepository;
        return yield* repository.getByThreadId({ threadId });
      }).pipe(Effect.provide(runtimeRepositoryLayer));

      assert.equal(Option.isSome(persisted), true);
      if (Option.isSome(persisted)) {
        const runtimePayload = persisted.value.runtimePayload as Record<string, unknown>;
        assert.equal(persisted.value.status, "stopped");
        assert.equal(persisted.value.providerInstanceId, providerInstanceId);
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
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "synara-provider-service-restart-"));
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
        Layer.provide(ServerSettingsService.layerTest()),
        Layer.provide(ProviderServiceTestSecretStoreLayer),
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
        Layer.provide(ServerSettingsService.layerTest()),
        Layer.provide(ProviderServiceTestSecretStoreLayer),
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

disabledRouting.layer("ProviderServiceLive disabled provider instances", (it) => {
  it.effect("rejects disabled provider instances before adapter launch", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      disabledRouting.claude.startSession.mockClear();

      const result = yield* Effect.result(
        provider.startSession(asThreadId("thread-disabled"), {
          provider: "claudeAgent",
          providerInstanceId: "claude_disabled",
          threadId: asThreadId("thread-disabled"),
          runtimeMode: "full-access",
        }),
      );

      assertFailure(
        result,
        new ProviderValidationError({
          operation: "ProviderService.startSession",
          issue: "Provider instance 'claude_disabled' is disabled.",
        }),
      );
      assert.equal(disabledRouting.claude.startSession.mock.calls.length, 0);
    }),
  );
});

const deletedRouting = makeProviderServiceLayer();

deletedRouting.layer("ProviderServiceLive deleted provider instances", (it) => {
  it.effect("stops sessions whose provider instance was deleted from settings", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const serverSettings = yield* ServerSettingsService;
      const directory = yield* ProviderSessionDirectory;
      const threadId = asThreadId("thread-deleted-instance");

      yield* serverSettings.updateSettings({
        providerInstances: {
          codex_work: {
            driver: "codex",
            displayName: "Codex Work",
          },
        },
      });

      yield* provider.startSession(threadId, {
        provider: "codex",
        providerInstanceId: "codex_work",
        threadId,
        runtimeMode: "full-access",
      });

      yield* serverSettings.updateSettings({ providerInstances: {} });
      deletedRouting.codex.stopSession.mockClear();

      yield* provider.stopSession({ threadId });

      assert.equal(deletedRouting.codex.stopSession.mock.calls.length, 1);
      assert.deepEqual(deletedRouting.codex.stopSession.mock.calls[0]?.[0], threadId);
      const binding = yield* directory.getBinding(threadId);
      assert.equal(Option.isNone(binding), true);
    }),
  );

  it.effect("stops sessions after their provider instance is disabled", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const serverSettings = yield* ServerSettingsService;
      const directory = yield* ProviderSessionDirectory;
      const threadId = asThreadId("thread-disabled-instance-cleanup");

      yield* serverSettings.updateSettings({
        providerInstances: {
          codex_cleanup: {
            driver: "codex",
            enabled: true,
          },
        },
      });
      yield* provider.startSession(threadId, {
        provider: "codex",
        providerInstanceId: "codex_cleanup",
        threadId,
        runtimeMode: "full-access",
      });
      yield* serverSettings.updateSettings({
        providerInstances: {
          codex_cleanup: {
            driver: "codex",
            enabled: false,
          },
        },
      });
      deletedRouting.codex.stopSession.mockClear();

      yield* provider.stopSession({ threadId });

      assert.equal(deletedRouting.codex.stopSession.mock.calls.length, 1);
      assert.equal(Option.isNone(yield* directory.getBinding(threadId)), true);
    }),
  );

  it.effect("removes stopped bindings even when no live adapter session remains", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const directory = yield* ProviderSessionDirectory;
      const threadId = asThreadId("thread-stopped-binding-cleanup");

      yield* directory.upsert({
        threadId,
        provider: "codex",
        providerInstanceId: "codex",
        runtimeMode: "full-access",
        status: "stopped",
      });
      deletedRouting.codex.stopSession.mockClear();

      yield* provider.stopSession({ threadId });

      assert.equal(deletedRouting.codex.stopSession.mock.calls.length, 0);
      assert.equal(Option.isNone(yield* directory.getBinding(threadId)), true);
    }),
  );
});

it.effect(
  "ProviderServiceLive stops runtime sessions through the bound provider when instance ids are reused",
  () =>
    Effect.gen(function* () {
      const codex = makeFakeCodexAdapter("codex");
      const claude = makeFakeCodexAdapter("claudeAgent");
      const threadId = asThreadId("thread-bound-provider-cleanup");
      const providerInstanceId = asProviderInstanceId("work");
      const runtimeRepositoryLayer = ProviderSessionRuntimeRepositoryLive.pipe(
        Layer.provide(SqlitePersistenceMemory),
      );
      const directoryLayer = ProviderSessionDirectoryLive.pipe(
        Layer.provide(runtimeRepositoryLayer),
      );
      const registry: typeof ProviderAdapterRegistry.Service = {
        getByInstance: (instanceId) =>
          instanceId === providerInstanceId
            ? Effect.succeed(claude.adapter)
            : Effect.fail(new ProviderUnsupportedError({ provider: String(instanceId) })),
        getByProvider: (provider) =>
          provider === "codex"
            ? Effect.succeed(codex.adapter)
            : provider === "claudeAgent"
              ? Effect.succeed(claude.adapter)
              : Effect.fail(new ProviderUnsupportedError({ provider })),
        listProviders: () => Effect.succeed(["codex", "claudeAgent"]),
      };

      const providerLayer = makeProviderServiceLive().pipe(
        Layer.provide(Layer.succeed(ProviderAdapterRegistry, registry)),
        Layer.provide(directoryLayer),
        Layer.provide(AnalyticsService.layerTest),
        Layer.provide(
          ServerSettingsService.layerTest({
            providerInstances: {
              work: {
                driver: "claudeAgent",
                enabled: true,
              },
            },
          }),
        ),
        Layer.provide(ProviderServiceTestSecretStoreLayer),
      );

      yield* Effect.gen(function* () {
        const provider = yield* ProviderService;
        const directory = yield* ProviderSessionDirectory;
        yield* codex.adapter.startSession({
          provider: "codex",
          providerInstanceId,
          threadId,
          cwd: "/tmp/project-bound-provider-cleanup",
          runtimeMode: "full-access",
        });
        yield* directory.upsert({
          threadId,
          provider: "codex",
          providerInstanceId,
          runtimeMode: "full-access",
          status: "running",
        });
        assert.equal(typeof provider.stopRuntimeSession, "function");
        if (provider.stopRuntimeSession) {
          yield* provider.stopRuntimeSession({ threadId });
        }
      }).pipe(Effect.provide(Layer.mergeAll(providerLayer, directoryLayer)));

      assert.equal(codex.stopSession.mock.calls.length, 1);
      assert.equal(claude.stopSession.mock.calls.length, 0);
    }),
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

  it.effect("rejects provider and provider-instance driver mismatches", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      routing.codex.startSession.mockClear();
      routing.claude.startSession.mockClear();

      const result = yield* Effect.result(
        provider.startSession(asThreadId("thread-mismatch"), {
          provider: "codex",
          providerInstanceId: "claudeAgent",
          threadId: asThreadId("thread-mismatch"),
          runtimeMode: "full-access",
        }),
      );

      assertFailure(
        result,
        new ProviderValidationError({
          operation: "ProviderService.startSession",
          issue: "Unknown provider instance 'claudeAgent'.",
        }),
      );
      assert.equal(routing.codex.startSession.mock.calls.length, 0);
      assert.equal(routing.claude.startSession.mock.calls.length, 0);
    }),
  );

  it.effect("rejects a provider switch that would discard native continuation", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const serverSettings = yield* ServerSettingsService;
      const threadId = asThreadId("thread-cross-provider-default-instance");

      yield* serverSettings.updateSettings({
        providerInstances: {
          claude_work: {
            driver: "claudeAgent",
            enabled: true,
          },
        },
      });
      yield* provider.startSession(threadId, {
        provider: "claudeAgent",
        providerInstanceId: "claude_work",
        threadId,
        runtimeMode: "full-access",
      });
      routing.codex.startSession.mockClear();

      const result = yield* Effect.result(
        provider.startSession(threadId, {
          provider: "codex",
          threadId,
          runtimeMode: "full-access",
        }),
      );

      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.match(String(result.failure), /native session storage is incompatible/);
      }
      assert.equal(routing.codex.startSession.mock.calls.length, 0);
    }),
  );

  it.effect("prepares a newly selected Codex account before reusing shared continuation", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const threadId = asThreadId("thread-codex-shared-continuation-home");
      const fixture = makeSharedCodexContinuationFixture(["personal", "work"], ["personal"]);
      const initial = yield* provider.startSession(threadId, {
        provider: "codex",
        threadId,
        providerOptions: {
          codex: {
            homePath: fixture.homePath,
            shadowHomePath: fixture.shadowHomePath("personal"),
            accountId: "personal",
            environment: fixture.environment,
          },
        },
        runtimeMode: "full-access",
      });
      routing.codex.startSession.mockClear();
      routing.codex.stopSession.mockClear();
      assert.equal(
        isCodexSharedContinuationStatePrepared({
          env: { ...process.env, ...fixture.environment },
          homePath: fixture.homePath,
          shadowHomePath: fixture.shadowHomePath("work"),
          accountId: "work",
        }),
        false,
      );

      yield* provider.startSession(threadId, {
        provider: "codex",
        threadId,
        providerOptions: {
          codex: {
            homePath: fixture.homePath,
            shadowHomePath: fixture.shadowHomePath("work"),
            accountId: "work",
            environment: fixture.environment,
          },
        },
        runtimeMode: "full-access",
      });

      assert.equal(routing.codex.stopSession.mock.calls.length, 0);
      assert.equal(routing.codex.startSession.mock.calls.length, 1);
      assert.equal(
        isCodexSharedContinuationStatePrepared({
          env: { ...process.env, ...fixture.environment },
          homePath: fixture.homePath,
          shadowHomePath: fixture.shadowHomePath("work"),
          accountId: "work",
        }),
        true,
      );
      assert.deepEqual(
        routing.codex.startSession.mock.calls[0]?.[0].resumeCursor,
        initial.resumeCursor,
      );
      assert.equal(
        routing.codex.startSession.mock.calls[0]?.[0].expectedCodexContinuationGeneration,
        readCodexSharedContinuationGeneration({
          env: { ...process.env, ...fixture.environment },
          homePath: fixture.homePath,
          shadowHomePath: fixture.shadowHomePath("work"),
          accountId: "work",
        }),
      );
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }),
  );

  it.effect("pins an imported explicit Codex resume through the adapter launch seam", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const threadId = asThreadId("thread-codex-import-explicit-resume");
      const fixture = makeSharedCodexContinuationFixture(["personal"], ["personal"]);
      const providerOptions = {
        codex: {
          homePath: fixture.homePath,
          shadowHomePath: fixture.shadowHomePath("personal"),
          accountId: "personal",
          environment: fixture.environment,
        },
      };
      const overlayHomePath = resolveActiveCodexHomeWritePath({
        env: { ...process.env, ...fixture.environment },
        ...providerOptions.codex,
      });
      const generationBeforePreflight = readCodexSharedContinuationGeneration({
        env: { ...process.env, ...fixture.environment },
        ...providerOptions.codex,
      });
      let launchError: unknown;
      routing.codex.startSession.mockClear();
      routing.codex.setBeforeStartSession((input) => {
        fs.rmSync(fixture.homePath, { recursive: true, force: true });
        fs.rmSync(overlayHomePath, { recursive: true, force: true });
        try {
          buildCodexProcessLaunchContext({
            env: { ...process.env, ...fixture.environment },
            homePath: fixture.homePath,
            shadowHomePath: fixture.shadowHomePath("personal"),
            accountId: "personal",
            ...(input.expectedCodexContinuationGeneration
              ? {
                  expectedSharedContinuationGeneration: input.expectedCodexContinuationGeneration,
                }
              : {}),
          });
        } catch (error) {
          launchError = error;
        }
      });

      try {
        yield* provider.startSession(threadId, {
          provider: "codex",
          threadId,
          providerOptions,
          resumeCursor: { threadId: "imported-provider-thread" },
          runtimeMode: "full-access",
        });

        const launchInput = routing.codex.startSession.mock.calls[0]?.[0];
        assert.equal(launchInput?.expectedCodexContinuationGeneration, generationBeforePreflight);
        assert.match(String(launchError), /missing or damaged|refusing to recreate/);
        assert.equal(fs.existsSync(fixture.homePath), false);
        assert.equal(fs.existsSync(overlayHomePath), false);
      } finally {
        routing.codex.setBeforeStartSession(undefined);
        fs.rmSync(fixture.root, { recursive: true, force: true });
      }
    }),
  );

  it.effect("does not recreate damaged shared source state during a direct account switch", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const threadId = asThreadId("thread-codex-switch-damaged-source");
      const fixture = makeSharedCodexContinuationFixture(["personal", "work"], ["personal"]);
      const options = (accountId: "personal" | "work") => ({
        codex: {
          homePath: fixture.homePath,
          shadowHomePath: fixture.shadowHomePath(accountId),
          accountId,
          environment: fixture.environment,
        },
      });
      yield* provider.startSession(threadId, {
        provider: "codex",
        threadId,
        providerOptions: options("personal"),
        runtimeMode: "full-access",
      });
      const workOverlayHomePath = resolveActiveCodexHomeWritePath({
        env: { ...process.env, ...fixture.environment },
        homePath: fixture.homePath,
        shadowHomePath: fixture.shadowHomePath("work"),
        accountId: "work",
      });
      assert.equal(fs.existsSync(workOverlayHomePath), false);
      const sourceSessionsPath = path.join(fixture.homePath, "sessions");
      fs.rmSync(sourceSessionsPath, { recursive: true, force: true });
      routing.codex.startSession.mockClear();
      routing.codex.stopSession.mockClear();

      const result = yield* Effect.result(
        provider.startSession(threadId, {
          provider: "codex",
          threadId,
          providerOptions: options("work"),
          runtimeMode: "full-access",
        }),
      );

      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.match(String(result.failure), /missing (?:or damaged|'sessions')/);
      }
      assert.equal(routing.codex.startSession.mock.calls.length, 0);
      assert.equal(routing.codex.stopSession.mock.calls.length, 0);
      assert.equal(fs.existsSync(sourceSessionsPath), false);
      assert.equal(fs.existsSync(workOverlayHomePath), false);
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }),
  );

  it.effect("prepares a newly configured Codex account during persisted recovery", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const serverSettings = yield* ServerSettingsService;
      const threadId = asThreadId("thread-codex-recovery-prepares-new-account");
      const fixture = makeSharedCodexContinuationFixture(["personal", "work"], ["personal"]);
      const instance = (accountId: "personal" | "work") => ({
        driver: "codex" as const,
        environment: fixture.instanceEnvironment,
        config: {
          homePath: fixture.homePath,
          shadowHomePath: fixture.shadowHomePath(accountId),
          accountId,
        },
      });
      yield* serverSettings.updateSettings({
        providerInstances: { codex_selected: instance("personal") },
      });
      const initial = yield* provider.startSession(threadId, {
        provider: "codex",
        providerInstanceId: "codex_selected",
        threadId,
        runtimeMode: "full-access",
      });
      yield* routing.codex.stopAll();
      yield* serverSettings.updateSettings({
        providerInstances: { codex_selected: instance("work") },
      });
      assert.equal(
        isCodexSharedContinuationStatePrepared({
          env: { ...process.env, ...fixture.environment },
          homePath: fixture.homePath,
          shadowHomePath: fixture.shadowHomePath("work"),
          accountId: "work",
        }),
        false,
      );
      routing.codex.startSession.mockClear();
      routing.codex.sendTurn.mockClear();

      yield* provider.sendTurn({
        threadId,
        input: "resume on newly configured work account",
        attachments: [],
      });

      assert.equal(
        isCodexSharedContinuationStatePrepared({
          env: { ...process.env, ...fixture.environment },
          homePath: fixture.homePath,
          shadowHomePath: fixture.shadowHomePath("work"),
          accountId: "work",
        }),
        true,
      );
      assert.equal(routing.codex.startSession.mock.calls.length, 1);
      assert.deepEqual(
        routing.codex.startSession.mock.calls[0]?.[0].resumeCursor,
        initial.resumeCursor,
      );
      assert.equal(routing.codex.sendTurn.mock.calls.length, 1);
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }),
  );

  it.effect("does not recreate a deleted shared source home during persisted recovery", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const serverSettings = yield* ServerSettingsService;
      const threadId = asThreadId("thread-codex-recovery-deleted-source");
      const fixture = makeSharedCodexContinuationFixture(["personal", "work"], ["personal"]);
      const instance = (accountId: "personal" | "work") => ({
        driver: "codex" as const,
        environment: fixture.instanceEnvironment,
        config: {
          homePath: fixture.homePath,
          shadowHomePath: fixture.shadowHomePath(accountId),
          accountId,
        },
      });
      yield* serverSettings.updateSettings({
        providerInstances: { codex_selected: instance("personal") },
      });
      yield* provider.startSession(threadId, {
        provider: "codex",
        providerInstanceId: "codex_selected",
        threadId,
        runtimeMode: "full-access",
      });
      const workOverlayHomePath = resolveActiveCodexHomeWritePath({
        env: { ...process.env, ...fixture.environment },
        homePath: fixture.homePath,
        shadowHomePath: fixture.shadowHomePath("work"),
        accountId: "work",
      });
      assert.equal(fs.existsSync(workOverlayHomePath), false);
      yield* routing.codex.stopAll();
      yield* serverSettings.updateSettings({
        providerInstances: { codex_selected: instance("work") },
      });
      fs.rmSync(fixture.homePath, { recursive: true, force: true });
      routing.codex.startSession.mockClear();
      routing.codex.sendTurn.mockClear();

      const result = yield* Effect.result(
        provider.sendTurn({
          threadId,
          input: "resume after source deletion",
          attachments: [],
        }),
      );

      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.match(String(result.failure), /missing or damaged/);
      }
      assert.equal(routing.codex.startSession.mock.calls.length, 0);
      assert.equal(routing.codex.sendTurn.mock.calls.length, 0);
      assert.equal(fs.existsSync(fixture.homePath), false);
      assert.equal(fs.existsSync(workOverlayHomePath), false);
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }),
  );

  it.effect("resumes account A after an unprepared conflicting account B is rejected", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const threadId = asThreadId("thread-codex-stale-shared-marker");
      const fixture = makeSharedCodexContinuationFixture(["personal", "work"], ["personal"]);
      const personalOptions = {
        codex: {
          homePath: fixture.homePath,
          shadowHomePath: fixture.shadowHomePath("personal"),
          accountId: "personal",
          environment: fixture.environment,
        },
      };
      const workOptions = {
        codex: {
          homePath: fixture.homePath,
          shadowHomePath: fixture.shadowHomePath("work"),
          accountId: "work",
          environment: fixture.environment,
        },
      };
      const initial = yield* provider.startSession(threadId, {
        provider: "codex",
        threadId,
        providerOptions: personalOptions,
        runtimeMode: "full-access",
      });
      assert.equal(typeof provider.stopRuntimeSession, "function");
      if (!provider.stopRuntimeSession) return;
      yield* provider.stopRuntimeSession({ threadId });

      const workOverlayHomePath = resolveActiveCodexHomeWritePath({
        env: { ...process.env, ...fixture.environment },
        homePath: fixture.homePath,
        shadowHomePath: fixture.shadowHomePath("work"),
        accountId: "work",
      });
      fs.mkdirSync(path.join(workOverlayHomePath, "sessions"), { recursive: true });
      fs.writeFileSync(
        path.join(workOverlayHomePath, "sessions", "independent.jsonl"),
        "independent",
        "utf8",
      );
      assert.equal(
        isCodexSharedContinuationStatePrepared({
          env: { ...process.env, ...fixture.environment },
          homePath: fixture.homePath,
          shadowHomePath: fixture.shadowHomePath("work"),
          accountId: "work",
        }),
        false,
      );
      routing.codex.startSession.mockClear();

      const result = yield* Effect.result(
        provider.startSession(threadId, {
          provider: "codex",
          threadId,
          providerOptions: workOptions,
          runtimeMode: "full-access",
        }),
      );
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.match(String(result.failure), /refusing to overwrite raced or independently owned/);
      }
      assert.equal(routing.codex.startSession.mock.calls.length, 0);
      assert.strictEqual(
        fs.readFileSync(path.join(workOverlayHomePath, "sessions", "independent.jsonl"), "utf8"),
        "independent",
      );
      yield* provider.startSession(threadId, {
        provider: "codex",
        threadId,
        providerOptions: personalOptions,
        runtimeMode: "full-access",
      });
      assert.equal(routing.codex.startSession.mock.calls.length, 1);
      assert.deepEqual(
        routing.codex.startSession.mock.calls[0]?.[0].resumeCursor,
        initial.resumeCursor,
      );
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }),
  );

  it.effect("does not let an exact Codex launch downgrade a persisted shared identity", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const threadId = asThreadId("thread-codex-stale-shared-marker-exact-launch");
      const fixture = makeSharedCodexContinuationFixture(["personal"]);
      const personalOptions = {
        codex: {
          homePath: fixture.homePath,
          shadowHomePath: fixture.shadowHomePath("personal"),
          accountId: "personal",
          environment: fixture.environment,
        },
      };
      yield* provider.startSession(threadId, {
        provider: "codex",
        threadId,
        providerOptions: personalOptions,
        runtimeMode: "full-access",
      });

      const personalOverlayHomePath = resolveActiveCodexHomeWritePath({
        env: { ...process.env, ...fixture.environment },
        homePath: fixture.homePath,
        shadowHomePath: fixture.shadowHomePath("personal"),
        accountId: "personal",
      });
      fs.unlinkSync(path.join(personalOverlayHomePath, "sessions"));
      fs.mkdirSync(path.join(personalOverlayHomePath, "sessions"));
      fs.writeFileSync(
        path.join(personalOverlayHomePath, "sessions", "independent.jsonl"),
        "independent",
        "utf8",
      );
      routing.codex.startSession.mockClear();

      const result = yield* Effect.result(
        provider.startSession(threadId, {
          provider: "codex",
          threadId,
          providerOptions: personalOptions,
          runtimeMode: "full-access",
        }),
      );
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.match(String(result.failure), /refusing to overwrite raced or independently owned/);
      }
      assert.equal(routing.codex.startSession.mock.calls.length, 0);
      assert.strictEqual(
        fs.readFileSync(
          path.join(personalOverlayHomePath, "sessions", "independent.jsonl"),
          "utf8",
        ),
        "independent",
      );
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }),
  );

  it.effect("reuses stopped Codex continuation when switching instances on a shared home", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const serverSettings = yield* ServerSettingsService;
      const threadId = asThreadId("thread-codex-stopped-shared-home");
      const fixture = makeSharedCodexContinuationFixture(["personal", "work"]);
      yield* serverSettings.updateSettings({
        providerInstances: {
          codex_personal: {
            driver: "codex",
            environment: fixture.instanceEnvironment,
            config: {
              homePath: fixture.homePath,
              shadowHomePath: fixture.shadowHomePath("personal"),
              accountId: "personal",
            },
          },
          codex_work: {
            driver: "codex",
            environment: fixture.instanceEnvironment,
            config: {
              homePath: fixture.homePath,
              shadowHomePath: fixture.shadowHomePath("work"),
              accountId: "work",
            },
          },
        },
      });
      const initial = yield* provider.startSession(threadId, {
        provider: "codex",
        providerInstanceId: "codex_personal",
        threadId,
        runtimeMode: "full-access",
      });
      assert.equal(typeof provider.stopRuntimeSession, "function");
      if (!provider.stopRuntimeSession) return;
      yield* provider.stopRuntimeSession({ threadId });
      routing.codex.startSession.mockClear();

      yield* provider.startSession(threadId, {
        provider: "codex",
        providerInstanceId: "codex_work",
        threadId,
        runtimeMode: "full-access",
      });

      assert.equal(routing.codex.startSession.mock.calls.length, 1);
      assert.equal(routing.codex.startSession.mock.calls[0]?.[0].providerInstanceId, "codex_work");
      assert.deepEqual(
        routing.codex.startSession.mock.calls[0]?.[0].resumeCursor,
        initial.resumeCursor,
      );
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }),
  );

  it.effect("rejects incompatible live Claude home changes before stopping the runtime", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const directory = yield* ProviderSessionDirectory;
      const threadId = asThreadId("thread-claude-live-home-boundary");
      yield* provider.startSession(threadId, {
        provider: "claudeAgent",
        threadId,
        providerOptions: { claudeAgent: { homePath: "/tmp/claude-home-a" } },
        runtimeMode: "full-access",
      });
      const binding = Option.getOrUndefined(yield* directory.getBinding(threadId));
      assert.ok(binding);
      yield* directory.upsert({ ...binding, resumeCursor: null });
      routing.claude.updateSession(threadId, (session) => {
        const { resumeCursor: _resumeCursor, ...withoutResumeCursor } = session;
        return withoutResumeCursor;
      });
      routing.claude.startSession.mockClear();
      routing.claude.stopSession.mockClear();

      const result = yield* Effect.result(
        provider.startSession(threadId, {
          provider: "claudeAgent",
          threadId,
          providerOptions: { claudeAgent: { homePath: "/tmp/claude-home-b" } },
          runtimeMode: "full-access",
        }),
      );

      assert.equal(result._tag, "Failure");
      assert.equal(routing.claude.stopSession.mock.calls.length, 0);
      assert.equal(routing.claude.startSession.mock.calls.length, 0);
    }),
  );

  it.effect("rejects incompatible stopped Claude home changes", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const threadId = asThreadId("thread-claude-stopped-home-boundary");
      yield* provider.startSession(threadId, {
        provider: "claudeAgent",
        threadId,
        providerOptions: { claudeAgent: { homePath: "/tmp/claude-stopped-home-a" } },
        runtimeMode: "full-access",
      });
      assert.equal(typeof provider.stopRuntimeSession, "function");
      if (!provider.stopRuntimeSession) return;
      yield* provider.stopRuntimeSession({ threadId });
      routing.claude.startSession.mockClear();

      const result = yield* Effect.result(
        provider.startSession(threadId, {
          provider: "claudeAgent",
          threadId,
          providerOptions: { claudeAgent: { homePath: "/tmp/claude-stopped-home-b" } },
          runtimeMode: "full-access",
        }),
      );

      assert.equal(result._tag, "Failure");
      assert.equal(routing.claude.startSession.mock.calls.length, 0);
    }),
  );

  it.effect("matches persisted launch options including server-only credentials", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const serverSettings = yield* ServerSettingsService;
      const threadId = asThreadId("thread-launch-options-match");
      const providerInstanceId = asProviderInstanceId("claude_match");

      yield* serverSettings.updateSettings({
        providerInstances: {
          claude_match: {
            driver: "claudeAgent",
            enabled: true,
            environment: [{ name: "ANTHROPIC_API_KEY", value: "env-v1", sensitive: true }],
            config: {
              homePath: "/tmp/claude-match",
            },
          },
        },
      });
      yield* provider.startSession(threadId, {
        provider: "claudeAgent",
        providerInstanceId,
        threadId,
        runtimeMode: "full-access",
      });
      assert.equal(typeof provider.sessionBindingMatchesLaunchOptions, "function");
      if (!provider.sessionBindingMatchesLaunchOptions) {
        assert.fail("sessionBindingMatchesLaunchOptions unavailable");
      }

      assert.equal(
        yield* provider.sessionBindingMatchesLaunchOptions({
          threadId,
          provider: "claudeAgent",
          providerInstanceId,
        }),
        true,
      );

      yield* serverSettings.updateSettings({
        providerInstances: {
          claude_match: {
            driver: "claudeAgent",
            enabled: true,
            environment: [{ name: "ANTHROPIC_API_KEY", value: "env-v2", sensitive: true }],
            config: {
              homePath: "/tmp/claude-match",
            },
          },
        },
      });

      assert.equal(
        yield* provider.sessionBindingMatchesLaunchOptions({
          threadId,
          provider: "claudeAgent",
          providerInstanceId,
        }),
        false,
      );
    }),
  );

  it.effect("rejects send turns whose model selection targets another provider", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      routing.codex.sendTurn.mockClear();
      const session = yield* provider.startSession(asThreadId("thread-send-mismatch"), {
        provider: "codex",
        threadId: asThreadId("thread-send-mismatch"),
        runtimeMode: "full-access",
      });

      const result = yield* Effect.result(
        provider.sendTurn({
          threadId: session.threadId,
          input: "wrong route",
          attachments: [],
          modelSelection: {
            instanceId: "claudeAgent",
            model: "claude-opus-4-6",
          },
        }),
      );

      assertFailure(
        result,
        new ProviderValidationError({
          operation: "ProviderService.sendTurn",
          issue:
            "Model selection instance 'claudeAgent' does not match routed provider instance 'codex'.",
        }),
      );
      assert.equal(routing.codex.sendTurn.mock.calls.length, 0);
    }),
  );

  it.effect(
    "canonicalizes stale provider metadata when the selected instance matches the route",
    () =>
      Effect.gen(function* () {
        const provider = yield* ProviderService;
        const serverSettings = yield* ServerSettingsService;
        routing.claude.sendTurn.mockClear();

        yield* serverSettings.updateSettings({
          providerInstances: {
            claude_work: {
              driver: "claudeAgent",
              enabled: true,
              config: { homePath: "/tmp/claude-work" },
            },
          },
        });
        const session = yield* provider.startSession(asThreadId("thread-stale-provider-instance"), {
          provider: "claudeAgent",
          providerInstanceId: "claude_work",
          threadId: asThreadId("thread-stale-provider-instance"),
          runtimeMode: "full-access",
        });

        yield* provider.sendTurn({
          threadId: session.threadId,
          input: "stale provider label, exact instance",
          attachments: [],
          modelSelection: {
            instanceId: "claude_work",
            model: "custom-claude-model",
            options: [{ id: "reasoningEffort", value: "high" }],
          },
        });

        assert.equal(routing.claude.sendTurn.mock.calls.length, 1);
        assert.deepEqual(routing.claude.sendTurn.mock.calls[0]?.[0].modelSelection, {
          instanceId: "claude_work",
          model: "custom-claude-model",
          options: [{ id: "reasoningEffort", value: "high" }],
        });
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

  it.effect("preserves provider instance id when adopting binding-less live sessions", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const serverSettings = yield* ServerSettingsService;
      const directory = yield* ProviderSessionDirectory;
      const threadId = asThreadId("thread-live-instance");

      yield* serverSettings.updateSettings({
        providerInstances: {
          codex_work: {
            driver: "codex",
            displayName: "Codex Work",
          },
        },
      });

      yield* routing.codex.adapter.startSession({
        provider: "codex",
        providerInstanceId: "codex_work",
        threadId,
        runtimeMode: "approval-required",
      });

      const bindingBeforeTurn = yield* directory.getBinding(threadId);
      assert.equal(Option.isNone(bindingBeforeTurn), true);

      yield* provider.sendTurn({
        threadId,
        input: "hello from work account",
        attachments: [],
      });

      const bindingAfterTurn = yield* directory.getBinding(threadId);
      assert.equal(Option.isSome(bindingAfterTurn), true);
      if (Option.isSome(bindingAfterTurn)) {
        assert.equal(bindingAfterTurn.value.provider, "codex");
        assert.equal(bindingAfterTurn.value.providerInstanceId, "codex_work");
      }
    }),
  );

  it.effect("does not adopt a live same-driver session from a different provider instance", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const serverSettings = yield* ServerSettingsService;
      const threadId = asThreadId("thread-cross-instance-recovery");

      yield* serverSettings.updateSettings({
        providerInstances: {
          codex_personal: {
            driver: "codex",
            displayName: "Codex Personal",
          },
          codex_work: {
            driver: "codex",
            displayName: "Codex Work",
          },
        },
      });

      const initial = yield* provider.startSession(threadId, {
        provider: "codex",
        providerInstanceId: "codex_work",
        threadId,
        cwd: "/tmp/project-work",
        runtimeMode: "full-access",
      });
      yield* routing.codex.stopSession(threadId);
      yield* routing.codex.adapter.startSession({
        provider: "codex",
        providerInstanceId: "codex_personal",
        threadId,
        runtimeMode: "full-access",
      });
      routing.codex.stopSession.mockClear();
      routing.codex.startSession.mockClear();
      routing.codex.sendTurn.mockClear();

      yield* provider.sendTurn({
        threadId,
        input: "continue on the work account",
        attachments: [],
      });

      assert.equal(routing.codex.stopSession.mock.calls.length, 1);
      assert.equal(routing.codex.startSession.mock.calls.length, 1);
      const resumedStartInput = routing.codex.startSession.mock.calls[0]?.[0];
      assert.equal(typeof resumedStartInput === "object" && resumedStartInput !== null, true);
      if (resumedStartInput && typeof resumedStartInput === "object") {
        assert.equal(resumedStartInput.providerInstanceId, "codex_work");
        assert.deepEqual(resumedStartInput.resumeCursor, initial.resumeCursor);
      }
      assert.equal(routing.codex.sendTurn.mock.calls.length, 1);
    }),
  );

  it.effect("keeps an unstamped live same-driver session when the binding owns the instance", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const serverSettings = yield* ServerSettingsService;
      const threadId = asThreadId("thread-unstamped-live-instance");

      yield* serverSettings.updateSettings({
        providerInstances: {
          codex_work: {
            driver: "codex",
            displayName: "Codex Work",
          },
        },
      });

      yield* provider.startSession(threadId, {
        provider: "codex",
        providerInstanceId: "codex_work",
        threadId,
        cwd: "/tmp/project-work",
        runtimeMode: "full-access",
      });
      routing.codex.updateSession(threadId, (existing) => {
        const { providerInstanceId: _providerInstanceId, ...sessionWithoutInstance } = existing;
        return sessionWithoutInstance;
      });
      routing.codex.stopSession.mockClear();
      routing.codex.startSession.mockClear();
      routing.codex.sendTurn.mockClear();

      yield* provider.sendTurn({
        threadId,
        input: "continue on the unstamped work account",
        attachments: [],
      });

      assert.equal(routing.codex.stopSession.mock.calls.length, 0);
      assert.equal(routing.codex.startSession.mock.calls.length, 0);
      assert.equal(routing.codex.sendTurn.mock.calls.length, 1);
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
      routing.claude.startSession.mockClear();

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
        threadId: asThreadId("thread-claude-send-turn"),
        cwd: "/tmp/project-claude-send-turn",
        modelSelection: {
          instanceId: "claudeAgent",
          model: "claude-opus-4-6",
          options: [{ id: "effort", value: "max" }],
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
          instanceId: "claudeAgent",
          model: "claude-opus-4-6",
          options: [{ id: "effort", value: "max" }],
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
          instanceId: "codex",
          model: "gpt-5-codex",
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
            instanceId: "codex",
            model: "gpt-5-codex",
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
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "synara-provider-service-start-"));
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
        Layer.provide(ServerSettingsService.layerTest()),
        Layer.provide(ProviderServiceTestSecretStoreLayer),
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
        Layer.provide(ServerSettingsService.layerTest()),
        Layer.provide(ProviderServiceTestSecretStoreLayer),
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

  it.effect("clears stale resume cursor and provider options for fresh restart", () =>
    Effect.gen(function* () {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "synara-provider-service-clear-"));
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
        Layer.provide(ServerSettingsService.layerTest()),
        Layer.provide(ProviderServiceTestSecretStoreLayer),
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
        Layer.provide(ServerSettingsService.layerTest()),
        Layer.provide(ProviderServiceTestSecretStoreLayer),
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
        assert.equal(startPayload.providerOptions, undefined);
        assert.equal(startPayload.resumeCursor, undefined);
      }

      fs.rmSync(tempDir, { recursive: true, force: true });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("recovers provider-instance sessions from current settings after options clear", () =>
    Effect.gen(function* () {
      const tempDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "synara-provider-service-instance-clear-"),
      );
      const dbPath = path.join(tempDir, "orchestration.sqlite");
      const threadId = asThreadId("thread-instance-options-clear");
      const codexHomePath = path.join(tempDir, "codex-work");
      const codexShadowHomePath = path.join(tempDir, "codex-work-shadow");
      const codexEnvironment = { SYNARA_HOME: path.join(tempDir, "synara-runtime") };
      const codexInstanceEnvironment = [
        { name: "SYNARA_HOME", value: codexEnvironment.SYNARA_HOME, sensitive: false },
      ];
      fs.mkdirSync(codexHomePath, { recursive: true });
      fs.mkdirSync(codexShadowHomePath, { recursive: true });
      fs.writeFileSync(path.join(codexHomePath, "config.toml"), "", "utf8");
      fs.writeFileSync(path.join(codexShadowHomePath, "auth.json"), "{}", "utf8");
      buildCodexProcessEnv({
        env: { ...process.env, ...codexEnvironment },
        homePath: codexHomePath,
        shadowHomePath: codexShadowHomePath,
        accountId: "work",
      });
      buildCodexProcessEnv({
        env: { ...process.env, ...codexEnvironment },
        homePath: codexHomePath,
        accountId: "codex_work",
      });
      const persistenceLayer = makeSqlitePersistenceLive(dbPath);
      const runtimeRepositoryLayer = ProviderSessionRuntimeRepositoryLive.pipe(
        Layer.provide(persistenceLayer),
      );
      const firstSettings: Partial<ServerSettings> = {
        providerInstances: {
          codex_work: {
            driver: "codex",
            enabled: true,
            environment: codexInstanceEnvironment,
            config: {
              homePath: codexHomePath,
              shadowHomePath: codexShadowHomePath,
              accountId: "work",
            },
          },
        },
      };
      const secondSettings: Partial<ServerSettings> = {
        providerInstances: {
          codex_work: {
            driver: "codex",
            enabled: true,
            environment: codexInstanceEnvironment,
            config: {
              homePath: codexHomePath,
            },
          },
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
        Layer.provide(ServerSettingsService.layerTest(firstSettings)),
        Layer.provide(ProviderServiceTestSecretStoreLayer),
      );

      const initial = yield* Effect.gen(function* () {
        const provider = yield* ProviderService;
        return yield* provider.startSession(threadId, {
          provider: "codex",
          providerInstanceId: "codex_work",
          threadId,
          cwd: "/tmp/project-instance-options-clear",
          runtimeMode: "full-access",
        });
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
        Layer.provide(ServerSettingsService.layerTest(secondSettings)),
        Layer.provide(ProviderServiceTestSecretStoreLayer),
      );

      yield* Effect.gen(function* () {
        const provider = yield* ProviderService;
        yield* provider.sendTurn({
          threadId: initial.threadId,
          input: "continue after account fields cleared",
          attachments: [],
        });
      }).pipe(Effect.provide(secondProviderLayer));

      assert.equal(secondCodex.startSession.mock.calls.length, 1);
      const recoveredInput = secondCodex.startSession.mock.calls[0]?.[0];
      assert.equal(typeof recoveredInput === "object" && recoveredInput !== null, true);
      if (recoveredInput && typeof recoveredInput === "object") {
        const startPayload = recoveredInput as {
          providerOptions?: unknown;
          resumeCursor?: unknown;
          providerInstanceId?: string;
        };
        assert.equal(startPayload.providerInstanceId, "codex_work");
        assert.deepEqual(startPayload.providerOptions, {
          codex: {
            homePath: codexHomePath,
            accountId: "codex_work",
            environment: codexEnvironment,
          },
        });
        assert.deepEqual(startPayload.resumeCursor, initial.resumeCursor);
      }

      fs.rmSync(tempDir, { recursive: true, force: true });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reuses resume cursor when hydrated instance options only add redacted fields", () =>
    Effect.gen(function* () {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "synara-provider-service-redacted-"));
      const dbPath = path.join(tempDir, "orchestration.sqlite");
      const threadId = asThreadId("thread-redacted-instance-options");
      const persistenceLayer = makeSqlitePersistenceLive(dbPath);
      const runtimeRepositoryLayer = ProviderSessionRuntimeRepositoryLive.pipe(
        Layer.provide(persistenceLayer),
      );
      const settings: Partial<ServerSettings> = {
        providerInstances: {
          opencode_work: {
            driver: "opencode",
            enabled: true,
            environment: [
              { name: "OPENCODE_API_KEY", value: "opencode-env-secret", sensitive: true },
            ],
            config: {
              serverUrl: "http://127.0.0.1:4096",
              serverPassword: "opencode-password",
            },
          },
        },
      };

      const firstOpenCode = makeFakeCodexAdapter("opencode");
      const firstRegistry: typeof ProviderAdapterRegistry.Service = {
        getByProvider: (provider) =>
          provider === "opencode"
            ? Effect.succeed(firstOpenCode.adapter)
            : Effect.fail(new ProviderUnsupportedError({ provider })),
        listProviders: () => Effect.succeed(["opencode"]),
      };
      const firstDirectoryLayer = ProviderSessionDirectoryLive.pipe(
        Layer.provide(runtimeRepositoryLayer),
      );
      const firstProviderLayer = makeProviderServiceLive().pipe(
        Layer.provide(Layer.succeed(ProviderAdapterRegistry, firstRegistry)),
        Layer.provide(firstDirectoryLayer),
        Layer.provide(AnalyticsService.layerTest),
        Layer.provide(ServerSettingsService.layerTest(settings)),
        Layer.provide(ProviderServiceTestSecretStoreLayer),
      );

      const initial = yield* Effect.gen(function* () {
        const provider = yield* ProviderService;
        return yield* provider.startSession(threadId, {
          provider: "opencode",
          providerInstanceId: "opencode_work",
          threadId,
          cwd: "/tmp/project-redacted-instance-options",
          runtimeMode: "full-access",
        });
      }).pipe(Effect.provide(firstProviderLayer));

      const persisted = yield* Effect.gen(function* () {
        const runtimeRepository = yield* ProviderSessionRuntimeRepository;
        return yield* runtimeRepository.getByThreadId({ threadId });
      }).pipe(Effect.provide(runtimeRepositoryLayer));
      assert.equal(Option.isSome(persisted), true);
      if (Option.isSome(persisted)) {
        const runtimePayload = persisted.value.runtimePayload as {
          providerOptionsCredentialsFingerprint?: unknown;
          providerOptions?: {
            opencode?: {
              serverPassword?: string;
              environment?: Record<string, string>;
            };
          };
        };
        const rawSecretFingerprint = createHash("sha256")
          .update(
            JSON.stringify({
              environment: [["OPENCODE_API_KEY", "opencode-env-secret"]],
              serverPassword: "opencode-password",
            }),
          )
          .digest("hex");
        assert.equal(runtimePayload.providerOptions?.opencode?.serverPassword, undefined);
        assert.equal(runtimePayload.providerOptions?.opencode?.environment, undefined);
        assert.equal(typeof runtimePayload.providerOptionsCredentialsFingerprint, "string");
        assert.notEqual(runtimePayload.providerOptionsCredentialsFingerprint, rawSecretFingerprint);
      }

      const secondOpenCode = makeFakeCodexAdapter("opencode");
      const secondRegistry: typeof ProviderAdapterRegistry.Service = {
        getByProvider: (provider) =>
          provider === "opencode"
            ? Effect.succeed(secondOpenCode.adapter)
            : Effect.fail(new ProviderUnsupportedError({ provider })),
        listProviders: () => Effect.succeed(["opencode"]),
      };
      const secondDirectoryLayer = ProviderSessionDirectoryLive.pipe(
        Layer.provide(runtimeRepositoryLayer),
      );
      const secondProviderLayer = makeProviderServiceLive().pipe(
        Layer.provide(Layer.succeed(ProviderAdapterRegistry, secondRegistry)),
        Layer.provide(secondDirectoryLayer),
        Layer.provide(AnalyticsService.layerTest),
        Layer.provide(ServerSettingsService.layerTest(settings)),
        Layer.provide(ProviderServiceTestSecretStoreLayer),
      );

      yield* Effect.gen(function* () {
        const provider = yield* ProviderService;
        yield* provider.startSession(threadId, {
          provider: "opencode",
          providerInstanceId: "opencode_work",
          threadId,
          cwd: "/tmp/project-redacted-instance-options",
          runtimeMode: "full-access",
        });
      }).pipe(Effect.provide(secondProviderLayer));

      assert.equal(secondOpenCode.startSession.mock.calls.length, 1);
      const resumedInput = secondOpenCode.startSession.mock.calls[0]?.[0];
      assert.equal(typeof resumedInput === "object" && resumedInput !== null, true);
      if (resumedInput && typeof resumedInput === "object") {
        const startPayload = resumedInput as {
          providerOptions?: {
            opencode?: {
              serverUrl?: string;
              serverPassword?: string;
              environment?: Record<string, string>;
            };
          };
          resumeCursor?: unknown;
        };
        assert.deepEqual(startPayload.resumeCursor, initial.resumeCursor);
        assert.deepEqual(startPayload.providerOptions?.opencode, {
          serverUrl: "http://127.0.0.1:4096",
          serverPassword: "opencode-password",
          environment: { OPENCODE_API_KEY: "opencode-env-secret" },
        });
      }

      fs.rmSync(tempDir, { recursive: true, force: true });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("stops the live runtime without carrying stale provider options into restart", () =>
    Effect.gen(function* () {
      const tempDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "synara-provider-service-stop-runtime-"),
      );
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
        Layer.provide(ServerSettingsService.layerTest()),
        Layer.provide(ProviderServiceTestSecretStoreLayer),
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
        Layer.provide(ServerSettingsService.layerTest()),
        Layer.provide(ProviderServiceTestSecretStoreLayer),
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
        assert.equal(startPayload.providerOptions, undefined);
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
