import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import type {
  OrchestrationEvent,
  ProviderKind,
  ProviderRuntimeEvent,
  ProviderSession,
} from "@synara/contracts";
import {
  CheckpointRef,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
} from "@synara/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Logger,
  ManagedRuntime,
  Option,
  PubSub,
  Scope,
  ServiceMap,
  Stream,
} from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as projectImportPaths from "../projectImportPaths.ts";

import { CheckpointStoreLive } from "../../checkpointing/Layers/CheckpointStore.ts";
import {
  CheckpointStore,
  type CheckpointStoreShape,
} from "../../checkpointing/Services/CheckpointStore.ts";
import type { CheckpointStoreError } from "../../checkpointing/Errors.ts";
import { GitCommandError } from "../../git/Errors.ts";
import { GitCoreLive } from "../../git/Layers/GitCore.ts";
import { CheckpointReactorLive } from "./CheckpointReactor.ts";
import { TurnCheckpointCoordinatorLive } from "./TurnCheckpointCoordinator.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import { RuntimeReceiptBus } from "../Services/RuntimeReceiptBus.ts";
import { TurnCheckpointCoordinator } from "../Services/TurnCheckpointCoordinator.ts";
import { RuntimeReceiptBusLive } from "./RuntimeReceiptBus.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { PersistenceSqlError } from "../../persistence/Errors.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import {
  CHECKPOINT_RUNTIME_CONSUMER,
  PROVIDER_RUNTIME_INGESTION_CONSUMER,
  ProviderRuntimeEventRepository,
} from "../../persistence/Services/ProviderRuntimeEvents.ts";
import { ProviderRuntimeEventRepositoryLive } from "../../persistence/Layers/ProviderRuntimeEvents.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import { CheckpointReactor } from "../Services/CheckpointReactor.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../../provider/Services/ProviderService.ts";
import { ProviderSessionNotFoundError, type ProviderServiceError } from "../../provider/Errors.ts";
import {
  CHECKPOINT_REFS_PREFIX,
  checkpointRefForThreadMessageStart,
  checkpointRefForThreadTurn,
  checkpointRefForThreadTurnLive,
  checkpointRefForThreadTurnStart,
} from "../../checkpointing/Utils.ts";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Statement from "effect/unstable/sql/Statement";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";

const asProjectId = (value: string): ProjectId => ProjectId.makeUnsafe(value);
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

function createProviderServiceHarness(
  cwd: string,
  hasSession = true,
  sessionCwd = cwd,
  providerName: ProviderSession["provider"] = "codex",
  providerStatus: ProviderSession["status"] = "ready",
  activeTurnId?: TurnId,
  runtimeEventCapacity?: number,
) {
  const now = new Date().toISOString();
  const runtimeEventPubSub = Effect.runSync(
    runtimeEventCapacity === undefined
      ? PubSub.unbounded<ProviderRuntimeEvent>()
      : PubSub.bounded<ProviderRuntimeEvent>(runtimeEventCapacity),
  );
  const rollbackConversation = vi.fn(
    (_input: {
      readonly threadId: ThreadId;
      readonly numTurns: number;
    }): Effect.Effect<void, ProviderServiceError> => Effect.void,
  );

  const unsupported = <A>() =>
    Effect.die(new Error("Unsupported provider call in test")) as Effect.Effect<A, never>;
  const listSessions = () =>
    hasSession
      ? Effect.succeed([
          {
            provider: providerName,
            status: providerStatus,
            runtimeMode: "full-access",
            threadId: ThreadId.makeUnsafe("thread-1"),
            cwd: sessionCwd,
            ...(activeTurnId !== undefined ? { activeTurnId } : {}),
            createdAt: now,
            updatedAt: now,
          },
        ] satisfies ReadonlyArray<ProviderSession>)
      : Effect.succeed([] as ReadonlyArray<ProviderSession>);
  const service: ProviderServiceShape = {
    startSession: () => unsupported(),
    sendTurn: () => unsupported(),
    steerTurn: () => unsupported(),
    startReview: () => unsupported(),
    forkThread: () => Effect.succeed(null),
    interruptTurn: () => unsupported(),
    stopTask: () => unsupported(),
    backgroundTask: () => unsupported(),
    steerSubagent: () => unsupported(),
    respondToRequest: () => unsupported(),
    respondToUserInput: () => unsupported(),
    stopSession: () => unsupported(),
    listSessions,
    getPersistedSessionProfile: () => Effect.succeed(undefined),
    getCapabilities: () => Effect.succeed({ sessionModelSwitch: "in-session" }),
    rollbackConversation,
    compactThread: () => unsupported(),
    closeRuntimeEvents: Effect.void,
    streamEvents: Stream.fromPubSub(runtimeEventPubSub),
  };

  const canonical = (event: LegacyProviderRuntimeEvent | ProviderRuntimeEvent) =>
    ({ ...event, payload: event.payload ?? {} }) as unknown as ProviderRuntimeEvent;
  const emit = (event: LegacyProviderRuntimeEvent): void => {
    Effect.runSync(PubSub.publish(runtimeEventPubSub, canonical(event)));
  };

  return {
    service,
    rollbackConversation,
    emit,
    publish: (event: LegacyProviderRuntimeEvent | ProviderRuntimeEvent) =>
      PubSub.publish(runtimeEventPubSub, canonical(event)),
  };
}

async function waitForThread(
  engine: OrchestrationEngineShape,
  predicate: (thread: {
    id: string;
    latestTurn: { turnId: string } | null;
    checkpoints: ReadonlyArray<{
      turnId: string;
      checkpointTurnCount: number;
      status: "ready" | "missing" | "error";
      assistantMessageId?: MessageId | null;
      files?: ReadonlyArray<{ path: string }>;
    }>;
    activities: ReadonlyArray<{ kind: string; payload?: unknown }>;
  }) => boolean,
  timeoutOrThread: number | ThreadId = 30_000,
  timeoutIfThread = 30_000,
) {
  const timeoutMs = typeof timeoutOrThread === "number" ? timeoutOrThread : timeoutIfThread;
  const threadId =
    typeof timeoutOrThread === "number" ? ThreadId.makeUnsafe("thread-1") : timeoutOrThread;
  const deadline = Date.now() + timeoutMs;
  const poll = async (): Promise<{
    id: string;
    latestTurn: { turnId: string } | null;
    checkpoints: ReadonlyArray<{
      turnId: string;
      checkpointTurnCount: number;
      status: "ready" | "missing" | "error";
      assistantMessageId?: MessageId | null;
      files?: ReadonlyArray<{ path: string }>;
    }>;
    activities: ReadonlyArray<{ kind: string; payload?: unknown }>;
  }> => {
    const readModel = await Effect.runPromise(engine.getReadModel());
    const thread = readModel.threads.find((entry) => entry.id === threadId);
    if (thread && predicate(thread)) {
      return thread;
    }
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for thread state.");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    return poll();
  };
  return poll();
}

async function waitForEvent(
  engine: OrchestrationEngineShape,
  predicate: (event: OrchestrationEvent) => boolean,
  timeoutMs = 30_000,
) {
  const deadline = Date.now() + timeoutMs;
  const poll = async () => {
    const events = await Effect.runPromise(
      Stream.runCollect(engine.readEvents(0)).pipe(Effect.map((chunk) => Array.from(chunk))),
    );
    if (events.some(predicate)) {
      return events;
    }
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for orchestration event.");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    return poll();
  };
  return poll();
}

function runGit(cwd: string, args: ReadonlyArray<string>) {
  return execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
}

/**
 * Rescue refs live at `<prefix>/<encoded thread id>/revert-rescue/<token>`, so
 * they cannot be found by scanning a fixed `revert-rescue` prefix — that would
 * be a pattern `git for-each-ref` can never match, and a leak would go
 * unnoticed. List the whole checkpoint namespace and filter instead.
 */
function listRevertRescueRefs(cwd: string): ReadonlyArray<string> {
  return runGit(cwd, ["for-each-ref", "--format=%(refname)", CHECKPOINT_REFS_PREFIX])
    .split("\n")
    .filter((ref) => ref.includes("/revert-rescue/"));
}

function createGitRepository(hasInitialCommit = true) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "synara-checkpoint-handler-"));
  runGit(cwd, ["init", "--initial-branch=main"]);
  runGit(cwd, ["config", "user.email", "test@example.com"]);
  runGit(cwd, ["config", "user.name", "Test User"]);
  if (hasInitialCommit) {
    fs.writeFileSync(path.join(cwd, "README.md"), "v1\n", "utf8");
    runGit(cwd, ["add", "."]);
    runGit(cwd, ["commit", "-m", "Initial"]);
  }
  return cwd;
}

function gitRefExists(cwd: string, ref: string): boolean {
  try {
    runGit(cwd, ["show-ref", "--verify", "--quiet", ref]);
    return true;
  } catch {
    return false;
  }
}

function gitShowFileAtRef(cwd: string, ref: string, filePath: string): string {
  return runGit(cwd, ["show", `${ref}:${filePath}`]);
}

async function waitForGitRefExists(cwd: string, ref: string, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  const poll = async (): Promise<void> => {
    if (gitRefExists(cwd, ref)) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for git ref '${ref}'.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    return poll();
  };
  return poll();
}

async function waitForGitRefMissing(cwd: string, ref: string, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  const poll = async (): Promise<void> => {
    if (!gitRefExists(cwd, ref)) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for git ref '${ref}' to be deleted.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    return poll();
  };
  return poll();
}

describe("CheckpointReactor", () => {
  let runtime: ManagedRuntime.ManagedRuntime<
    | OrchestrationEngineService
    | CheckpointReactor
    | CheckpointStore
    | SqlClient.SqlClient
    | ProjectionSnapshotQuery
    | RuntimeReceiptBus
    | TurnCheckpointCoordinator
    | ProviderService
    | ProviderRuntimeEventRepository
    | OrchestrationEventStore,
    unknown
  > | null = null;
  let scope: Scope.Closeable | null = null;
  const tempDirs: string[] = [];

  afterEach(async () => {
    if (scope) {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
    scope = null;
    if (runtime) {
      await runtime.dispose();
    }
    runtime = null;
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  async function createHarness(options?: {
    readonly hasSession?: boolean;
    readonly seedFilesystemCheckpoints?: boolean;
    readonly projectWorkspaceRoot?: string;
    readonly threadWorktreePath?: string | null;
    readonly providerSessionCwd?: string;
    readonly providerName?: ProviderKind;
    readonly providerStatus?: ProviderSession["status"];
    readonly providerActiveTurnId?: TurnId;
    readonly hasInitialCommit?: boolean;
    readonly runtimeEventCapacity?: number;
    readonly sqlStatements?: string[];
    readonly startReactor?: boolean;
    readonly simulateProviderBaseline?: boolean;
  }) {
    const cwd = createGitRepository(options?.hasInitialCommit ?? true);
    tempDirs.push(cwd);
    const provider = createProviderServiceHarness(
      cwd,
      options?.hasSession ?? true,
      options?.providerSessionCwd ?? cwd,
      options?.providerName ?? "codex",
      options?.providerStatus ?? "ready",
      options?.providerActiveTurnId,
      options?.runtimeEventCapacity,
    );

    // Installed after the harness has seeded its checkpoints, so a test can fail
    // one specific step of the revert saga without disturbing setup.
    const failures: {
      restoreCheckpoint?: (
        input: Parameters<CheckpointStoreShape["restoreCheckpoint"]>[0],
      ) => CheckpointStoreError | null;
      deleteCheckpointRefs?: (
        input: Parameters<CheckpointStoreShape["deleteCheckpointRefs"]>[0],
      ) => CheckpointStoreError | null;
    } = {};
    const orchestrationLayer = OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionPipelineLive),
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationEventStoreLive),
      Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    );

    const checkpointStoreLayer = Layer.effect(
      CheckpointStore,
      Effect.gen(function* () {
        const store = yield* CheckpointStore;
        return {
          ...store,
          restoreCheckpoint: (input) =>
            Effect.suspend(() => {
              const failure = failures.restoreCheckpoint?.(input) ?? null;
              return failure === null ? store.restoreCheckpoint(input) : Effect.fail(failure);
            }),
          deleteCheckpointRefs: (input) =>
            Effect.suspend(() => {
              const failure = failures.deleteCheckpointRefs?.(input) ?? null;
              return failure === null ? store.deleteCheckpointRefs(input) : Effect.fail(failure);
            }),
        } satisfies CheckpointStoreShape;
      }),
    ).pipe(Layer.provide(CheckpointStoreLive.pipe(Layer.provide(GitCoreLive))));

    const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
      prefix: "synara-checkpoint-reactor-test-",
    });

    const layer = CheckpointReactorLive.pipe(
      Layer.provideMerge(orchestrationLayer),
      Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
      Layer.provideMerge(RuntimeReceiptBusLive),
      Layer.provideMerge(TurnCheckpointCoordinatorLive),
      Layer.provideMerge(Layer.succeed(ProviderService, provider.service)),
      Layer.provideMerge(checkpointStoreLayer),
      Layer.provideMerge(ServerConfigLayer),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(NodeServices.layer),
      Layer.provideMerge(ProviderRuntimeEventRepositoryLive),
      Layer.provideMerge(OrchestrationEventStoreLive),
      Layer.provideMerge(SqlitePersistenceMemory),
    );

    runtime = ManagedRuntime.make(
      options?.sqlStatements === undefined
        ? layer
        : layer.pipe(
            Layer.provide(
              Layer.succeed(Statement.CurrentTransformer, (statement) =>
                Effect.sync(() => {
                  options.sqlStatements!.push(statement.compile()[0]);
                  return statement;
                }),
              ),
            ),
          ),
    );
    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const reactor = await runtime.runPromise(Effect.service(CheckpointReactor));
    const checkpointStore = await runtime.runPromise(Effect.service(CheckpointStore));
    scope = await Effect.runPromise(Scope.make("sequential"));
    const startReactor = () => Effect.runPromise(reactor.start.pipe(Scope.provide(scope!)));
    if (options?.startReactor !== false) await startReactor();
    const runtimeEvents = await runtime.runPromise(
      Effect.service(ProviderRuntimeEventRepository).pipe(
        Effect.provide(ProviderRuntimeEventRepositoryLive),
      ),
    );
    const drain = () => Effect.runPromise(reactor.drain);

    const createdAt = new Date().toISOString();
    await Effect.runPromise(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("cmd-project-create"),
        projectId: asProjectId("project-1"),
        title: "Test Project",
        workspaceRoot: options?.projectWorkspaceRoot ?? cwd,
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );
    await Effect.runPromise(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-thread-create"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        projectId: asProjectId("project-1"),
        title: "Thread",
        modelSelection: {
          provider: "codex",
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: options?.threadWorktreePath ?? cwd,
        createdAt,
      }),
    );

    if (options?.seedFilesystemCheckpoints ?? true) {
      await runtime.runPromise(
        checkpointStore.captureCheckpoint({
          cwd,
          checkpointRef: checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 0),
        }),
      );
      fs.writeFileSync(path.join(cwd, "README.md"), "v2\n", "utf8");
      await runtime.runPromise(
        checkpointStore.captureCheckpoint({
          cwd,
          checkpointRef: checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 1),
        }),
      );
      fs.writeFileSync(path.join(cwd, "README.md"), "v3\n", "utf8");
      await runtime.runPromise(
        checkpointStore.captureCheckpoint({
          cwd,
          checkpointRef: checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 2),
        }),
      );
    }

    return {
      sourceEngine: engine,
      // This suite isolates the checkpoint reactor. Model the provider's
      // pre-dispatch owner explicitly instead of relying on a domain backup.
      engine: {
        ...engine,
        dispatch: (command) =>
          command.type === "thread.turn.start" && options?.simulateProviderBaseline !== false
            ? checkpointStore
                .captureCheckpoint({
                  cwd,
                  checkpointRef: checkpointRefForThreadMessageStart(
                    command.threadId,
                    command.message.messageId,
                  ),
                  skipIfExists: true,
                })
                .pipe(Effect.orDie, Effect.andThen(engine.dispatch(command)))
            : engine.dispatch(command),
      } satisfies OrchestrationEngineShape,
      provider,
      checkpointStore,
      cwd,
      drain,
      startReactor,
      start: startReactor,
      reactor,
      runtimeEvents,
      prepareBaseline: (turnId: TurnId) =>
        Effect.runPromise(
          checkpointStore.captureCheckpoint({
            cwd,
            checkpointRef: checkpointRefForThreadTurnStart(ThreadId.makeUnsafe("thread-1"), turnId),
            skipIfExists: true,
          }),
        ),
      failures,
    };
  }

  it.each(["first registration", "registered backlog"] as const)(
    "adopts an existing domain journal without capturing historical turn starts from today's tree: %s",
    async (registration) => {
      const harness = await createHarness({
        startReactor: false,
        seedFilesystemCheckpoints: false,
        simulateProviderBaseline: false,
      });
      if (registration === "registered backlog") {
        await runtime!.runPromise(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            const now = new Date().toISOString();
            yield* sql`INSERT INTO orchestration_consumer_state (consumer_name, last_acked_sequence, created_at, updated_at) VALUES ('checkpoint-reactor.domain.v1', 0, ${now}, ${now})`;
          }),
        );
      }
      const threadId = ThreadId.makeUnsafe("thread-1");
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.makeUnsafe("upgrade-historical-start"),
          threadId,
          message: {
            messageId: MessageId.makeUnsafe("upgrade-historical-message"),
            role: "user",
            text: "old request",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: new Date().toISOString(),
        }),
      );
      await Effect.runPromise(harness.engine.drain);
      const highWater = await Effect.runPromise(harness.engine.getEventHighWaterSequence);
      fs.writeFileSync(path.join(harness.cwd, "README.md"), "today after historical edits\n");
      const capture = vi.spyOn(harness.checkpointStore, "captureCheckpoint");
      await harness.start();
      await settleCheckpointWork(harness.reactor.drain);
      expect(capture).not.toHaveBeenCalled();
      expect(
        gitRefExists(
          harness.cwd,
          checkpointRefForThreadMessageStart(
            threadId,
            MessageId.makeUnsafe("upgrade-historical-message"),
          ),
        ),
      ).toBe(false);
      const cursor = await runtime!.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return yield* sql<{
            last_acked_sequence: number;
          }>`SELECT last_acked_sequence FROM orchestration_consumer_state WHERE consumer_name = 'checkpoint-reactor.domain.v1'`;
        }),
      );
      expect(cursor[0]?.last_acked_sequence).toBeGreaterThanOrEqual(highWater);
    },
  );

  it.each(["first registration", "registered backlog"] as const)(
    "does not freshly capture unaccepted native history at startup: %s",
    async (registration) => {
      const harness = await createHarness({
        startReactor: false,
        seedFilesystemCheckpoints: false,
      });
      if (registration === "registered backlog")
        await runtime!.runPromise(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            const now = new Date().toISOString();
            yield* sql`INSERT INTO provider_runtime_event_consumers (consumer_name, last_acked_sequence, created_at, updated_at) VALUES (${CHECKPOINT_RUNTIME_CONSUMER}, 0, ${now}, ${now})`;
          }),
        );
      const threadId = ThreadId.makeUnsafe("thread-1");
      await Effect.runPromise(
        harness.runtimeEvents.append(nativeCompletion("startup-unaccepted-native", threadId)),
      );
      fs.writeFileSync(
        path.join(harness.cwd, "README.md"),
        "today, not the historical native outcome\n",
      );
      const capture = vi.spyOn(harness.checkpointStore, "captureCheckpoint");
      await harness.start();
      await settleCheckpointWork(harness.reactor.drain);
      expect(capture).not.toHaveBeenCalled();
      const thread = (await Effect.runPromise(harness.engine.getReadModel())).threads.find(
        (entry) => entry.id === threadId,
      )!;
      expect(thread.activities.some((entry) => entry.kind === "checkpoint.capture.failed")).toBe(
        true,
      );
    },
  );

  it.each([
    "first registration",
    "missing adoption cut",
    "post-adoption unclaimed",
    "post-adoption inflight",
  ] as const)(
    "recovers persisted revert intents according to adoption and claim evidence: %s",
    async (mode) => {
      const harness = await createHarness({ startReactor: false });
      const beforeRequest = await Effect.runPromise(harness.engine.getEventHighWaterSequence);
      const now = new Date().toISOString();
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.checkpoint.revert",
          commandId: CommandId.makeUnsafe("upgrade-historical-fenced-revert"),
          threadId: ThreadId.makeUnsafe("thread-1"),
          turnCount: 0,
          scope: "thread",
          createdAt: now,
        }),
      );
      await Effect.runPromise(harness.engine.drain);
      const request = (
        await Effect.runPromise(Stream.runCollect(harness.engine.readEvents(beforeRequest)))
      ).find((event) => event.type === "thread.checkpoint-revert-requested")!;
      if (mode !== "first registration")
        await runtime!.runPromise(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* sql`INSERT INTO orchestration_consumer_state (consumer_name, last_acked_sequence, created_at, updated_at) VALUES ('checkpoint-reactor.domain.v1', ${beforeRequest}, ${now}, ${now})`;
            if (mode !== "missing adoption cut")
              yield* sql`INSERT INTO orchestration_consumer_state (consumer_name, last_acked_sequence, created_at, updated_at) VALUES ('checkpoint-reactor.domain-adoption.v1', 0, ${now}, ${now})`;
            if (mode === "post-adoption inflight")
              yield* sql`INSERT INTO orchestration_event_deliveries (consumer_name, event_sequence, thread_id, state, claim_owner, claimed_at, claim_expires_at, attempt_count, last_error, completed_at, updated_at)
          VALUES ('checkpoint-reactor.domain.v1', ${request.sequence}, 'thread-1', 'inflight', 'previous-revert-owner', ${now}, ${now}, 1, NULL, NULL, ${now})`;
          }),
        );
      const restore = vi.spyOn(harness.checkpointStore, "restoreCheckpoint");
      const reverse = vi.spyOn(harness.checkpointStore, "reverseCheckpointDiff");
      await harness.start();
      await settleCheckpointWork(harness.reactor.drain);
      const canApply = mode === "post-adoption unclaimed";
      expect(restore).toHaveBeenCalledTimes(canApply ? 1 : 0);
      expect(reverse).not.toHaveBeenCalled();
      expect(fs.readFileSync(path.join(harness.cwd, "README.md"), "utf8")).toBe(
        canApply ? "v1\n" : "v3\n",
      );
      const thread = (await Effect.runPromise(harness.engine.getReadModel())).threads.find(
        (entry) => entry.id === "thread-1",
      )!;
      expect(
        thread.activities.filter((entry) => entry.kind === "checkpoint.revert.failed"),
      ).toHaveLength(canApply ? 0 : 1);
    },
  );

  it("schedules SQL-filtered domain pages and ACKs telemetry without decoding raw payloads", async () => {
    const harness = await createHarness({ seedFilesystemCheckpoints: false });
    await harness.drain();
    const eventStore = await runtime!.runPromise(Effect.service(OrchestrationEventStore));
    const reads = vi.spyOn(eventStore, "readFromSequence");
    const rawRepository = await runtime!.runPromise(Effect.service(ProviderRuntimeEventRepository));
    const runtimeReads = vi.spyOn(rawRepository, "readAfter");
    const now = new Date().toISOString();
    for (let index = 0; index < 80; index++) {
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.message.assistant.delta",
          commandId: CommandId.makeUnsafe(`filtered-domain-telemetry-${index}`),
          threadId: ThreadId.makeUnsafe("thread-1"),
          messageId: MessageId.makeUnsafe("filtered-domain-assistant"),
          turnId: asTurnId("filtered-domain-turn"),
          delta: "unrelated progress",
          createdAt: now,
        }),
      );
      await Effect.runPromise(
        harness.runtimeEvents.append({
          type: "content.delta",
          eventId: EventId.makeUnsafe(`filtered-runtime-telemetry-${index}`),
          provider: "codex",
          threadId: ThreadId.makeUnsafe("thread-1"),
          turnId: asTurnId("filtered-domain-turn"),
          createdAt: now,
          payload: { streamKind: "assistant_text", delta: "unrelated progress" },
        }),
      );
    }
    await runtime!.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        // The checkpoint consumer owns only relevant events; ACK discovers raw
        // stored sequence identities without parsing unrelated payload bodies.
        yield* sql`UPDATE provider_runtime_events SET event_json = '{}' WHERE event_type = 'content.delta'`;
      }),
    );
    await Effect.runPromise(
      harness.runtimeEvents.append(
        nativeCompletion("filtered-page-terminal", ThreadId.makeUnsafe("thread-1")),
      ),
    );
    const drained = await Effect.runPromise(
      harness.reactor.drain.pipe(Effect.timeoutOption("3 seconds"), Effect.exit),
    );
    expect(Exit.isSuccess(drained)).toBe(true);
    expect(reads.mock.calls.length).toBeGreaterThan(0);
    expect(
      reads.mock.calls.every(
        ([, limit, , filter]) =>
          limit === 32 && filter?.eventTypes.includes("thread.checkpoint-revert-requested"),
      ),
    ).toBe(true);
    expect(
      runtimeReads.mock.calls.every(([request]) => request.checkpointRelevantOnly === true),
    ).toBe(true);
    const thread = (await Effect.runPromise(harness.engine.getReadModel())).threads.find(
      (entry) => entry.id === "thread-1",
    )!;
    expect(thread.checkpoints.some((entry) => entry.turnId === "filtered-page-terminal")).toBe(
      true,
    );
  });

  it("settles an accepted revert receipt with a crashed inflight claim before ACK", async () => {
    const harness = await createHarness({ startReactor: false });
    const threadId = ThreadId.makeUnsafe("thread-1");
    const now = new Date().toISOString();
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.checkpoint.revert",
        commandId: CommandId.makeUnsafe("receipt-revert-request"),
        threadId,
        turnCount: 0,
        scope: "thread",
        createdAt: now,
      }),
    );
    const events = await Effect.runPromise(Stream.runCollect(harness.engine.readEvents(0)));
    const request = events.find((event) => event.type === "thread.checkpoint-revert-requested")!;
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.revert.complete",
        commandId: CommandId.makeUnsafe(`server:checkpoint-revert-complete:${request.eventId}`),
        threadId,
        turnCount: 0,
        createdAt: now,
      }),
    );
    await runtime!.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO orchestration_consumer_state (consumer_name, last_acked_sequence, created_at, updated_at) VALUES ('checkpoint-reactor.domain.v1', 0, ${now}, ${now})`;
        yield* sql`INSERT INTO orchestration_consumer_state (consumer_name, last_acked_sequence, created_at, updated_at) VALUES ('checkpoint-reactor.domain-adoption.v1', 0, ${now}, ${now})`;
        yield* sql`INSERT INTO orchestration_event_deliveries (consumer_name, event_sequence, thread_id, state, claim_owner, claimed_at, claim_expires_at, attempt_count, last_error, completed_at, updated_at)
        VALUES ('checkpoint-reactor.domain.v1', ${request.sequence}, ${threadId}, 'inflight', 'crashed-revert-owner', ${now}, ${now}, 1, NULL, NULL, ${now})`;
      }),
    );
    const restore = vi.spyOn(harness.checkpointStore, "restoreCheckpoint");
    const reverse = vi.spyOn(harness.checkpointStore, "reverseCheckpointDiff");
    await harness.start();
    expect(
      Option.isSome(
        await Effect.runPromise(harness.reactor.drain.pipe(Effect.timeoutOption("500 millis"))),
      ),
    ).toBe(true);
    expect(restore).not.toHaveBeenCalled();
    expect(reverse).not.toHaveBeenCalled();
    const highWater = await Effect.runPromise(harness.engine.getEventHighWaterSequence);
    const cursor = await runtime!.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return yield* sql<{
          cursor: number;
        }>`SELECT last_acked_sequence AS cursor FROM orchestration_consumer_state WHERE consumer_name = 'checkpoint-reactor.domain.v1'`;
      }),
    );
    expect(cursor[0]?.cursor).toBe(highWater);
  });

  it("does not let historical claims below its adoption cursor pin new domain ACKs", async () => {
    const harness = await createHarness({ startReactor: false, seedFilesystemCheckpoints: false });
    const threadId = ThreadId.makeUnsafe("thread-1");
    const now = new Date().toISOString();
    const historical = (
      await Effect.runPromise(Stream.runCollect(harness.engine.readEvents(0)))
    ).find((event) => event.aggregateId === threadId)!;
    const highWater = await Effect.runPromise(harness.engine.getEventHighWaterSequence);
    await runtime!.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO orchestration_consumer_state (consumer_name, last_acked_sequence, created_at, updated_at) VALUES ('checkpoint-reactor.domain.v1', ${highWater}, ${now}, ${now})`;
        yield* sql`INSERT INTO orchestration_event_deliveries (consumer_name, event_sequence, thread_id, state, claim_owner, claimed_at, claim_expires_at, attempt_count, last_error, completed_at, updated_at)
        VALUES ('checkpoint-reactor.domain.v1', ${historical.sequence}, ${threadId}, 'inflight', 'historical-owner', ${now}, ${now}, 1, NULL, NULL, ${now})`;
      }),
    );
    await harness.start();
    await Effect.runPromise(
      harness.runtimeEvents.append(nativeCompletion("fresh-after-historical-claim", threadId)),
    );
    expect(
      Option.isSome(
        await Effect.runPromise(harness.reactor.drain.pipe(Effect.timeoutOption("1 second"))),
      ),
    ).toBe(true);
    const finalHighWater = await Effect.runPromise(harness.engine.getEventHighWaterSequence);
    const rows = await runtime!.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        return yield* sql<{
          cursor: number;
          state: string;
        }>`SELECT consumer.last_acked_sequence AS cursor, delivery.state FROM orchestration_consumer_state AS consumer JOIN orchestration_event_deliveries AS delivery ON delivery.consumer_name = consumer.consumer_name
        WHERE consumer.consumer_name = 'checkpoint-reactor.domain.v1' AND delivery.event_sequence = ${historical.sequence}`;
      }),
    );
    expect(rows[0]).toEqual({ cursor: finalHighWater, state: "inflight" });
  });

  it.each(["legacy revert", "retained native completion"] as const)(
    "settles a deleted thread's %s and stays alive after restart",
    async (kind) => {
      const harness = await createHarness({
        startReactor: false,
        seedFilesystemCheckpoints: false,
      });
      const deleted = ThreadId.makeUnsafe("thread-1");
      const now = new Date().toISOString();
      if (kind === "legacy revert") {
        await Effect.runPromise(
          harness.engine.dispatch({
            type: "thread.checkpoint.revert",
            commandId: CommandId.makeUnsafe("deleted-legacy-revert"),
            threadId: deleted,
            turnCount: 0,
            scope: "thread",
            createdAt: now,
          }),
        );
        await Effect.runPromise(
          harness.engine.dispatch({
            type: "thread.activity.append",
            commandId: CommandId.makeUnsafe("deleted-legacy-failure"),
            threadId: deleted,
            activity: {
              id: EventId.makeUnsafe("deleted-legacy-failure"),
              kind: "checkpoint.revert.failed",
              tone: "error",
              summary: "Checkpoint revert failed",
              payload: { turnCount: 0, detail: "Original failed revert" },
              turnId: null,
              createdAt: now,
            },
            createdAt: now,
          }),
        );
      } else {
        const row = await Effect.runPromise(
          harness.runtimeEvents.append(nativeCompletion("deleted-native-tail", deleted)),
        );
        await Effect.runPromise(
          harness.runtimeEvents.advanceConsumerCursor({
            consumerName: PROVIDER_RUNTIME_INGESTION_CONSUMER,
            eventSequence: row.sequence,
            updatedAt: now,
          }),
        );
      }
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.delete",
          commandId: CommandId.makeUnsafe("delete-checkpoint-history"),
          threadId: deleted,
        }),
      );
      const peerCwd = createGitRepository();
      tempDirs.push(peerCwd);
      const peer = await addCheckpointThread(harness, "deleted-history-peer", peerCwd);
      await harness.start();
      await settleCheckpointWork(harness.reactor.drain);
      const restarted = await restartCheckpointReactor();
      await Effect.runPromise(
        harness.runtimeEvents.append(nativeCompletion("peer-after-deleted-restart", peer)),
      );
      await settleCheckpointWork(restarted.drain);
      expect(gitRefExists(peerCwd, checkpointRefForThreadTurn(peer, 1))).toBe(true);
    },
  );

  it.each(["failed revert", "non-git completion", "undone completion"] as const)(
    "adopts accepted legacy %s history silently",
    async (kind) => {
      const harness = await createHarness({
        startReactor: false,
        seedFilesystemCheckpoints: false,
      });
      const threadId = ThreadId.makeUnsafe("thread-1");
      const now = new Date().toISOString();
      if (kind === "failed revert") {
        await Effect.runPromise(
          harness.engine.dispatch({
            type: "thread.checkpoint.revert",
            commandId: CommandId.makeUnsafe("resolved-old-revert"),
            threadId,
            turnCount: 0,
            scope: "thread",
            createdAt: now,
          }),
        );
        await Effect.runPromise(
          harness.engine.dispatch({
            type: "thread.activity.append",
            commandId: CommandId.makeUnsafe("resolved-old-revert-failure"),
            threadId,
            activity: {
              id: EventId.makeUnsafe("resolved-old-revert-failure"),
              kind: "checkpoint.revert.failed",
              tone: "error",
              summary: "Checkpoint revert failed",
              payload: { turnCount: 0, detail: "Already reported" },
              turnId: null,
              createdAt: now,
            },
            createdAt: now,
          }),
        );
      } else {
        const turnId = asTurnId("accepted-old-turn");
        if (kind === "undone completion") {
          await Effect.runPromise(
            harness.engine.dispatch({
              type: "thread.turn.diff.complete",
              commandId: CommandId.makeUnsafe("accepted-old-diff"),
              threadId,
              turnId,
              completedAt: now,
              checkpointRef: checkpointRefForThreadTurn(threadId, 1),
              status: "ready",
              files: [],
              checkpointTurnCount: 1,
              createdAt: now,
            }),
          );
          await Effect.runPromise(
            harness.engine.dispatch({
              type: "thread.revert.complete",
              commandId: CommandId.makeUnsafe("accepted-old-undo"),
              threadId,
              turnCount: 0,
              createdAt: now,
            }),
          );
        } else
          vi.spyOn(harness.checkpointStore, "isGitRepository").mockReturnValue(
            Effect.succeed(false),
          );
        const row = await Effect.runPromise(
          harness.runtimeEvents.append(nativeCompletion("accepted-old-native", threadId, turnId)),
        );
        await Effect.runPromise(
          harness.runtimeEvents.advanceConsumerCursor({
            consumerName: PROVIDER_RUNTIME_INGESTION_CONSUMER,
            eventSequence: row.sequence,
            updatedAt: now,
          }),
        );
      }
      const before = (await Effect.runPromise(harness.engine.getReadModel())).threads.find(
        (t) => t.id === threadId,
      )!.activities;
      const capture = vi.spyOn(harness.checkpointStore, "captureCheckpoint");
      const restore = vi.spyOn(harness.checkpointStore, "restoreCheckpoint");
      await harness.start();
      await settleCheckpointWork(harness.reactor.drain);
      const restarted = await restartCheckpointReactor();
      await settleCheckpointWork(restarted.drain);
      const after = (await Effect.runPromise(harness.engine.getReadModel())).threads.find(
        (t) => t.id === threadId,
      )!.activities;
      expect(after).toEqual(before);
      expect(capture).not.toHaveBeenCalled();
      expect(restore).not.toHaveBeenCalled();
    },
  );

  it.each(["timeout", "SQLITE_BUSY"] as const)(
    "keeps pending checkpoint work recoverable after a transient %s lookup",
    async (failure) => {
      const harness = await createHarness({ seedFilesystemCheckpoints: false });
      await harness.drain();
      const query = await runtime!.runPromise(Effect.service(ProjectionSnapshotQuery));
      const original = query.getThreadDetailById;
      // The admission lookup and the first recovery retry both exceed the
      // 200 ms admission budget; a later retry must still adopt the range.
      let delayed = failure === "timeout" ? 2 : 1;
      vi.spyOn(query, "getThreadDetailById").mockImplementation((id) => {
        if (id !== "thread-1" || delayed === 0) return original(id);
        delayed--;
        return failure === "timeout"
          ? Effect.sleep("250 millis").pipe(Effect.andThen(original(id)))
          : Effect.fail(
              new PersistenceSqlError({
                operation: "transient-checkpoint-read",
                detail: "Database temporarily busy",
                cause: { code: "SQLITE_BUSY" },
              }),
            );
      });
      await Effect.runPromise(
        harness.runtimeEvents.append(
          nativeCompletion(`transient-${failure}`, ThreadId.makeUnsafe("thread-1")),
        ),
      );
      await settleCheckpointWork(harness.reactor.drain);
      expect(
        gitRefExists(harness.cwd, checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 1)),
      ).toBe(true);
      const thread = (await Effect.runPromise(harness.engine.getReadModel())).threads.find(
        (t) => t.id === "thread-1",
      )!;
      expect(thread.activities.some((a) => a.kind === "checkpoint.capture.failed")).toBe(false);
    },
  );

  it("caches non-Git workspace identity across native rows and lane scans", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "synara-negative-checkpoint-"));
    tempDirs.push(cwd);
    const harness = await createHarness({
      seedFilesystemCheckpoints: false,
      projectWorkspaceRoot: cwd,
      threadWorktreePath: cwd,
      providerSessionCwd: cwd,
    });
    await harness.drain();
    // Pin the TTL clock so the cache window does not depend on test speed.
    let now = Date.now();
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    const classify = vi.spyOn(projectImportPaths, "canonicalImportPath");
    const startTurn = async (index: number) => {
      await Effect.runPromise(
        harness.runtimeEvents.append({
          type: "turn.started",
          eventId: EventId.makeUnsafe(`negative-start-${index}`),
          provider: "codex",
          threadId: ThreadId.makeUnsafe("thread-1"),
          turnId: asTurnId(`negative-turn-${index}`),
          createdAt: new Date().toISOString(),
          payload: {},
        }),
      );
      await settleCheckpointWork(harness.reactor.drain);
    };
    try {
      for (let index = 0; index < 5; index++) await startTurn(index);
      expect(classify.mock.calls).toHaveLength(1);
      // After the negative TTL a turn may have initialized Git: reclassify.
      now += 1_001;
      await startTurn(5);
      expect(classify.mock.calls).toHaveLength(2);
    } finally {
      classify.mockRestore();
      clock.mockRestore();
    }
  });

  it("batches checkpoint ACKs during a persisted text stream and flushes drain", async () => {
    const harness = await createHarness({ startReactor: false, seedFilesystemCheckpoints: false });
    const bus = Effect.runSync(
      PubSub.unbounded<
        import("../../persistence/Services/ProviderRuntimeEvents.ts").PersistedProviderRuntimeEvent
      >(),
    );
    Object.assign(harness.provider.service, { streamPersistedEvents: Stream.fromPubSub(bus) });
    await harness.start();
    await harness.drain();
    const acks = vi.spyOn(harness.runtimeEvents, "advanceConsumerCursorThrough");
    const started = performance.now();
    let lastSequence = 0;
    for (let index = 0; index < 256; index++) {
      const row = await Effect.runPromise(
        harness.runtimeEvents.append({
          type: "content.delta",
          eventId: EventId.makeUnsafe(`stream-ack-${index}`),
          provider: "codex",
          threadId: ThreadId.makeUnsafe("thread-1"),
          turnId: asTurnId("stream-ack-turn"),
          createdAt: new Date().toISOString(),
          payload: { streamKind: "assistant_text", delta: "x" },
        }),
      );
      lastSequence = row.sequence;
      await Effect.runPromise(PubSub.publish(bus, row));
      await Effect.runPromise(Effect.sleep("1 millis"));
    }
    await settleCheckpointWork(harness.reactor.drain);
    const checkpointAcks = acks.mock.calls.filter(
      ([input]) => input.consumerName === CHECKPOINT_RUNTIME_CONSUMER,
    ).length;
    acks.mockRestore();
    process.stderr.write(
      `checkpoint-stream-benchmark ${JSON.stringify({ rows: 256, elapsedMs: Math.round(performance.now() - started), checkpointAcks })}\n`,
    );
    // Drain flushes the coalesced tail; a streaming burst does not pay one
    // ACK transaction per persisted text row.
    expect(
      await Effect.runPromise(harness.runtimeEvents.getConsumerCursor(CHECKPOINT_RUNTIME_CONSUMER)),
    ).toBe(lastSequence);
    expect(checkpointAcks).toBeLessThan(64);
  });

  it("retains physical workspace identity across ordinary domain outcomes", async () => {
    const harness = await createHarness({ seedFilesystemCheckpoints: false });
    const identities = vi.spyOn(projectImportPaths, "canonicalImportPath");
    try {
      for (let index = 0; index < 3; index++) {
        const createdAt = new Date().toISOString();
        await Effect.runPromise(
          harness.engine.dispatch({
            type: "thread.session.set",
            commandId: CommandId.makeUnsafe(`cached-session-${index}`),
            threadId: ThreadId.makeUnsafe("thread-1"),
            session: {
              threadId: ThreadId.makeUnsafe("thread-1"),
              status: "ready",
              providerName: "codex",
              runtimeMode: "approval-required",
              activeTurnId: null,
              lastError: null,
              updatedAt: createdAt,
            },
            createdAt,
          }),
        );
        await Effect.runPromise(
          harness.runtimeEvents.append(
            nativeCompletion(`cached-workspace-${index}`, ThreadId.makeUnsafe("thread-1")),
          ),
        );
        await settleCheckpointWork(harness.reactor.drain);
      }
      // One classification is reused; ordinary accepted checkpoint/activity rows
      // cannot invalidate it and trigger another realpath/Git workspace scan.
      expect(identities.mock.calls).toHaveLength(1);
    } finally {
      identities.mockRestore();
    }
  });

  it("bounds active unavailable-workspace recovery while an independent peer advances", async () => {
    const harness = await createHarness({ seedFilesystemCheckpoints: false });
    const initialSessions = harness.provider.service.listSessions;
    const secondCwd = createGitRepository();
    const thirdCwd = createGitRepository();
    tempDirs.push(secondCwd, thirdCwd);
    const unknown = [
      ThreadId.makeUnsafe("thread-1"),
      await addCheckpointThread(harness, "unavailable-second", secondCwd),
      await addCheckpointThread(harness, "unavailable-third", thirdCwd),
    ];
    const peerCwd = createGitRepository();
    tempDirs.push(peerCwd);
    const peer = await addCheckpointThread(harness, "unavailable-independent", peerCwd);
    vi.spyOn(harness.provider.service, "listSessions").mockImplementation(() =>
      initialSessions().pipe(
        Effect.map((entries) => [
          ...entries,
          ...[
            [unknown[1]!, secondCwd],
            [unknown[2]!, thirdCwd],
            [peer, peerCwd],
          ].map(
            ([id, cwd]) =>
              ({
                provider: "codex",
                status: "ready",
                runtimeMode: "full-access",
                threadId: ThreadId.makeUnsafe(id!),
                cwd: cwd!,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              }) satisfies ProviderSession,
          ),
        ]),
      ),
    );
    await harness.drain();
    const query = await runtime!.runPromise(Effect.service(ProjectionSnapshotQuery));
    const originalDetail = query.getThreadDetailById;
    const attempts = new Map<string, number>();
    const release = Deferred.makeUnsafe<void>();
    const twoStarted = Deferred.makeUnsafe<void>();
    const peerCaptured = Deferred.makeUnsafe<void>();
    let active = 0;
    let peak = 0;
    const detail = vi.spyOn(query, "getThreadDetailById").mockImplementation((id) => {
      if (!unknown.includes(id)) return originalDetail(id);
      const attempt = (attempts.get(id) ?? 0) + 1;
      attempts.set(id, attempt);
      if (attempt === 1)
        return Effect.fail(
          new PersistenceSqlError({
            operation: "recovery-admission-test",
            detail: "workspace access denied",
            cause: { code: "EACCES" },
          }),
        );
      return Effect.sync(() => {
        active++;
        peak = Math.max(peak, active);
      }).pipe(
        Effect.andThen(
          Effect.suspend(() =>
            active >= 2 ? Deferred.succeed(twoStarted, undefined) : Effect.void,
          ),
        ),
        Effect.andThen(Deferred.await(release)),
        Effect.andThen(originalDetail(id)),
        Effect.ensuring(
          Effect.sync(() => {
            active--;
          }),
        ),
      );
    });
    const originalCapture = harness.checkpointStore.captureCheckpoint;
    vi.spyOn(harness.checkpointStore, "captureCheckpoint").mockImplementation((input) =>
      originalCapture(input).pipe(
        Effect.tap(() =>
          input.cwd === fs.realpathSync(peerCwd)
            ? Deferred.succeed(peerCaptured, undefined)
            : Effect.void,
        ),
      ),
    );
    try {
      for (const id of unknown)
        await Effect.runPromise(
          harness.runtimeEvents.append(nativeCompletion(`unavailable-budget-${id}`, id)),
        );
      await Effect.runPromise(
        harness.runtimeEvents.append(nativeCompletion("unavailable-budget-peer", peer)),
      );
      expect(
        Option.isSome(
          await Effect.runPromise(
            Deferred.await(twoStarted).pipe(Effect.timeoutOption("1 second")),
          ),
        ),
      ).toBe(true);
      expect(
        Option.isSome(
          await Effect.runPromise(
            Deferred.await(peerCaptured).pipe(Effect.timeoutOption("1 second")),
          ),
        ),
      ).toBe(true);
      await Effect.runPromise(Effect.sleep("100 millis"));
      expect(peak).toBe(2);
    } finally {
      await Effect.runPromise(Deferred.succeed(release, undefined));
      await settleCheckpointWork(harness.reactor.drain);
      detail.mockRestore();
    }
    expect(peak).toBe(2);
  });

  it("isolates unavailable pre-mutation workspace resolution and settles it without late capture", async () => {
    const harness = await createHarness({ seedFilesystemCheckpoints: false });
    const otherCwd = createGitRepository();
    tempDirs.push(otherCwd);
    const otherThread = await addCheckpointThread(harness, "resolution-independent", otherCwd);
    await harness.drain();
    const query = await runtime!.runPromise(Effect.service(ProjectionSnapshotQuery));
    const originalDetail = query.getThreadDetailById;
    const detail = vi.spyOn(query, "getThreadDetailById").mockImplementation((id) =>
      id === "thread-1"
        ? Effect.fail(
            new PersistenceSqlError({
              operation: "resolution-test",
              detail: "workspace access denied",
              cause: { code: "EACCES" },
            }),
          )
        : originalDetail(id),
    );
    const peerCaptured = Deferred.makeUnsafe<void>();
    const originalCapture = harness.checkpointStore.captureCheckpoint;
    const capture = vi
      .spyOn(harness.checkpointStore, "captureCheckpoint")
      .mockImplementation((input) =>
        originalCapture(input).pipe(
          Effect.tap(() =>
            input.cwd === fs.realpathSync(otherCwd)
              ? Deferred.succeed(peerCaptured, undefined)
              : Effect.void,
          ),
        ),
      );
    try {
      await Effect.runPromise(
        harness.runtimeEvents.append(
          nativeCompletion("resolution-unavailable", ThreadId.makeUnsafe("thread-1")),
        ),
      );
      await Effect.runPromise(
        harness.runtimeEvents.append(nativeCompletion("resolution-peer", otherThread)),
      );
      expect(
        Option.isSome(
          await Effect.runPromise(
            Deferred.await(peerCaptured).pipe(Effect.timeoutOption("1 second")),
          ),
        ),
      ).toBe(true);
      await settleCheckpointWork(harness.reactor.drain);
      expect(capture.mock.calls.every(([input]) => input.cwd === fs.realpathSync(otherCwd))).toBe(
        true,
      );
      const delivery = await runtime!.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return yield* sql<{
            state: string;
          }>`SELECT state FROM orchestration_event_deliveries WHERE consumer_name = 'checkpoint-reactor.runtime-outcomes.v1' AND thread_id = 'thread-1'`;
        }),
      );
      // A settled native uncertainty may be pruned after ACK; its stable failure
      // receipt/activity remains the durable recovery evidence.
      expect(delivery.every((row) => row.state === "uncertain")).toBe(true);
      const thread = (await Effect.runPromise(harness.engine.getReadModel())).threads.find(
        (entry) => entry.id === "thread-1",
      )!;
      expect(thread.activities.some((entry) => entry.kind === "checkpoint.capture.failed")).toBe(
        true,
      );
      detail.mockRestore();
      await Effect.runPromise(
        harness.runtimeEvents.append(
          nativeCompletion("resolution-fresh-recovered", ThreadId.makeUnsafe("thread-1")),
        ),
      );
      await settleCheckpointWork(harness.reactor.drain);
      expect(capture.mock.calls.some(([input]) => input.cwd === fs.realpathSync(harness.cwd))).toBe(
        true,
      );
    } finally {
      detail.mockRestore();
    }
  });

  it.each(["native completion", "revert"] as const)(
    "settles an unknown alias %s without a late mutation after its peer advances",
    async (operation) => {
      const peerCwd = createGitRepository();
      tempDirs.push(peerCwd);
      const harness = await createHarness({
        hasSession: false,
        threadWorktreePath: peerCwd,
        seedFilesystemCheckpoints: false,
      });
      const threadId = ThreadId.makeUnsafe("thread-1");
      const peerThread = await addCheckpointThread(harness, "unknown-alias-peer", peerCwd);
      const now = new Date().toISOString();
      await harness.drain();
      const peerCaptured = Deferred.makeUnsafe<void>();
      const aliasResolved = Deferred.makeUnsafe<void>();
      const query = await runtime!.runPromise(Effect.service(ProjectionSnapshotQuery));
      const originalDetail = query.getThreadDetailById;
      let firstFailure = true;
      const detail = vi.spyOn(query, "getThreadDetailById").mockImplementation((id) => {
        if (id !== threadId) return originalDetail(id);
        if (firstFailure) {
          firstFailure = false;
          return Effect.fail(
            new PersistenceSqlError({
              operation: "unknown-alias-test",
              detail: "identity unavailable before mutation",
            }),
          );
        }
        return Deferred.await(peerCaptured).pipe(
          Effect.andThen(originalDetail(id)),
          Effect.tap(() => Deferred.succeed(aliasResolved, undefined)),
        );
      });
      const originalCapture = harness.checkpointStore.captureCheckpoint;
      const capture = vi
        .spyOn(harness.checkpointStore, "captureCheckpoint")
        .mockImplementation((input) =>
          originalCapture(input).pipe(Effect.tap(() => Deferred.succeed(peerCaptured, undefined))),
        );
      const restore = vi.spyOn(harness.checkpointStore, "restoreCheckpoint");
      const reverse = vi.spyOn(harness.checkpointStore, "reverseCheckpointDiff");
      try {
        if (operation === "native completion") {
          await Effect.runPromise(
            harness.runtimeEvents.append(nativeCompletion("unknown-alias-pending", threadId)),
          );
        } else {
          await Effect.runPromise(
            harness.engine.dispatch({
              type: "thread.checkpoint.revert",
              commandId: CommandId.makeUnsafe("unknown-alias-pending-revert"),
              threadId,
              turnCount: 0,
              scope: "thread",
              createdAt: now,
            }),
          );
        }
        await Effect.runPromise(
          harness.runtimeEvents.append(
            nativeCompletion("unknown-alias-peer-completed", peerThread),
          ),
        );
        expect(
          Option.isSome(
            await Effect.runPromise(
              Deferred.await(peerCaptured).pipe(Effect.timeoutOption("1 second")),
            ),
          ),
        ).toBe(true);
        await settleCheckpointWork(harness.reactor.drain);
        expect(
          Option.isSome(
            await Effect.runPromise(
              Deferred.await(aliasResolved).pipe(Effect.timeoutOption("500 millis")),
            ),
          ),
        ).toBe(true);
        const pendingThreadPrefix = `${checkpointRefForThreadTurn(threadId, 0).split("/turn/")[0]}/`;
        expect(
          capture.mock.calls.some(([input]) => input.checkpointRef.startsWith(pendingThreadPrefix)),
        ).toBe(false);
        expect(restore).not.toHaveBeenCalled();
        expect(reverse).not.toHaveBeenCalled();
        const thread = (await Effect.runPromise(harness.engine.getReadModel())).threads.find(
          (entry) => entry.id === threadId,
        )!;
        expect(
          thread.activities.some(
            (entry) =>
              entry.kind ===
              (operation === "revert" ? "checkpoint.revert.failed" : "checkpoint.capture.failed"),
          ),
        ).toBe(true);
      } finally {
        await Effect.runPromise(Deferred.succeed(peerCaptured, undefined));
        await Effect.runPromise(Deferred.succeed(aliasResolved, undefined));
        detail.mockRestore();
      }
    },
  );

  it("settles unadmitted journal rows through the recovery cut before allowing future alias work", async () => {
    const harness = await createHarness({ hasSession: false, seedFilesystemCheckpoints: false });
    const threadId = ThreadId.makeUnsafe("thread-1");
    const aliasDir = fs.mkdtempSync(path.join(os.tmpdir(), "synara-recovery-cut-alias-"));
    tempDirs.push(aliasDir);
    const alias = path.join(aliasDir, "workspace");
    fs.symlinkSync(harness.cwd, alias, "dir");
    const peer = await addCheckpointThread(harness, "recovery-cut-peer", alias);
    await Effect.runPromise(
      harness.checkpointStore.captureCheckpoint({
        cwd: harness.cwd,
        checkpointRef: checkpointRefForThreadTurn(peer, 0),
      }),
    );
    await harness.prepareBaseline(asTurnId("recovery-cut-future"));
    await harness.drain();
    fs.writeFileSync(path.join(harness.cwd, "README.md"), "peer edit before Undo\n");

    const retryStarted = Deferred.makeUnsafe<void>();
    const releaseRetry = Deferred.makeUnsafe<void>();
    const readerStarted = Deferred.makeUnsafe<void>();
    const releaseReader = Deferred.makeUnsafe<void>();
    const query = await runtime!.runPromise(Effect.service(ProjectionSnapshotQuery));
    const originalDetail = query.getThreadDetailById;
    let initialFailure = true;
    const detail = vi.spyOn(query, "getThreadDetailById").mockImplementation((id) => {
      if (id !== threadId) return originalDetail(id);
      if (initialFailure) {
        initialFailure = false;
        return Effect.fail(
          new PersistenceSqlError({
            operation: "recovery-cut-test",
            detail: "unknown alias before admission",
          }),
        );
      }
      return Deferred.succeed(retryStarted, undefined).pipe(
        Effect.andThen(Deferred.await(releaseRetry)),
        Effect.andThen(originalDetail(id)),
      );
    });
    const repository = await runtime!.runPromise(Effect.service(ProviderRuntimeEventRepository));
    const originalRead = repository.readAfter;
    let heldSequence = Number.POSITIVE_INFINITY;
    const reads = vi
      .spyOn(repository, "readAfter")
      .mockImplementation((input) =>
        input.sequenceExclusive >= heldSequence
          ? Deferred.succeed(readerStarted, undefined).pipe(
              Effect.andThen(Deferred.await(releaseReader)),
              Effect.andThen(originalRead(input)),
            )
          : originalRead(input),
      );
    const capture = vi.spyOn(harness.checkpointStore, "captureCheckpoint");
    const restore = vi.spyOn(harness.checkpointStore, "restoreCheckpoint");
    const awaitGate = async (gate: Deferred.Deferred<void>) =>
      expect(
        Option.isSome(
          await Effect.runPromise(Deferred.await(gate).pipe(Effect.timeoutOption("1 second"))),
        ),
      ).toBe(true);
    try {
      const initialEvent = nativeCompletion("recovery-cut-initial", threadId);
      const initial = await Effect.runPromise(harness.runtimeEvents.append(initialEvent));
      await Effect.runPromise(harness.provider.publish(initialEvent));
      await awaitGate(retryStarted);
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.checkpoint.revert",
          commandId: CommandId.makeUnsafe("recovery-cut-peer-undo"),
          threadId: peer,
          turnCount: 0,
          scope: "thread",
          createdAt: new Date().toISOString(),
        }),
      );
      await waitForEvent(
        harness.engine,
        (event) => event.type === "thread.reverted" && event.aggregateId === peer,
        1000,
      );
      expect(restore).toHaveBeenCalled();
      expect(fs.readFileSync(path.join(harness.cwd, "README.md"), "utf8")).toBe("v1\n");

      // The peer has advanced this physical workspace while its alias is still
      // unknown. Keep the source reader behind the old head: the next turn is
      // durable before resolution, but has never passed selectWorkspace.
      heldSequence = initial.sequence;
      const duringLookupEvent = nativeCompletion("recovery-cut-unadmitted", threadId);
      const duringLookup = await Effect.runPromise(harness.runtimeEvents.append(duringLookupEvent));
      await Effect.runPromise(harness.provider.publish(duringLookupEvent));
      await awaitGate(readerStarted);
      await Effect.runPromise(Deferred.succeed(releaseRetry, undefined));

      // The old head can be ACKed only after recovery removes its pin. Keep the
      // newer reader gated so the new row's settlement must come from recovery.
      let cursor = 0;
      for (let attempt = 0; attempt < 100 && cursor < initial.sequence; attempt++) {
        cursor = await Effect.runPromise(repository.getConsumerCursor(CHECKPOINT_RUNTIME_CONSUMER));
        if (cursor < initial.sequence) await Effect.runPromise(Effect.sleep("10 millis"));
      }
      expect(cursor).toBe(initial.sequence);
      const outcome = await runtime!.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return yield* sql<{ state: string }>`SELECT state FROM orchestration_event_deliveries
            WHERE consumer_name = 'checkpoint-reactor.runtime-outcomes.v1'
              AND event_sequence = ${duringLookup.sequence} AND thread_id = ${threadId}`;
        }),
      );
      expect(outcome.map((row) => row.state)).toEqual(["uncertain"]);
      await Effect.runPromise(Deferred.succeed(releaseReader, undefined));
      await settleCheckpointWork(harness.reactor.drain);
      const aliasPrefix = `${checkpointRefForThreadTurn(threadId, 0).split("/turn/")[0]}/`;
      expect(
        capture.mock.calls.some(([input]) => input.checkpointRef.startsWith(aliasPrefix)),
      ).toBe(false);
      expect(gitRefExists(harness.cwd, checkpointRefForThreadTurn(threadId, 1))).toBe(false);

      // A finite cut must not mark future turns unavailable indefinitely.
      await Effect.runPromise(
        harness.provider.publish(nativeCompletion("recovery-cut-future", threadId)),
      );
      await settleCheckpointWork(harness.reactor.drain);
      expect(
        capture.mock.calls.some(([input]) => input.checkpointRef.startsWith(aliasPrefix)),
      ).toBe(true);
      const thread = (await Effect.runPromise(harness.engine.getReadModel())).threads.find(
        (entry) => entry.id === threadId,
      )!;
      expect(thread.checkpoints.some((entry) => entry.turnId === "recovery-cut-future")).toBe(true);
    } finally {
      await Effect.runPromise(Deferred.succeed(releaseRetry, undefined));
      await Effect.runPromise(Deferred.succeed(releaseReader, undefined));
      detail.mockRestore();
      reads.mockRestore();
      await settleCheckpointWork(harness.reactor.drain);
    }
  });

  it("discards a staged recovery identity when workspace metadata changes during the durable cut", async () => {
    const harness = await createHarness({ hasSession: false, seedFilesystemCheckpoints: false });
    const threadId = ThreadId.makeUnsafe("thread-1");
    const nextCwd = createGitRepository();
    const observerCwd = createGitRepository();
    tempDirs.push(nextCwd, observerCwd);
    const observerThread = await addCheckpointThread(
      harness,
      "recovery-config-observer",
      observerCwd,
    );
    await harness.drain();
    const cutReached = Deferred.makeUnsafe<void>();
    const releaseCut = Deferred.makeUnsafe<void>();
    const metadataObserved = Deferred.makeUnsafe<void>();
    const sql = await runtime!.runPromise(Effect.service(SqlClient.SqlClient));
    const originalTransaction = sql.withTransaction;
    const transaction = vi
      .spyOn(sql, "withTransaction")
      .mockImplementation((effect) =>
        originalTransaction(effect).pipe(
          Effect.tap((rows) =>
            Array.isArray(rows) &&
            rows.length === 1 &&
            rows[0] !== null &&
            typeof rows[0] === "object" &&
            "runtimeSequence" in rows[0] &&
            "domainSequence" in rows[0]
              ? Deferred.succeed(cutReached, undefined).pipe(
                  Effect.andThen(Deferred.await(releaseCut)),
                )
              : Effect.void,
          ),
        ),
      );
    const query = await runtime!.runPromise(Effect.service(ProjectionSnapshotQuery));
    const originalDetail = query.getThreadDetailById;
    let initialFailure = true;
    const detail = vi.spyOn(query, "getThreadDetailById").mockImplementation((id) => {
      if (id === observerThread)
        return Deferred.succeed(metadataObserved, undefined).pipe(
          Effect.andThen(originalDetail(id)),
        );
      if (id === threadId && initialFailure) {
        initialFailure = false;
        return Effect.fail(
          new PersistenceSqlError({
            operation: "recovery-config-test",
            detail: "unknown identity",
            cause: { code: "ENOENT" },
          }),
        );
      }
      return originalDetail(id);
    });
    const capture = vi.spyOn(harness.checkpointStore, "captureCheckpoint");
    const awaitGate = async (gate: Deferred.Deferred<void>) =>
      expect(
        Option.isSome(
          await Effect.runPromise(Deferred.await(gate).pipe(Effect.timeoutOption("1 second"))),
        ),
      ).toBe(true);
    try {
      await Effect.runPromise(
        harness.provider.publish(nativeCompletion("recovery-config-initial", threadId)),
      );
      await awaitGate(cutReached);
      // Gate after the atomic SQL read commits, so the Engine can commit the
      // metadata change while recovery has W1 staged but has not published it.
      await Effect.runPromise(
        harness.sourceEngine.dispatch({
          type: "thread.meta.update",
          commandId: CommandId.makeUnsafe("recovery-config-move"),
          threadId,
          worktreePath: nextCwd,
        }),
      );
      await Effect.runPromise(
        harness.sourceEngine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.makeUnsafe("recovery-config-observer-start"),
          threadId: observerThread,
          message: {
            messageId: MessageId.makeUnsafe("recovery-config-observer-message"),
            role: "user",
            text: "Observe the preceding workspace update",
            attachments: [],
          },
          runtimeMode: "approval-required",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          createdAt: new Date().toISOString(),
        }),
      );
      // Admission of this later domain row proves the CP reader observed the
      // metadata update before the staged identity is allowed to publish.
      await awaitGate(metadataObserved);
      await Effect.runPromise(Deferred.succeed(releaseCut, undefined));
      await settleCheckpointWork(harness.reactor.drain);
      expect(capture).not.toHaveBeenCalled();
      await Effect.runPromise(
        harness.provider.publish(nativeCompletion("recovery-config-future", threadId)),
      );
      await settleCheckpointWork(harness.reactor.drain);
      expect(capture.mock.calls.map(([input]) => input.cwd)).toEqual([fs.realpathSync(nextCwd)]);
    } finally {
      await Effect.runPromise(Deferred.succeed(releaseCut, undefined));
      transaction.mockRestore();
      detail.mockRestore();
      await settleCheckpointWork(harness.reactor.drain);
    }
  });

  it("drains native checkpoints without querying every telemetry row or leasing assistant deltas", async () => {
    const harness = await createHarness({ startReactor: false, seedFilesystemCheckpoints: false });
    const repository = await runtime!.runPromise(Effect.service(ProviderRuntimeEventRepository));
    const coordinator = await runtime!.runPromise(Effect.service(TurnCheckpointCoordinator));
    const runtimeReads = vi.spyOn(repository, "readAfter");
    const leases = vi.spyOn(coordinator, "withWorkspaceIdentityLease");
    const threadId = ThreadId.makeUnsafe("thread-1");
    const turnId = asTurnId("checkpoint-telemetry-budget");
    const now = new Date().toISOString();
    await Effect.runPromise(
      Effect.gen(function* () {
        for (let index = 0; index < 2048; index++) {
          yield* harness.runtimeEvents.append({
            type: "content.delta",
            eventId: EventId.makeUnsafe(`checkpoint-telemetry-${index}`),
            provider: "codex",
            threadId,
            turnId,
            createdAt: now,
            payload: { streamKind: "assistant_text", delta: "Streaming text" },
          });
        }
        for (let index = 0; index < 64; index++) {
          yield* harness.engine.dispatch({
            type: "thread.message.assistant.delta",
            commandId: CommandId.makeUnsafe(`checkpoint-assistant-delta-${index}`),
            threadId,
            messageId: MessageId.makeUnsafe("checkpoint-budget-assistant"),
            turnId,
            delta: "Streaming text",
            createdAt: now,
          });
        }
      }),
    );
    await harness.start();
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* harness.runtimeEvents.append({
          type: "turn.completed",
          eventId: EventId.makeUnsafe("checkpoint-budget-terminal"),
          provider: "codex",
          threadId,
          turnId,
          createdAt: now,
          payload: { state: "completed" },
        });
      }),
    );
    await harness.drain();
    expect(gitRefExists(harness.cwd, checkpointRefForThreadTurn(threadId, 1))).toBe(true);
    const thread = (await Effect.runPromise(harness.engine.getReadModel())).threads.find(
      (entry) => entry.id === threadId,
    );
    expect(thread?.checkpoints.some((checkpoint) => checkpoint.turnId === turnId)).toBe(true);
    // Filtered checkpoint pages and stored-sequence ACKs never decode raw
    // telemetry bodies or execute a query for every telemetry row.
    expect(runtimeReads.mock.calls.length).toBeLessThan(100);
    const heads = runtimeReads.mock.calls.filter(([request]) => request.limit === 1);
    expect(heads.length).toBeLessThan(8);
    expect(heads.every(([request]) => request.checkpointRelevantOnly)).toBe(true);
    expect(leases.mock.calls.length).toBeLessThan(8);
  });

  it("bounds checkpoint heads and source pages before durable event decoding", async () => {
    const harness = await createHarness({ startReactor: false, seedFilesystemCheckpoints: false });
    const eventStore = await runtime!.runPromise(Effect.service(OrchestrationEventStore));
    const reads = vi.spyOn(eventStore, "readFromSequence");
    const sourceRuntimeEvents = await runtime!.runPromise(
      Effect.service(ProviderRuntimeEventRepository),
    );
    const runtimeReads = vi.spyOn(sourceRuntimeEvents, "readAfter");
    const threadId = ThreadId.makeUnsafe("thread-1");
    const turnId = asTurnId("bounded-checkpoint-head");
    await harness.start();
    await Effect.runPromise(
      harness.runtimeEvents.append({
        type: "turn.completed",
        eventId: EventId.makeUnsafe("bounded-checkpoint-head-event"),
        provider: "codex",
        createdAt: new Date().toISOString(),
        threadId,
        turnId,
        payload: { state: "completed" },
      }),
    );
    await harness.drain();

    const limits = reads.mock.calls.map(([, limit]) => limit);
    expect(limits).toEqual(expect.arrayContaining([32]));
    expect(limits.every((limit) => limit === 32)).toBe(true);
    const runtimeLimits = runtimeReads.mock.calls.map(([request]) => request.limit);
    expect(runtimeLimits).toEqual(expect.arrayContaining([32]));
    expect(runtimeLimits.every((limit) => limit === 32)).toBe(true);
    expect(gitRefExists(harness.cwd, checkpointRefForThreadTurn(threadId, 1))).toBe(true);
    const thread = (await Effect.runPromise(harness.engine.getReadModel())).threads.find(
      (entry) => entry.id === threadId,
    );
    expect(thread?.checkpoints.some((checkpoint) => checkpoint.turnId === turnId)).toBe(true);
  });

  it.each([
    {
      label: "a full bounded provider publication buffer",
      count: 2600,
      capacity: 2048,
      recovery: false,
    },
    {
      label: "more than one worker capacity of queued checkpoint work",
      count: 300,
      capacity: undefined,
      recovery: false,
    },
    {
      label: "fresh checkpoint work after historical startup adoption",
      count: 0,
      capacity: undefined,
      recovery: true,
    },
  ])(
    "keeps unrelated workspace checkpoints flowing behind $label",
    async ({ count, capacity, recovery }) => {
      const harness = await createHarness({
        ...(capacity === undefined ? {} : { runtimeEventCapacity: capacity }),
        startReactor: !recovery,
      });
      const otherCwd = createGitRepository();
      tempDirs.push(otherCwd);
      const now = new Date().toISOString();
      const otherThread = ThreadId.makeUnsafe("checkpoint-independent");
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "project.create",
          commandId: CommandId.makeUnsafe("checkpoint-independent-project"),
          projectId: asProjectId("checkpoint-independent-project"),
          title: "Independent",
          workspaceRoot: otherCwd,
          defaultModelSelection: { provider: "codex", model: "gpt-5-codex" },
          createdAt: now,
        }),
      );
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.create",
          commandId: CommandId.makeUnsafe("checkpoint-independent-thread"),
          threadId: otherThread,
          projectId: asProjectId("checkpoint-independent-project"),
          title: "Independent",
          modelSelection: { provider: "codex", model: "gpt-5-codex" },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: otherCwd,
          createdAt: now,
        }),
      );
      const originalSessions = harness.provider.service.listSessions;
      vi.spyOn(harness.provider.service, "listSessions").mockImplementation(() =>
        originalSessions().pipe(
          Effect.map((sessions) => [
            ...sessions,
            {
              provider: "codex",
              status: "ready",
              runtimeMode: "full-access",
              threadId: otherThread,
              cwd: otherCwd,
              createdAt: now,
              updatedAt: now,
            } satisfies ProviderSession,
          ]),
        ),
      );
      const captureStarted = Deferred.makeUnsafe<void>();
      const releaseCapture = Deferred.makeUnsafe<void>();
      const independentCaptured = Deferred.makeUnsafe<void>();
      const captureCheckpoint = harness.checkpointStore.captureCheckpoint;
      let firstCapture = true;
      vi.spyOn(harness.checkpointStore, "captureCheckpoint").mockImplementation((input) => {
        if (input.cwd === fs.realpathSync(harness.cwd) && firstCapture) {
          firstCapture = false;
          return Deferred.succeed(captureStarted, undefined).pipe(
            Effect.andThen(Deferred.await(releaseCapture)),
            Effect.andThen(captureCheckpoint(input)),
          );
        }
        return captureCheckpoint(input).pipe(
          Effect.andThen(
            input.cwd === fs.realpathSync(otherCwd)
              ? Deferred.succeed(independentCaptured, undefined).pipe(Effect.asVoid)
              : Effect.void,
          ),
        );
      });
      const completion = (
        id: string,
        threadId = ThreadId.makeUnsafe("thread-1"),
      ): LegacyProviderRuntimeEvent => ({
        type: "turn.completed",
        eventId: EventId.makeUnsafe(id),
        provider: "codex",
        createdAt: now,
        threadId,
        turnId: asTurnId(threadId === otherThread ? "independent-turn" : "blocked-turn"),
        payload: { state: "completed" },
      });
      if (recovery) {
        await Effect.runPromise(
          harness.runtimeEvents.append({
            ...completion("checkpoint-recovered-first"),
            turnId: asTurnId("historical-startup-turn"),
          } as ProviderRuntimeEvent),
        );
        expect(
          Option.isSome(
            await Effect.runPromise(
              Effect.promise(harness.start).pipe(Effect.timeoutOption("500 millis")),
            ),
          ),
        ).toBe(true);
        await harness.drain();
        expect(firstCapture).toBe(true);
        await Effect.runPromise(
          harness.provider.publish(completion("checkpoint-fresh-after-startup")),
        );
      } else {
        await Effect.runPromise(harness.provider.publish(completion("checkpoint-blocked-first")));
      }
      let publication: Fiber.Fiber<void> | undefined;
      try {
        expect(
          Option.isSome(
            await Effect.runPromise(
              Deferred.await(captureStarted).pipe(Effect.timeoutOption("1 second")),
            ),
          ),
        ).toBe(true);
        publication = Effect.runFork(
          Effect.forEach(
            Array.from({ length: count }, (_, index) => index),
            (index) => harness.provider.publish(completion(`checkpoint-backlog-${index}`)),
            { discard: true },
          ).pipe(
            Effect.andThen(
              harness.provider.publish(completion("checkpoint-independent-complete", otherThread)),
            ),
            Effect.asVoid,
          ),
        );
        expect(
          Option.isSome(
            await Effect.runPromise(
              Fiber.await(publication).pipe(Effect.timeoutOption("2 seconds")),
            ),
          ),
        ).toBe(true);
        expect(
          Option.isSome(
            await Effect.runPromise(
              Deferred.await(independentCaptured).pipe(Effect.timeoutOption("500 millis")),
            ),
          ),
        ).toBe(true);
      } finally {
        if (publication) await Effect.runPromise(Fiber.interrupt(publication));
        await Effect.runPromise(Deferred.succeed(releaseCapture, undefined));
        if (scope) {
          await Effect.runPromise(Scope.close(scope, Exit.void));
          scope = null;
        }
      }
    },
  );

  async function addCheckpointThread(
    harness: Awaited<ReturnType<typeof createHarness>>,
    id: string,
    cwd: string,
  ) {
    const threadId = ThreadId.makeUnsafe(id);
    const projectId = asProjectId(`${id}-project`);
    const now = new Date().toISOString();
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe(`${id}-project`),
        projectId,
        title: id,
        workspaceRoot: cwd,
        defaultModelSelection: { provider: "codex", model: "gpt-5-codex" },
        createdAt: now,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe(`${id}-thread`),
        threadId,
        projectId,
        title: id,
        modelSelection: { provider: "codex", model: "gpt-5-codex" },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: cwd,
        createdAt: now,
      }),
    );
    const sessions = harness.provider.service.listSessions;
    vi.spyOn(harness.provider.service, "listSessions").mockImplementation(() =>
      sessions().pipe(
        Effect.map((entries) => [
          ...entries,
          {
            provider: "codex",
            status: "ready",
            runtimeMode: "full-access",
            threadId,
            cwd,
            createdAt: now,
            updatedAt: now,
          } satisfies ProviderSession,
        ]),
      ),
    );
    await Effect.runPromise(harness.engine.drain);
    return threadId;
  }
  const nativeCompletion = (id: string, threadId: ThreadId, turnId = id): ProviderRuntimeEvent => ({
    type: "turn.completed",
    eventId: EventId.makeUnsafe(id),
    provider: "codex",
    threadId,
    turnId: asTurnId(turnId),
    createdAt: new Date().toISOString(),
    payload: { state: "completed" },
  });

  it("recovers a committed native checkpoint while deferred thread detail is unavailable", async () => {
    const harness = await createHarness();
    const query = await runtime!.runPromise(Effect.service(ProjectionSnapshotQuery));
    vi.spyOn(query, "getThreadDetailById").mockImplementation(() => Effect.succeed(Option.none()));
    vi.spyOn(query, "getProjectShellById").mockImplementation(() => Effect.succeed(Option.none()));
    const turnId = asTurnId("checkpoint-deferred-detail");
    await Effect.runPromise(
      harness.provider.publish({
        type: "turn.completed",
        eventId: EventId.makeUnsafe("checkpoint-deferred-detail-event"),
        provider: "codex",
        threadId: ThreadId.makeUnsafe("thread-1"),
        turnId,
        createdAt: new Date().toISOString(),
        payload: { state: "completed" },
      }),
    );
    await waitForThread(
      harness.engine,
      (thread) => thread.checkpoints.some((entry) => entry.turnId === turnId),
      ThreadId.makeUnsafe("thread-1"),
      1_000,
    );
    expect(
      gitRefExists(harness.cwd, checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 1)),
    ).toBe(true);
  });

  const settleCheckpointWork = async (effect: Effect.Effect<void>) => {
    expect(
      Option.isSome(await Effect.runPromise(effect.pipe(Effect.timeoutOption("3 seconds")))),
    ).toBe(true);
  };

  it.each(["alias", "nested directory"] as const)(
    "serializes different thread checkpoints sharing a physical workspace %s",
    async (kind) => {
      const harness = await createHarness();
      const aliasDir = fs.mkdtempSync(path.join(os.tmpdir(), "synara-checkpoint-alias-"));
      tempDirs.push(aliasDir);
      const alias =
        kind === "alias" ? path.join(aliasDir, "workspace") : path.join(harness.cwd, "nested");
      if (kind === "alias") fs.symlinkSync(harness.cwd, alias, "dir");
      else fs.mkdirSync(alias);
      const otherThread = await addCheckpointThread(harness, "checkpoint-same-workspace", alias);
      const firstStarted = Deferred.makeUnsafe<void>();
      const releaseFirst = Deferred.makeUnsafe<void>();
      const otherStarted = Deferred.makeUnsafe<void>();
      const otherCaptureCwds: string[] = [];
      const capture = harness.checkpointStore.captureCheckpoint;
      vi.spyOn(harness.checkpointStore, "captureCheckpoint").mockImplementation((input) =>
        input.checkpointRef === checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 1)
          ? Deferred.succeed(firstStarted, undefined).pipe(
              Effect.andThen(Deferred.await(releaseFirst)),
              Effect.andThen(capture(input)),
            )
          : capture(input).pipe(
              Effect.tap(() =>
                input.checkpointRef === checkpointRefForThreadTurn(otherThread, 1)
                  ? Effect.sync(() => otherCaptureCwds.push(input.cwd)).pipe(
                      Effect.andThen(Deferred.succeed(otherStarted, undefined)),
                    )
                  : Effect.void,
              ),
            ),
      );
      await Effect.runPromise(
        harness.provider.publish(
          nativeCompletion("same-workspace-first", ThreadId.makeUnsafe("thread-1")),
        ),
      );
      try {
        expect(
          Option.isSome(
            await Effect.runPromise(
              Deferred.await(firstStarted).pipe(Effect.timeoutOption("1 second")),
            ),
          ),
        ).toBe(true);
        await Effect.runPromise(
          harness.provider.publish(nativeCompletion("same-workspace-second", otherThread)),
        );
        expect(
          Option.isNone(
            await Effect.runPromise(
              Deferred.await(otherStarted).pipe(Effect.timeoutOption("100 millis")),
            ),
          ),
        ).toBe(true);
        await Effect.runPromise(Deferred.succeed(releaseFirst, undefined));
        expect(
          Option.isSome(
            await Effect.runPromise(
              Deferred.await(otherStarted).pipe(Effect.timeoutOption("2 seconds")),
            ),
          ),
        ).toBe(true);
        await settleCheckpointWork(harness.reactor.drain);
        expect(otherCaptureCwds).toEqual([fs.realpathSync(alias)]);
      } finally {
        await Effect.runPromise(Deferred.succeed(releaseFirst, undefined));
      }
    },
  );

  it("keeps domain ACK behind a stuck workspace when a peer revert claim completes", async () => {
    const statements: string[] = [];
    const harness = await createHarness({ startReactor: false, sqlStatements: statements });
    const peerCwd = createGitRepository();
    tempDirs.push(peerCwd);
    const peer = await addCheckpointThread(harness, "claim-completion-independent", peerCwd);
    await Effect.runPromise(
      harness.checkpointStore.captureCheckpoint({
        cwd: peerCwd,
        checkpointRef: checkpointRefForThreadTurn(peer, 0),
      }),
    );
    await harness.start();
    await harness.drain();
    await Effect.runPromise(
      harness.checkpointStore.copyCheckpointRef({
        cwd: harness.cwd,
        fromCheckpointRef: checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 0),
        toCheckpointRef: checkpointRefForThreadTurnStart(
          ThreadId.makeUnsafe("thread-1"),
          asTurnId("claim-completion-blocked"),
        ),
      }),
    );
    const domainFloor = await Effect.runPromise(harness.engine.getEventHighWaterSequence);
    const started = Deferred.makeUnsafe<void>();
    const release = Deferred.makeUnsafe<void>();
    const originalCapture = harness.checkpointStore.captureCheckpoint;
    vi.spyOn(harness.checkpointStore, "captureCheckpoint").mockImplementation((input) =>
      input.cwd === fs.realpathSync(harness.cwd)
        ? Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.andThen(originalCapture(input)),
          )
        : originalCapture(input),
    );
    try {
      await Effect.runPromise(
        harness.provider.publish(
          nativeCompletion("claim-completion-blocked", ThreadId.makeUnsafe("thread-1")),
        ),
      );
      expect(
        Option.isSome(
          await Effect.runPromise(Deferred.await(started).pipe(Effect.timeoutOption("1 second"))),
        ),
      ).toBe(true);
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.checkpoint.revert",
          commandId: CommandId.makeUnsafe("claim-completion-peer-revert"),
          threadId: peer,
          turnCount: 0,
          scope: "thread",
          createdAt: new Date().toISOString(),
        }),
      );
      const request = (
        await Effect.runPromise(Stream.runCollect(harness.engine.readEvents(domainFloor)))
      ).find((event) => event.type === "thread.checkpoint-revert-requested")!;
      const readState = () =>
        runtime!.runPromise(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            return yield* sql<{
              cursor: number;
              state: string;
            }>`SELECT consumer.last_acked_sequence AS cursor, delivery.state FROM orchestration_consumer_state AS consumer JOIN orchestration_event_deliveries AS delivery ON delivery.consumer_name = consumer.consumer_name
          WHERE consumer.consumer_name = 'checkpoint-reactor.domain.v1' AND delivery.event_sequence = ${request.sequence}`;
          }),
        );
      let rows = await readState();
      for (let attempt = 0; attempt < 100 && rows[0]?.state !== "succeeded"; attempt++) {
        await Effect.runPromise(Effect.sleep("10 millis"));
        rows = await readState();
      }
      expect(rows[0]?.state).toBe("succeeded");
      expect(rows[0]?.cursor).toBe(domainFloor);
      // CP completion must not call a delivery adapter that performs per-row
      // cursor lookup/advancement outside the settled minimum of all lanes.
      expect(
        statements.some((query) => query.includes("UPDATE orchestration_event_deliveries")),
      ).toBe(true);
      expect(
        statements.filter(
          (query) =>
            /SELECT\s+MIN\(sequence\)/.test(query) && query.includes("FROM orchestration_events"),
        ),
      ).toEqual([]);
    } finally {
      await Effect.runPromise(Deferred.succeed(release, undefined));
      await settleCheckpointWork(harness.reactor.drain);
    }
  });

  it.each(["startup", "active"] as const)(
    "orders native completions around the atomic domain revert runtime fence (%s)",
    async (mode) => {
      const harness = await createHarness({ startReactor: false });
      const threadId = ThreadId.makeUnsafe("thread-1");
      const order: string[] = [];
      const capture = harness.checkpointStore.captureCheckpoint;
      const restore = harness.checkpointStore.restoreCheckpoint;
      let nativeCaptures = 0;
      const firstStarted = Deferred.makeUnsafe<void>();
      const releaseFirst = Deferred.makeUnsafe<void>();
      vi.spyOn(harness.checkpointStore, "captureCheckpoint").mockImplementation((input) => {
        if (input.checkpointRef === checkpointRefForThreadTurn(threadId, 1))
          order.push(++nativeCaptures === 1 ? "native-before" : "native-after");
        return mode === "active" &&
          nativeCaptures === 1 &&
          input.checkpointRef === checkpointRefForThreadTurn(threadId, 1)
          ? Deferred.succeed(firstStarted, undefined).pipe(
              Effect.andThen(Deferred.await(releaseFirst)),
              Effect.andThen(capture(input)),
            )
          : capture(input);
      });
      vi.spyOn(harness.checkpointStore, "restoreCheckpoint").mockImplementation((input) => {
        order.push("undo");
        return restore(input);
      });
      if (mode === "active") await harness.start();
      const before = await Effect.runPromise(
        harness.runtimeEvents.append(nativeCompletion("fence-before", threadId)),
      );
      try {
        if (mode === "active") {
          expect(
            Option.isSome(
              await Effect.runPromise(
                Deferred.await(firstStarted).pipe(Effect.timeoutOption("1 second")),
              ),
            ),
          ).toBe(true);
        }
        await Effect.runPromise(
          harness.engine.dispatch({
            type: "thread.checkpoint.revert",
            commandId: CommandId.makeUnsafe("checkpoint-fence-revert"),
            threadId,
            turnCount: 0,
            scope: "thread",
            createdAt: new Date().toISOString(),
          }),
        );
        const events = await Effect.runPromise(Stream.runCollect(harness.engine.readEvents(0)));
        expect(
          events.find((event) => event.type === "thread.checkpoint-revert-requested")?.metadata
            .checkpointRuntimeSequence,
        ).toBe(before.sequence);
        await Effect.runPromise(
          harness.runtimeEvents.append(nativeCompletion("fence-after", threadId)),
        );
        if (mode === "startup") await harness.start();
        await Effect.runPromise(Deferred.succeed(releaseFirst, undefined));
        await settleCheckpointWork(harness.reactor.drain);
        expect(order).toEqual(mode === "active" ? ["native-before", "undo", "native-after"] : []);
        if (mode === "startup") {
          const thread = (await Effect.runPromise(harness.engine.getReadModel())).threads.find(
            (entry) => entry.id === threadId,
          )!;
          expect(thread.activities.some((entry) => entry.kind === "checkpoint.revert.failed")).toBe(
            true,
          );
          expect(fs.readFileSync(path.join(harness.cwd, "README.md"), "utf8")).toBe("v3\n");
        }
      } finally {
        await Effect.runPromise(Deferred.succeed(releaseFirst, undefined));
      }
    },
  );

  it("does not recapture an undone completion while another workspace pins its runtime cursor across restart", async () => {
    const harness = await createHarness();
    const otherCwd = createGitRepository();
    tempDirs.push(otherCwd);
    const otherThread = await addCheckpointThread(harness, "checkpoint-replay-undone", otherCwd);
    await Effect.runPromise(
      harness.checkpointStore.captureCheckpoint({
        cwd: otherCwd,
        checkpointRef: checkpointRefForThreadTurn(otherThread, 0),
      }),
    );
    await Effect.runPromise(
      harness.checkpointStore.copyCheckpointRef({
        cwd: otherCwd,
        fromCheckpointRef: checkpointRefForThreadTurn(otherThread, 0),
        toCheckpointRef: checkpointRefForThreadTurnStart(
          otherThread,
          asTurnId("restart-completed-other"),
        ),
      }),
    );
    const blocked = Deferred.makeUnsafe<void>();
    const release = Deferred.makeUnsafe<void>();
    const capture = harness.checkpointStore.captureCheckpoint;
    const deleteRefs = harness.checkpointStore.deleteCheckpointRefs;
    const undoCleaned = Deferred.makeUnsafe<void>();
    vi.spyOn(harness.checkpointStore, "deleteCheckpointRefs").mockImplementation((input) =>
      deleteRefs(input).pipe(
        Effect.tap(() =>
          input.checkpointRefs.includes(checkpointRefForThreadTurn(otherThread, 1))
            ? Deferred.succeed(undoCleaned, undefined)
            : Effect.void,
        ),
      ),
    );
    let otherCaptures = 0;
    vi.spyOn(harness.checkpointStore, "captureCheckpoint").mockImplementation((input) => {
      if (input.checkpointRef === checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 1))
        return Deferred.succeed(blocked, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.andThen(capture(input)),
        );
      if (input.checkpointRef === checkpointRefForThreadTurn(otherThread, 1)) otherCaptures++;
      return capture(input);
    });
    try {
      await Effect.runPromise(
        harness.provider.publish(
          nativeCompletion("restart-pins-prefix", ThreadId.makeUnsafe("thread-1")),
        ),
      );
      expect(
        Option.isSome(
          await Effect.runPromise(Deferred.await(blocked).pipe(Effect.timeoutOption("1 second"))),
        ),
      ).toBe(true);
      await Effect.runPromise(
        harness.provider.publish(nativeCompletion("restart-completed-other", otherThread)),
      );
      await waitForThread(
        harness.engine,
        (entry) =>
          entry.id === otherThread &&
          entry.checkpoints.some((checkpoint) => checkpoint.turnId === "restart-completed-other"),
        otherThread,
        1_000,
      );
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.checkpoint.revert",
          commandId: CommandId.makeUnsafe("restart-undo-other"),
          threadId: otherThread,
          turnCount: 0,
          scope: "thread",
          createdAt: new Date().toISOString(),
        }),
      );
      await waitForThread(
        harness.engine,
        (entry) => entry.id === otherThread && entry.checkpoints.length === 0,
        otherThread,
        1_000,
      );
      expect(
        Option.isSome(
          await Effect.runPromise(
            Deferred.await(undoCleaned).pipe(Effect.timeoutOption("1 second")),
          ),
        ),
      ).toBe(true);
      expect(gitRefExists(otherCwd, checkpointRefForThreadTurn(otherThread, 1))).toBe(false);
      expect(otherCaptures).toBe(1);
      expect(
        await Effect.runPromise(
          harness.runtimeEvents.getConsumerCursor(CHECKPOINT_RUNTIME_CONSUMER),
        ),
      ).toBe(0);
      await Effect.runPromise(Scope.close(scope!, Exit.void));
      scope = await Effect.runPromise(Scope.make("sequential"));
      const services = await runtime!.runPromise(
        Layer.build(Layer.fresh(CheckpointReactorLive)).pipe(Scope.provide(scope)),
      );
      const restarted = ServiceMap.get(services, CheckpointReactor);
      await Effect.runPromise(restarted.start.pipe(Scope.provide(scope)));
      await settleCheckpointWork(restarted.drain);
      expect(otherCaptures).toBe(1);
      expect(gitRefExists(otherCwd, checkpointRefForThreadTurn(otherThread, 1))).toBe(false);
    } finally {
      await Effect.runPromise(Deferred.succeed(release, undefined));
    }
  });

  async function restartCheckpointReactor() {
    if (scope) await Effect.runPromise(Scope.close(scope, Exit.void));
    scope = await Effect.runPromise(Scope.make("sequential"));
    const services = await runtime!.runPromise(
      Layer.build(Layer.fresh(CheckpointReactorLive)).pipe(Scope.provide(scope)),
    );
    const restarted = ServiceMap.get(services, CheckpointReactor);
    await Effect.runPromise(restarted.start.pipe(Scope.provide(scope)));
    return restarted;
  }

  it("reports a post-upgrade native completion lost to an ordinary restart exactly once", async () => {
    // The consumer and its immutable upgrade cut already exist. Ingestion then
    // accepts a completion that the checkpoint lane never claims before a crash.
    const harness = await createHarness({ seedFilesystemCheckpoints: false });
    await harness.drain();
    await Effect.runPromise(Scope.close(scope!, Exit.void));
    scope = null;
    const threadId = ThreadId.makeUnsafe("thread-1");
    const row = await Effect.runPromise(
      harness.runtimeEvents.append(nativeCompletion("post-upgrade-unclaimed", threadId)),
    );
    await Effect.runPromise(
      harness.runtimeEvents.advanceConsumerCursorThrough({
        consumerName: PROVIDER_RUNTIME_INGESTION_CONSUMER,
        throughSequence: row.sequence,
        updatedAt: new Date().toISOString(),
      }),
    );
    const capture = vi.spyOn(harness.checkpointStore, "captureCheckpoint");
    try {
      const restarted = await restartCheckpointReactor();
      await settleCheckpointWork(restarted.drain);
      const again = await restartCheckpointReactor();
      await settleCheckpointWork(again.drain);
      expect(capture).not.toHaveBeenCalled();
      const thread = (await Effect.runPromise(harness.engine.getReadModel())).threads.find(
        (entry) => entry.id === threadId,
      )!;
      expect(
        thread.activities.filter((activity) => activity.kind === "checkpoint.capture.failed"),
      ).toHaveLength(1);
    } finally {
      capture.mockRestore();
    }
  });

  it.each(["inflight", "uncertain"] as const)(
    "surfaces %s native recovery without recapturing current files",
    async (state) => {
      const harness = await createHarness({ startReactor: false });
      const row = await Effect.runPromise(
        harness.runtimeEvents.append(
          nativeCompletion(`native-${state}-recovery`, ThreadId.makeUnsafe("thread-1")),
        ),
      );
      const now = new Date().toISOString();
      await runtime!.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`INSERT INTO orchestration_consumer_state (consumer_name, last_acked_sequence, created_at, updated_at)
        VALUES ('checkpoint-reactor.runtime-outcomes.v1', 0, ${now}, ${now})`;
          yield* sql`INSERT INTO orchestration_event_deliveries (consumer_name, event_sequence, thread_id, state, claim_owner, claimed_at, claim_expires_at, attempt_count, last_error, completed_at, updated_at)
        VALUES ('checkpoint-reactor.runtime-outcomes.v1', ${row.sequence}, 'thread-1', ${state}, ${state === "inflight" ? "previous-checkpoint-process" : null}, ${now}, ${now}, 1, ${state === "uncertain" ? "Persisted checkpoint uncertainty" : null}, NULL, ${now})`;
        }),
      );
      const capture = vi.spyOn(harness.checkpointStore, "captureCheckpoint");
      await harness.start();
      await settleCheckpointWork(harness.reactor.drain);
      expect(capture).not.toHaveBeenCalled();
      const thread = (await Effect.runPromise(harness.engine.getReadModel())).threads.find(
        (entry) => entry.id === "thread-1",
      )!;
      expect(
        thread.activities.filter((activity) => activity.kind === "checkpoint.capture.failed"),
      ).toHaveLength(1);
    },
  );

  it("preserves legacy revert uncertainty but silently adopts accepted native history after interrupted startup", async () => {
    const harness = await createHarness({ startReactor: false });
    const row = await Effect.runPromise(
      harness.runtimeEvents.append(
        nativeCompletion("legacy-native-pending", ThreadId.makeUnsafe("thread-1")),
      ),
    );
    await Effect.runPromise(
      harness.runtimeEvents.advanceConsumerCursor({
        consumerName: PROVIDER_RUNTIME_INGESTION_CONSUMER,
        eventSequence: row.sequence,
        updatedAt: new Date().toISOString(),
      }),
    );
    const revert = await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.checkpoint.revert",
        commandId: CommandId.makeUnsafe("legacy-unsettled-revert"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        turnCount: 0,
        scope: "thread",
        createdAt: new Date().toISOString(),
      }),
    );
    await runtime!.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE orchestration_events SET metadata_json = json_remove(metadata_json, '$.checkpointRuntimeSequence') WHERE sequence = ${revert.sequence}`;
      }),
    );
    await Effect.runPromise(harness.engine.drain);
    const query = await runtime!.runPromise(Effect.service(ProjectionSnapshotQuery));
    const originalDetail = query.getThreadDetailById;
    const admissionStarted = Deferred.makeUnsafe<void>();
    const releaseAdmission = Deferred.makeUnsafe<void>();
    const detail = vi
      .spyOn(query, "getThreadDetailById")
      .mockImplementation((id) =>
        Deferred.succeed(admissionStarted, undefined).pipe(
          Effect.andThen(Deferred.await(releaseAdmission)),
          Effect.andThen(originalDetail(id)),
        ),
      );
    const capture = vi.spyOn(harness.checkpointStore, "captureCheckpoint");
    const restore = vi.spyOn(harness.checkpointStore, "restoreCheckpoint");
    try {
      await harness.start();
      expect(
        Option.isSome(
          await Effect.runPromise(
            Deferred.await(admissionStarted).pipe(Effect.timeoutOption("1 second")),
          ),
        ),
      ).toBe(true);
      await Effect.runPromise(Scope.close(scope!, Exit.void));
      detail.mockRestore();
      const restarted = await restartCheckpointReactor();
      await settleCheckpointWork(restarted.drain);
      expect(capture).not.toHaveBeenCalled();
      expect(restore).not.toHaveBeenCalled();
      const thread = (await Effect.runPromise(harness.engine.getReadModel())).threads.find(
        (entry) => entry.id === "thread-1",
      )!;
      expect(
        thread.activities.some((activity) => activity.kind === "checkpoint.capture.failed"),
      ).toBe(false);
      expect(
        thread.activities.some((activity) => activity.kind === "checkpoint.revert.failed"),
      ).toBe(true);
    } finally {
      await Effect.runPromise(Deferred.succeed(releaseAdmission, undefined));
    }
  });

  it.each(["missing", "existing"] as const)(
    "does not treat a legacy placeholder with an %s physical checkpoint as a proven completion",
    async (refState) => {
      const harness = await createHarness({
        startReactor: false,
        seedFilesystemCheckpoints: false,
      });
      const threadId = ThreadId.makeUnsafe("thread-1");
      const turnId = asTurnId(`legacy-placeholder-${refState}`);
      const checkpointRef = checkpointRefForThreadTurn(threadId, 1);
      const createdAt = new Date().toISOString();
      if (refState === "existing") {
        await Effect.runPromise(
          harness.checkpointStore.captureCheckpoint({ cwd: harness.cwd, checkpointRef }),
        );
      }
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.diff.complete",
          commandId: CommandId.makeUnsafe(`legacy-placeholder-${refState}`),
          threadId,
          turnId,
          completedAt: createdAt,
          checkpointRef,
          status: "missing",
          files: [],
          checkpointTurnCount: 1,
          createdAt,
        }),
      );
      await Effect.runPromise(harness.engine.drain);
      const row = await Effect.runPromise(
        harness.runtimeEvents.append(
          nativeCompletion(`legacy-placeholder-event-${refState}`, threadId, turnId),
        ),
      );
      await Effect.runPromise(
        harness.runtimeEvents.advanceConsumerCursor({
          consumerName: PROVIDER_RUNTIME_INGESTION_CONSUMER,
          eventSequence: row.sequence,
          updatedAt: createdAt,
        }),
      );
      fs.writeFileSync(path.join(harness.cwd, "README.md"), "newer unrelated work\n");
      const capture = vi.spyOn(harness.checkpointStore, "captureCheckpoint");
      await harness.start();
      await settleCheckpointWork(harness.reactor.drain);
      expect(capture).not.toHaveBeenCalled();
      expect(gitRefExists(harness.cwd, checkpointRef)).toBe(refState === "existing");
      const thread = (await Effect.runPromise(harness.engine.getReadModel())).threads.find(
        (entry) => entry.id === threadId,
      )!;
      expect(
        thread.activities.filter((entry) => entry.kind === "checkpoint.capture.failed"),
      ).toHaveLength(1);
      if (refState === "existing")
        expect(gitShowFileAtRef(harness.cwd, checkpointRef, "README.md")).toBe("v1\n");
    },
  );

  it("logs a checkpoint source failure and rejects drain instead of silently losing the consumer", async () => {
    const harness = await createHarness({ startReactor: false });
    const messages: string[] = [];
    const logger = Logger.make(({ message }) => {
      messages.push(String(message));
    });
    const eventStore = await runtime!.runPromise(Effect.service(OrchestrationEventStore));
    vi.spyOn(eventStore, "readFromSequence").mockImplementation(() =>
      Stream.die(new Error("checkpoint-source-test")),
    );
    await Effect.runPromise(
      harness.reactor.start.pipe(
        Scope.provide(scope!),
        Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
      ),
    );
    await expect(harness.drain()).rejects.toThrow("checkpoint-source-test");
    expect(
      messages.some((message) =>
        message.includes("checkpoint reactor stopped after source failure"),
      ),
    ).toBe(true);
  });

  it("does not capture a baseline from delayed turn-start domain events", async () => {
    const harness = await createHarness({
      seedFilesystemCheckpoints: false,
      simulateProviderBaseline: false,
    });
    const threadId = ThreadId.makeUnsafe("thread-1");
    const messageId = MessageId.makeUnsafe("late-domain-message");
    fs.writeFileSync(path.join(harness.cwd, "README.md"), "provider already edited\n");
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("late-domain-start"),
        threadId,
        message: { messageId, role: "user", text: "start", attachments: [] },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: new Date().toISOString(),
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
    await harness.drain();
    expect(gitRefExists(harness.cwd, checkpointRefForThreadMessageStart(threadId, messageId))).toBe(
      false,
    );
    expect(gitRefExists(harness.cwd, checkpointRefForThreadTurn(threadId, 0))).toBe(false);
  });

  it("does not synthesize a missing pre-turn baseline after provider edits", async () => {
    const harness = await createHarness({ seedFilesystemCheckpoints: false });
    const threadId = ThreadId.makeUnsafe("thread-1");
    const turnId = asTurnId("late-runtime-start");
    fs.writeFileSync(path.join(harness.cwd, "README.md"), "provider already edited\n");
    harness.provider.emit({
      type: "turn.started",
      eventId: EventId.makeUnsafe("late-runtime-event"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId,
      turnId,
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    await harness.drain();
    expect(gitRefExists(harness.cwd, checkpointRefForThreadTurnStart(threadId, turnId))).toBe(
      false,
    );
    expect(gitRefExists(harness.cwd, checkpointRefForThreadTurn(threadId, 0))).toBe(false);
  });

  it("suppresses a generic skipped baseline notice for an unprepared native child", async () => {
    const harness = await createHarness({ seedFilesystemCheckpoints: false });
    const createdAt = new Date().toISOString();
    const threadId = ThreadId.makeUnsafe("subagent:thread-1:native-baseline");
    const turnId = asTurnId("native-child-turn");
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("native-baseline-child-create"),
        threadId,
        projectId: asProjectId("project-1"),
        title: "Native child",
        modelSelection: { provider: "codex", model: "gpt-5-codex" },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        parentThreadId: ThreadId.makeUnsafe("thread-1"),
        branch: null,
        worktreePath: harness.cwd,
        createdAt,
      }),
    );
    fs.writeFileSync(path.join(harness.cwd, "README.md"), "native provider edited\n");
    harness.provider.emit({
      type: "turn.started",
      eventId: EventId.makeUnsafe("native-baseline-start"),
      provider: "codex",
      createdAt,
      threadId,
      turnId,
    });
    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.makeUnsafe("native-baseline-complete"),
      provider: "codex",
      createdAt,
      threadId,
      turnId,
      payload: { state: "completed" },
    });
    await waitForEvent(
      harness.engine,
      (event) => event.type === "thread.turn-diff-completed" && event.payload.threadId === threadId,
      1000,
    );
    const thread = (await Effect.runPromise(harness.engine.getReadModel())).threads.find(
      (entry) => entry.id === threadId,
    );
    expect(thread?.checkpoints[0]?.status).toBe("missing");
    expect(gitRefExists(harness.cwd, checkpointRefForThreadTurnStart(threadId, turnId))).toBe(
      false,
    );
    expect(
      gitShowFileAtRef(harness.cwd, checkpointRefForThreadTurn(threadId, 1), "README.md"),
    ).toBe("native provider edited\n");
    expect(
      thread?.activities.filter((activity) => activity.kind === "checkpoint.baseline.skipped"),
    ).toEqual([]);
    expect(
      thread?.activities.some((activity) => activity.kind === "checkpoint.capture.failed"),
    ).toBe(false);
  });

  it.each(["root", "child"] as const)(
    "retains the initial skipped reason through completion for a %s turn",
    async (kind) => {
      const harness = await createHarness({
        seedFilesystemCheckpoints: false,
        simulateProviderBaseline: false,
      });
      const createdAt = new Date().toISOString();
      const threadId = ThreadId.makeUnsafe(
        kind === "root" ? "thread-1" : "subagent:thread-1:own-skip",
      );
      const messageId = MessageId.makeUnsafe(`dedup-message-${kind}`);
      const turnId = asTurnId(`dedup-turn-${kind}`);
      if (kind === "child")
        await Effect.runPromise(
          harness.sourceEngine.dispatch({
            type: "thread.create",
            commandId: CommandId.makeUnsafe("own-skip-child-create"),
            threadId,
            projectId: asProjectId("project-1"),
            title: "Child",
            modelSelection: { provider: "codex", model: "gpt-5-codex" },
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            runtimeMode: "approval-required",
            parentThreadId: ThreadId.makeUnsafe("thread-1"),
            branch: null,
            worktreePath: harness.cwd,
            createdAt,
          }),
        );
      await Effect.runPromise(
        harness.sourceEngine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.makeUnsafe(`dedup-request-${kind}`),
          threadId,
          message: { messageId, role: "user", text: "Start", attachments: [] },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt,
        }),
      );
      await Effect.runPromise(
        harness.sourceEngine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.makeUnsafe(`dedup-session-${kind}`),
          threadId,
          session: {
            threadId,
            providerName: "codex",
            status: "running",
            activeTurnId: turnId,
            runtimeMode: "approval-required",
            lastError: null,
            updatedAt: createdAt,
          },
          createdAt,
        }),
      );
      const initialReason = "Checkpoint and Studio preparation both exceeded the deadline.";
      await Effect.runPromise(
        harness.sourceEngine.dispatch({
          type: "thread.activity.append",
          commandId: CommandId.makeUnsafe(`dedup-notice-${kind}`),
          threadId,
          activity: {
            id: EventId.makeUnsafe(`initial-skip-${kind}`),
            kind: "checkpoint.baseline.skipped",
            tone: "info",
            summary: "Turn continued without baselines",
            payload: { messageId, detail: initialReason },
            turnId: null,
            createdAt,
          },
          createdAt,
        }),
      );
      harness.provider.emit({
        type: "turn.completed",
        eventId: EventId.makeUnsafe(`dedup-complete-${kind}`),
        provider: "codex",
        threadId,
        turnId,
        createdAt,
        payload: { state: "completed" },
      });
      await waitForEvent(
        harness.engine,
        (event) =>
          event.type === "thread.turn-diff-completed" && event.payload.threadId === threadId,
        1_500,
      );
      const thread = (await Effect.runPromise(harness.engine.getReadModel())).threads.find(
        (entry) => entry.id === threadId,
      );
      const notices = thread?.activities.filter(
        (activity) => activity.kind === "checkpoint.baseline.skipped",
      );
      expect(notices).toHaveLength(1);
      expect(notices?.[0]?.payload).toMatchObject({ detail: initialReason });
      expect(thread?.checkpoints[0]?.status).toBe("missing");
    },
  );

  it.each([false, true])(
    "checks the exact later baseline before file Undo (interrupted baseline exists: %s)",
    async (laterHasBaseline) => {
      const harness = await createHarness({ seedFilesystemCheckpoints: false });
      const threadId = ThreadId.makeUnsafe("thread-1");
      const createdAt = new Date().toISOString();
      await Effect.runPromise(
        harness.checkpointStore.captureCheckpoint({
          cwd: harness.cwd,
          checkpointRef: checkpointRefForThreadTurn(threadId, 0),
        }),
      );
      fs.writeFileSync(path.join(harness.cwd, "one.txt"), "earlier change\n");
      await Effect.runPromise(
        harness.checkpointStore.captureCheckpoint({
          cwd: harness.cwd,
          checkpointRef: checkpointRefForThreadTurn(threadId, 1),
        }),
      );
      if (laterHasBaseline) {
        await Effect.runPromise(
          harness.checkpointStore.captureCheckpoint({
            cwd: harness.cwd,
            checkpointRef: checkpointRefForThreadTurnStart(
              threadId,
              asTurnId("missing-later-turn-2"),
            ),
          }),
        );
      }
      fs.writeFileSync(path.join(harness.cwd, "README.md"), "later provider edits\n");
      await Effect.runPromise(
        harness.checkpointStore.captureCheckpoint({
          cwd: harness.cwd,
          checkpointRef: checkpointRefForThreadTurn(threadId, 2),
        }),
      );
      for (const [count, status, files] of [
        [1, "ready", [{ path: "one.txt", kind: "added", additions: 1, deletions: 0 }]],
        [2, "missing", []],
      ] as const) {
        await Effect.runPromise(
          harness.engine.dispatch({
            type: "thread.turn.diff.complete",
            commandId: CommandId.makeUnsafe(`missing-later-diff-${count}`),
            threadId,
            turnId: asTurnId(`missing-later-turn-${count}`),
            completedAt: createdAt,
            checkpointRef: checkpointRefForThreadTurn(threadId, count),
            status,
            files: [...files],
            checkpointTurnCount: count,
            createdAt,
          }),
        );
      }
      const reverse = vi.spyOn(harness.checkpointStore, "reverseCheckpointDiff");
      const originalRefs = [1, 2].map((count) =>
        runGit(harness.cwd, ["rev-parse", checkpointRefForThreadTurn(threadId, count)]),
      );
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.checkpoint.revert",
          commandId: CommandId.makeUnsafe("missing-later-undo"),
          threadId,
          turnCount: 1,
          scope: "files",
          createdAt,
        }),
      );
      const settled = await waitForThread(
        harness.engine,
        (thread) =>
          thread.activities.some(
            (activity) =>
              activity.kind === "checkpoint.revert.failed" ||
              activity.kind === "checkpoint.revert.succeeded",
          ),
        1_500,
      );
      if (laterHasBaseline) {
        expect(reverse).toHaveBeenCalledTimes(1);
        expect(
          settled.activities.some((activity) => activity.kind === "checkpoint.revert.failed"),
        ).toBe(false);
        expect(
          settled.activities.some((activity) => activity.kind === "checkpoint.revert.succeeded"),
        ).toBe(true);
        expect(fs.existsSync(path.join(harness.cwd, "one.txt"))).toBe(false);
        expect(fs.readFileSync(path.join(harness.cwd, "README.md"), "utf8")).toBe(
          "later provider edits\n",
        );
        return;
      }
      const failure = settled.activities.find(
        (activity) => activity.kind === "checkpoint.revert.failed",
      );
      expect(failure?.payload).toMatchObject({
        detail: expect.stringContaining("later turn has no exact initial checkpoint"),
      });
      expect(
        settled.activities.some((activity) => activity.kind === "checkpoint.revert.succeeded"),
      ).toBe(false);
      expect(reverse).not.toHaveBeenCalled();
      expect(fs.readFileSync(path.join(harness.cwd, "one.txt"), "utf8")).toBe("earlier change\n");
      expect(fs.readFileSync(path.join(harness.cwd, "README.md"), "utf8")).toBe(
        "later provider edits\n",
      );
      expect(
        [1, 2].map((count) =>
          runGit(harness.cwd, ["rev-parse", checkpointRefForThreadTurn(threadId, count)]),
        ),
      ).toEqual(originalRefs);
    },
  );

  it("recovers a captured message baseline from a persisted running turn", async () => {
    const harness = await createHarness({ seedFilesystemCheckpoints: false, startReactor: false });
    const threadId = ThreadId.makeUnsafe("thread-1");
    const messageId = MessageId.makeUnsafe("restart-message");
    const turnId = asTurnId("restart-turn");
    const createdAt = new Date().toISOString();
    await Effect.runPromise(
      harness.checkpointStore.captureCheckpoint({
        cwd: harness.cwd,
        checkpointRef: checkpointRefForThreadMessageStart(threadId, messageId),
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("restart-request"),
        threadId,
        message: { messageId, role: "user", text: "start", attachments: [] },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("restart-running"),
        threadId,
        session: {
          threadId,
          providerName: "codex",
          status: "running",
          activeTurnId: turnId,
          runtimeMode: "approval-required",
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );
    fs.writeFileSync(path.join(harness.cwd, "README.md"), "provider edited during restart\n");
    await harness.startReactor();
    await new Promise((resolve) => setTimeout(resolve, 25));
    harness.provider.emit({
      type: "turn.started",
      eventId: EventId.makeUnsafe("restart-started"),
      provider: "codex",
      createdAt,
      threadId,
      turnId,
    });
    const ref = checkpointRefForThreadTurnStart(threadId, turnId);
    await waitForGitRefExists(harness.cwd, ref, 1_000);
    expect(gitShowFileAtRef(harness.cwd, ref, "README.md")).toBe("v1\n");
  });

  it.each(["turn.completed", "item.completed"] as const)(
    "recovers a persisted baseline when restart first observes %s",
    async (firstEvent) => {
      const harness = await createHarness({
        seedFilesystemCheckpoints: false,
        startReactor: false,
      });
      const threadId = ThreadId.makeUnsafe("thread-1");
      const messageId = MessageId.makeUnsafe("restart-no-start-message");
      const turnId = asTurnId("restart-no-start-turn");
      const createdAt = new Date().toISOString();
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.makeUnsafe("restart-no-start-request"),
          threadId,
          message: { messageId, role: "user", text: "start", attachments: [] },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt,
        }),
      );
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.makeUnsafe("restart-no-start-running"),
          threadId,
          session: {
            threadId,
            providerName: "claudeAgent",
            status: "running",
            activeTurnId: turnId,
            runtimeMode: "approval-required",
            lastError: null,
            updatedAt: createdAt,
          },
          createdAt,
        }),
      );
      fs.writeFileSync(path.join(harness.cwd, "README.md"), "provider edit before reconnect\n");
      await harness.startReactor();
      await new Promise((resolve) => setTimeout(resolve, 25));
      harness.provider.emit(
        firstEvent === "turn.completed"
          ? {
              type: firstEvent,
              eventId: EventId.makeUnsafe("restart-no-start-completed"),
              provider: "claudeAgent",
              createdAt,
              threadId,
              turnId,
              payload: { state: "completed" },
            }
          : {
              type: firstEvent,
              eventId: EventId.makeUnsafe("restart-no-start-file-change"),
              provider: "claudeAgent",
              createdAt,
              threadId,
              turnId,
              itemId: "restart-file-change",
              payload: { itemType: "file_change", status: "completed" },
            },
      );
      await new Promise((resolve) => setTimeout(resolve, 25));
      await harness.drain();
      const ref = checkpointRefForThreadTurnStart(threadId, turnId);
      expect(gitRefExists(harness.cwd, ref)).toBe(true);
      expect(gitShowFileAtRef(harness.cwd, ref, "README.md")).toBe("v1\n");
      expect(
        gitShowFileAtRef(harness.cwd, checkpointRefForThreadTurn(threadId, 0), "README.md"),
      ).toBe("v1\n");
      const thread = (await Effect.runPromise(harness.engine.getReadModel())).threads.find(
        (entry) => entry.id === threadId,
      );
      expect(thread?.checkpoints[0]?.files?.map((file) => file.path)).toEqual(["README.md"]);
      expect(thread?.checkpoints[0]?.status).toBe(
        firstEvent === "turn.completed" ? "ready" : "missing",
      );
    },
  );

  it("aliases a prepared pre-turn baseline on turn.started and captures the post-turn checkpoint on turn.completed", async () => {
    const harness = await createHarness({ seedFilesystemCheckpoints: false });
    const createdAt = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-capture"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    await harness.prepareBaseline(asTurnId("turn-1"));
    harness.provider.emit({
      type: "turn.started",
      eventId: EventId.makeUnsafe("evt-turn-started-1"),
      provider: "codex",

      createdAt: new Date().toISOString(),
      threadId: ThreadId.makeUnsafe("thread-1"),
      turnId: asTurnId("turn-1"),
    });
    await waitForGitRefExists(
      harness.cwd,
      checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 0),
    );
    await waitForGitRefExists(
      harness.cwd,
      checkpointRefForThreadTurnStart(ThreadId.makeUnsafe("thread-1"), asTurnId("turn-1")),
    );

    fs.writeFileSync(path.join(harness.cwd, "README.md"), "v2\n", "utf8");
    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.makeUnsafe("evt-turn-completed-1"),
      provider: "codex",

      createdAt: new Date().toISOString(),
      threadId: ThreadId.makeUnsafe("thread-1"),
      turnId: asTurnId("turn-1"),
      payload: { state: "completed" },
    });

    await waitForEvent(harness.engine, (event) => event.type === "thread.turn-diff-completed");
    const thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.latestTurn?.turnId === "turn-1" &&
        entry.checkpoints.length === 1 &&
        entry.checkpoints[0]?.files?.map((file) => file.path).includes("README.md") === true,
    );
    expect(thread.checkpoints[0]?.checkpointTurnCount).toBe(1);
    expect(
      gitRefExists(harness.cwd, checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 0)),
    ).toBe(true);
    expect(
      gitRefExists(harness.cwd, checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 1)),
    ).toBe(true);
    expect(
      gitShowFileAtRef(
        harness.cwd,
        checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 0),
        "README.md",
      ),
    ).toBe("v1\n");
    expect(
      gitShowFileAtRef(
        harness.cwd,
        checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 1),
        "README.md",
      ),
    ).toBe("v2\n");
  });

  it("summarizes only files changed after each turn's start checkpoint", async () => {
    const harness = await createHarness({ seedFilesystemCheckpoints: false });
    const threadId = ThreadId.makeUnsafe("thread-1");
    const firstMessageId = MessageId.makeUnsafe("message-turn-a");
    const secondMessageId = MessageId.makeUnsafe("message-turn-b");
    const firstTurnId = asTurnId("turn-a");
    const secondTurnId = asTurnId("turn-b");
    const createdAt = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-a-start"),
        threadId,
        message: {
          messageId: firstMessageId,
          role: "user",
          text: "create a",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt,
      }),
    );
    await waitForGitRefExists(
      harness.cwd,
      checkpointRefForThreadMessageStart(threadId, firstMessageId),
    );
    harness.provider.emit({
      type: "turn.started",
      eventId: EventId.makeUnsafe("evt-turn-a-started"),
      provider: "codex",
      createdAt,
      threadId,
      turnId: firstTurnId,
    });
    await waitForGitRefExists(harness.cwd, checkpointRefForThreadTurnStart(threadId, firstTurnId));
    fs.writeFileSync(path.join(harness.cwd, "a.txt"), "A\n", "utf8");
    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.makeUnsafe("evt-turn-a-completed"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId,
      turnId: firstTurnId,
      payload: { state: "completed" },
    });
    await waitForThread(
      harness.engine,
      (entry) =>
        entry.checkpoints.length === 1 &&
        entry.checkpoints[0]?.files?.map((file) => file.path).includes("a.txt") === true,
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-b-start"),
        threadId,
        message: {
          messageId: secondMessageId,
          role: "user",
          text: "create b",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: new Date().toISOString(),
      }),
    );
    await waitForGitRefExists(
      harness.cwd,
      checkpointRefForThreadMessageStart(threadId, secondMessageId),
    );
    harness.provider.emit({
      type: "turn.started",
      eventId: EventId.makeUnsafe("evt-turn-b-started"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId,
      turnId: secondTurnId,
    });
    await waitForGitRefExists(harness.cwd, checkpointRefForThreadTurnStart(threadId, secondTurnId));
    fs.writeFileSync(path.join(harness.cwd, "b.txt"), "B\n", "utf8");
    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.makeUnsafe("evt-turn-b-completed"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId,
      turnId: secondTurnId,
      payload: { state: "completed" },
    });

    const thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.checkpoints.length === 2 &&
        entry.checkpoints.some(
          (checkpoint) =>
            checkpoint.checkpointTurnCount === 2 &&
            checkpoint.files?.map((file) => file.path).join(",") === "b.txt",
        ),
    );

    expect(thread.checkpoints.at(-1)?.files?.map((file) => file.path)).toEqual(["b.txt"]);
  });

  it("leaves a missing message-start baseline unavailable after provider start", async () => {
    const harness = await createHarness({ seedFilesystemCheckpoints: false });
    const threadId = ThreadId.makeUnsafe("thread-1");
    const messageId = MessageId.makeUnsafe("message-missing-baseline");
    const turnId = asTurnId("turn-missing-baseline");
    const createdAt = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-missing-baseline-start"),
        threadId,
        message: {
          messageId,
          role: "user",
          text: "recover baseline",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt,
      }),
    );
    const messageStartRef = checkpointRefForThreadMessageStart(threadId, messageId);
    await waitForGitRefExists(harness.cwd, messageStartRef);

    // Simulate a missing message-start baseline when the provider's
    // turn.started arrives, regardless of which startup path dropped it.
    runGit(harness.cwd, ["update-ref", "-d", messageStartRef]);
    fs.writeFileSync(path.join(harness.cwd, "README.md"), "early provider edit\n");

    harness.provider.emit({
      type: "turn.started",
      eventId: EventId.makeUnsafe("evt-turn-missing-baseline-started"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId,
      turnId,
    });
    const turnStartRef = checkpointRefForThreadTurnStart(threadId, turnId);
    await new Promise((resolve) => setTimeout(resolve, 25));
    await harness.drain();
    expect(gitRefExists(harness.cwd, messageStartRef)).toBe(false);
    expect(gitRefExists(harness.cwd, turnStartRef)).toBe(false);
    expect(fs.readFileSync(path.join(harness.cwd, "README.md"), "utf8")).toBe(
      "early provider edit\n",
    );
  });

  it("waits briefly for the assistant message id before finalizing a completed turn checkpoint", async () => {
    const harness = await createHarness({ seedFilesystemCheckpoints: false });
    const turnId = asTurnId("turn-assistant-race");
    const assistantMessageId = MessageId.makeUnsafe("assistant:item-race");
    const createdAt = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-assistant-race"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: turnId,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    await harness.prepareBaseline(turnId);
    harness.provider.emit({
      type: "turn.started",
      eventId: EventId.makeUnsafe("evt-turn-started-assistant-race"),
      provider: "codex",
      createdAt,
      threadId: ThreadId.makeUnsafe("thread-1"),
      turnId,
    });

    await waitForGitRefExists(
      harness.cwd,
      checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 0),
    );

    fs.writeFileSync(path.join(harness.cwd, "README.md"), "race\n", "utf8");

    setTimeout(() => {
      void Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.message.assistant.complete",
          commandId: CommandId.makeUnsafe("cmd-assistant-complete-race"),
          threadId: ThreadId.makeUnsafe("thread-1"),
          messageId: assistantMessageId,
          turnId,
          createdAt: new Date().toISOString(),
        }),
      );
    }, 10);

    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.makeUnsafe("evt-turn-completed-assistant-race"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: ThreadId.makeUnsafe("thread-1"),
      turnId,
      payload: { state: "completed" },
    });

    await waitForEvent(harness.engine, (event) => event.type === "thread.turn-diff-completed");
    const thread = await waitForThread(harness.engine, (entry) =>
      entry.checkpoints.some((checkpoint) => checkpoint.checkpointTurnCount === 1),
    );

    expect(thread.checkpoints[0]?.assistantMessageId).toBe(assistantMessageId);
  });

  it("leaves placeholders unresolved until turn completion, then captures the real checkpoint", async () => {
    const harness = await createHarness({ seedFilesystemCheckpoints: false });
    const turnId = asTurnId("turn-placeholder-race");
    const assistantMessageId = MessageId.makeUnsafe("assistant:item-placeholder-real");
    const syntheticAssistantMessageId = MessageId.makeUnsafe("assistant:evt-placeholder-synthetic");
    const createdAt = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-placeholder-baseline"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: MessageId.makeUnsafe("message-user-placeholder"),
          role: "user",
          text: "start turn",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt,
      }),
    );
    await waitForGitRefExists(
      harness.cwd,
      checkpointRefForThreadMessageStart(
        ThreadId.makeUnsafe("thread-1"),
        MessageId.makeUnsafe("message-user-placeholder"),
      ),
    );

    harness.provider.emit({
      type: "turn.started",
      eventId: EventId.makeUnsafe("evt-turn-started-placeholder-race"),
      provider: "codex",
      createdAt,
      threadId: ThreadId.makeUnsafe("thread-1"),
      turnId,
    });
    await waitForGitRefExists(
      harness.cwd,
      checkpointRefForThreadTurnStart(ThreadId.makeUnsafe("thread-1"), turnId),
    );

    fs.writeFileSync(path.join(harness.cwd, "README.md"), "placeholder\n", "utf8");

    setTimeout(() => {
      void Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.message.assistant.complete",
          commandId: CommandId.makeUnsafe("cmd-assistant-complete-placeholder-race"),
          threadId: ThreadId.makeUnsafe("thread-1"),
          messageId: assistantMessageId,
          turnId,
          createdAt: new Date().toISOString(),
        }),
      );
    }, 10);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.makeUnsafe("cmd-turn-diff-placeholder"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        turnId,
        completedAt: createdAt,
        checkpointRef: checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 1),
        status: "missing",
        files: [],
        assistantMessageId: syntheticAssistantMessageId,
        checkpointTurnCount: 1,
        createdAt,
      }),
    );

    let thread = await waitForThread(harness.engine, (entry) =>
      entry.checkpoints.some((checkpoint) => checkpoint.checkpointTurnCount === 1),
    );

    expect(thread.checkpoints[0]?.status).toBe("missing");
    expect(thread.checkpoints[0]?.assistantMessageId).toBe(syntheticAssistantMessageId);
    expect(
      gitRefExists(harness.cwd, checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 1)),
    ).toBe(false);

    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.makeUnsafe("evt-turn-completed-placeholder-race"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: ThreadId.makeUnsafe("thread-1"),
      turnId,
      payload: { state: "completed" },
    });

    thread = await waitForThread(harness.engine, (entry) =>
      entry.checkpoints.some(
        (checkpoint) =>
          checkpoint.checkpointTurnCount === 1 &&
          checkpoint.status === "ready" &&
          checkpoint.assistantMessageId === assistantMessageId,
      ),
    );

    expect(thread.checkpoints[0]?.assistantMessageId).toBe(assistantMessageId);
  });

  it("does not freeze an early placeholder snapshot as the final turn checkpoint", async () => {
    const harness = await createHarness({ seedFilesystemCheckpoints: false });
    const threadId = ThreadId.makeUnsafe("thread-1");
    const turnId = asTurnId("turn-placeholder-final");
    const messageId = MessageId.makeUnsafe("message-user-placeholder-final");
    const createdAt = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-placeholder-final"),
        threadId,
        message: {
          messageId,
          role: "user",
          text: "start turn",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt,
      }),
    );

    harness.provider.emit({
      type: "turn.started",
      eventId: EventId.makeUnsafe("evt-turn-started-placeholder-final"),
      provider: "codex",
      createdAt,
      threadId,
      turnId,
    });

    await waitForGitRefExists(harness.cwd, checkpointRefForThreadTurnStart(threadId, turnId));

    fs.writeFileSync(path.join(harness.cwd, "early.txt"), "early\n", "utf8");
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.makeUnsafe("cmd-turn-diff-early-placeholder"),
        threadId,
        turnId,
        completedAt: createdAt,
        checkpointRef: checkpointRefForThreadTurn(threadId, 1),
        status: "missing",
        files: [],
        checkpointTurnCount: 1,
        createdAt,
      }),
    );

    fs.writeFileSync(path.join(harness.cwd, "late.txt"), "late\n", "utf8");
    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.makeUnsafe("evt-turn-completed-placeholder-final"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId,
      turnId,
      payload: { state: "completed" },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.checkpoints.some(
        (checkpoint) =>
          checkpoint.checkpointTurnCount === 1 &&
          checkpoint.status === "ready" &&
          checkpoint.files
            ?.map((file) => file.path)
            .sort()
            .join(",") === "early.txt,late.txt",
      ),
    );

    expect(thread.checkpoints[0]?.files?.map((file) => file.path).sort()).toEqual([
      "early.txt",
      "late.txt",
    ]);
  });

  it("ignores auxiliary thread turn completion while primary turn is active", async () => {
    const harness = await createHarness({ seedFilesystemCheckpoints: false });
    const createdAt = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-primary-running"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-main"),
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    await harness.prepareBaseline(asTurnId("turn-main"));
    harness.provider.emit({
      type: "turn.started",
      eventId: EventId.makeUnsafe("evt-turn-started-main"),
      provider: "codex",

      createdAt: new Date().toISOString(),
      threadId: ThreadId.makeUnsafe("thread-1"),
      turnId: asTurnId("turn-main"),
    });
    await waitForGitRefExists(
      harness.cwd,
      checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 0),
    );

    fs.writeFileSync(path.join(harness.cwd, "README.md"), "v2\n", "utf8");

    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.makeUnsafe("evt-turn-completed-aux"),
      provider: "codex",

      createdAt: new Date().toISOString(),
      threadId: ThreadId.makeUnsafe("thread-1"),
      turnId: asTurnId("turn-aux"),
      payload: { state: "completed" },
    });

    await harness.drain();
    const midReadModel = await Effect.runPromise(harness.engine.getReadModel());
    const midThread = midReadModel.threads.find(
      (entry) => entry.id === ThreadId.makeUnsafe("thread-1"),
    );
    expect(midThread?.checkpoints).toHaveLength(0);

    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.makeUnsafe("evt-turn-completed-main"),
      provider: "codex",

      createdAt: new Date().toISOString(),
      threadId: ThreadId.makeUnsafe("thread-1"),
      turnId: asTurnId("turn-main"),
      payload: { state: "completed" },
    });

    const thread = await waitForThread(
      harness.engine,
      (entry) => entry.latestTurn?.turnId === "turn-main" && entry.checkpoints.length === 1,
    );
    expect(thread.checkpoints[0]?.checkpointTurnCount).toBe(1);
  });

  it("does not report a missing baseline when the turn itself initializes the git repository", async () => {
    // A scaffolding turn starts in a plain folder and runs `git init` mid-turn.
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "synara-checkpoint-plain-"));
    tempDirs.push(workspace);
    const harness = await createHarness({
      seedFilesystemCheckpoints: false,
      providerName: "claudeAgent",
      projectWorkspaceRoot: workspace,
      threadWorktreePath: workspace,
      providerSessionCwd: workspace,
    });
    const createdAt = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-repo-init-mid-turn"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "ready",
          providerName: "claudeAgent",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    harness.provider.emit({
      type: "turn.started",
      eventId: EventId.makeUnsafe("evt-turn-started-repo-init"),
      provider: "claudeAgent",
      createdAt: new Date().toISOString(),
      threadId: ThreadId.makeUnsafe("thread-1"),
      turnId: asTurnId("turn-repo-init"),
    });
    await harness.drain();
    expect(fs.existsSync(path.join(workspace, ".git"))).toBe(false);

    runGit(workspace, ["init", "--initial-branch=main"]);
    runGit(workspace, ["config", "user.email", "test@example.com"]);
    runGit(workspace, ["config", "user.name", "Test User"]);
    fs.writeFileSync(path.join(workspace, "package.json"), "{}\n", "utf8");
    runGit(workspace, ["add", "."]);
    runGit(workspace, ["commit", "-m", "Initial"]);

    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.makeUnsafe("evt-turn-completed-repo-init"),
      provider: "claudeAgent",
      createdAt: new Date().toISOString(),
      threadId: ThreadId.makeUnsafe("thread-1"),
      turnId: asTurnId("turn-repo-init"),
      payload: { state: "completed" },
    });

    await waitForEvent(harness.engine, (event) => event.type === "thread.turn-diff-completed");
    const thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.checkpoints.length === 1 &&
        entry.activities.some((activity) => activity.kind === "checkpoint.captured"),
    );

    expect(thread.checkpoints[0]?.checkpointTurnCount).toBe(1);
    expect(thread.checkpoints[0]?.status).toBe("missing");
    expect(
      gitRefExists(workspace, checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 1)),
    ).toBe(true);
    expect(
      thread.activities.some((activity) => activity.kind === "checkpoint.capture.failed"),
    ).toBe(false);
  });

  it("derives a live turn-diff placeholder from git for claude file edits mid-turn", async () => {
    const harness = await createHarness({
      seedFilesystemCheckpoints: false,
      providerName: "claudeAgent",
    });
    const threadId = ThreadId.makeUnsafe("thread-1");
    const turnId = asTurnId("turn-claude-live");
    const createdAt = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-claude-live"),
        threadId,
        session: {
          threadId,
          status: "running",
          providerName: "claudeAgent",
          runtimeMode: "approval-required",
          activeTurnId: turnId,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    await harness.prepareBaseline(turnId);
    harness.provider.emit({
      type: "turn.started",
      eventId: EventId.makeUnsafe("evt-turn-started-claude-live"),
      provider: "claudeAgent",
      createdAt: new Date().toISOString(),
      threadId,
      turnId,
    });
    await waitForGitRefExists(harness.cwd, checkpointRefForThreadTurnStart(threadId, turnId));

    // A file edit completes while the turn is still running (no turn.completed yet).
    fs.writeFileSync(path.join(harness.cwd, "live.txt"), "live\n", "utf8");
    harness.provider.emit({
      type: "item.completed",
      eventId: EventId.makeUnsafe("evt-item-file-change-live"),
      provider: "claudeAgent",
      createdAt: new Date().toISOString(),
      threadId,
      turnId,
      itemId: "item-file-change-1",
      payload: { itemType: "file_change", status: "completed" },
    });

    const liveThread = await waitForThread(harness.engine, (entry) =>
      entry.checkpoints.some(
        (checkpoint) =>
          checkpoint.status === "missing" &&
          checkpoint.files?.map((file) => file.path).includes("live.txt") === true,
      ),
    );
    const livePlaceholder = liveThread.checkpoints.find(
      (checkpoint) => checkpoint.status === "missing",
    );
    expect(livePlaceholder?.checkpointTurnCount).toBe(1);
    const liveFile = livePlaceholder?.files?.find((file) => file.path === "live.txt") as
      | { readonly path: string; readonly additions?: number; readonly deletions?: number }
      | undefined;
    expect(liveFile?.additions).toBe(1);
    // The throwaway snapshot ref must not linger as a durable checkpoint.
    expect(gitRefExists(harness.cwd, checkpointRefForThreadTurnLive(threadId, turnId))).toBe(false);

    // The terminal turn.completed capture must overwrite the placeholder with the
    // authoritative git checkpoint (status "ready"), keeping a single entry.
    fs.writeFileSync(path.join(harness.cwd, "second.txt"), "second\n", "utf8");
    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.makeUnsafe("evt-turn-completed-claude-live"),
      provider: "claudeAgent",
      createdAt: new Date().toISOString(),
      threadId,
      turnId,
      payload: { state: "completed" },
    });

    const finalThread = await waitForThread(harness.engine, (entry) =>
      entry.checkpoints.some(
        (checkpoint) => checkpoint.checkpointTurnCount === 1 && checkpoint.status === "ready",
      ),
    );
    expect(finalThread.checkpoints).toHaveLength(1);
    expect(finalThread.checkpoints[0]?.files?.map((file) => file.path).sort()).toEqual([
      "live.txt",
      "second.txt",
    ]);
  });

  it("reports an unavailable baseline when a completed turn has no initial checkpoint", async () => {
    const harness = await createHarness({ seedFilesystemCheckpoints: false });
    const createdAt = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-missing-baseline-diff"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.makeUnsafe("evt-turn-completed-missing-baseline"),
      provider: "codex",

      createdAt: new Date().toISOString(),
      threadId: ThreadId.makeUnsafe("thread-1"),
      turnId: asTurnId("turn-missing-baseline"),
      payload: { state: "completed" },
    });

    await waitForEvent(harness.engine, (event) => event.type === "thread.turn-diff-completed");
    const thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.checkpoints.length === 1 &&
        entry.activities.some((activity) => activity.kind === "checkpoint.baseline.skipped"),
    );

    expect(thread.checkpoints[0]?.checkpointTurnCount).toBe(1);
    expect(
      thread.activities.some((activity) => activity.kind === "checkpoint.baseline.skipped"),
    ).toBe(true);
    expect(
      thread.activities.find((activity) => activity.kind === "checkpoint.baseline.skipped")
        ?.payload,
    ).toMatchObject({
      detail: expect.not.stringMatching(/Native provider|Synara send|pre-dispatch/),
    });
  });

  it("captures pre-turn baseline from project workspace root when thread worktree is unset", async () => {
    const harness = await createHarness({
      hasSession: false,
      seedFilesystemCheckpoints: false,
      threadWorktreePath: null,
    });

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-for-baseline"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: MessageId.makeUnsafe("message-user-1"),
          role: "user",
          text: "start turn",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: new Date().toISOString(),
      }),
    );

    harness.provider.emit({
      type: "turn.started",
      eventId: EventId.makeUnsafe("project-root-started"),
      provider: "codex",
      createdAt: new Date().toISOString(),
      threadId: ThreadId.makeUnsafe("thread-1"),
      turnId: asTurnId("project-root-turn"),
    });
    await waitForGitRefExists(
      harness.cwd,
      checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 0),
    );
    expect(
      gitShowFileAtRef(
        harness.cwd,
        checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 0),
        "README.md",
      ),
    ).toBe("v1\n");
  });

  it("captures turn completion checkpoint from project workspace root when provider session cwd is unavailable", async () => {
    const harness = await createHarness({
      hasSession: false,
      seedFilesystemCheckpoints: false,
      threadWorktreePath: null,
    });
    const createdAt = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-missing-provider-cwd"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-missing-cwd"),
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    fs.writeFileSync(path.join(harness.cwd, "README.md"), "v2\n", "utf8");
    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.makeUnsafe("evt-turn-completed-missing-provider-cwd"),
      provider: "codex",

      createdAt: new Date().toISOString(),
      threadId: ThreadId.makeUnsafe("thread-1"),
      turnId: asTurnId("turn-missing-cwd"),
      payload: { state: "completed" },
    });

    await waitForEvent(harness.engine, (event) => event.type === "thread.turn-diff-completed");
    expect(
      gitRefExists(harness.cwd, checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 1)),
    ).toBe(true);
    expect(
      gitShowFileAtRef(
        harness.cwd,
        checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 1),
        "README.md",
      ),
    ).toBe("v2\n");
  });

  it("ignores non-v2 checkpoint.captured runtime events", async () => {
    const harness = await createHarness();
    const createdAt = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-checkpoint-captured"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    harness.provider.emit({
      type: "checkpoint.captured",
      eventId: EventId.makeUnsafe("evt-checkpoint-captured-3"),
      provider: "codex",

      createdAt: new Date().toISOString(),
      threadId: ThreadId.makeUnsafe("thread-1"),
      turnId: asTurnId("turn-3"),
      turnCount: 3,
      status: "completed",
    });

    await harness.drain();
    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.makeUnsafe("thread-1"));
    expect(thread?.checkpoints.some((checkpoint) => checkpoint.checkpointTurnCount === 3)).toBe(
      false,
    );
  });

  it("continues processing runtime events after a single checkpoint runtime failure", async () => {
    const harness = await createHarness({ seedFilesystemCheckpoints: false });
    const createdAt = new Date().toISOString();

    // Force the completion capture to fail inside git: a ref nested under the
    // turn-1 checkpoint ref makes `git update-ref` refuse to create it, while
    // every other checkpoint ref in the family stays writable.
    runGit(harness.cwd, [
      "update-ref",
      `${checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 1)}/blocker`,
      "HEAD",
    ]);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-non-repo-runtime"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.makeUnsafe("evt-runtime-capture-failure"),
      provider: "codex",

      createdAt: new Date().toISOString(),
      threadId: ThreadId.makeUnsafe("thread-1"),
      turnId: asTurnId("turn-runtime-failure"),
      payload: { state: "completed" },
    });

    await harness.prepareBaseline(asTurnId("turn-after-runtime-failure"));
    harness.provider.emit({
      type: "turn.started",
      eventId: EventId.makeUnsafe("evt-turn-started-after-runtime-failure"),
      provider: "codex",

      createdAt: new Date().toISOString(),
      threadId: ThreadId.makeUnsafe("thread-1"),
      turnId: asTurnId("turn-after-runtime-failure"),
    });

    // The first event must genuinely fail, otherwise this test proves nothing.
    await waitForThread(harness.engine, (entry) =>
      entry.activities.some((activity) => activity.kind === "checkpoint.capture.failed"),
    );
    expect(
      gitRefExists(harness.cwd, checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 1)),
    ).toBe(false);

    // The second event is still processed by the same worker.
    await waitForGitRefExists(
      harness.cwd,
      checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 0),
    );
    expect(
      gitRefExists(harness.cwd, checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 0)),
    ).toBe(true);
  });

  it("undoes turn files without trimming chat or rolling back the Claude conversation", async () => {
    const harness = await createHarness({
      seedFilesystemCheckpoints: false,
      providerName: "claudeAgent",
    });
    const createdAt = new Date().toISOString();
    const threadId = ThreadId.makeUnsafe("thread-1");
    const turnOneId = asTurnId("turn-files-1");
    const turnTwoId = asTurnId("turn-files-2");
    const placeholderTurnId = asTurnId("turn-files-placeholder");

    await runtime!.runPromise(
      harness.checkpointStore.captureCheckpoint({
        cwd: harness.cwd,
        checkpointRef: checkpointRefForThreadTurn(threadId, 0),
      }),
    );
    fs.writeFileSync(path.join(harness.cwd, "one.txt"), "one\n", "utf8");
    runGit(harness.cwd, ["add", "one.txt"]);
    await runtime!.runPromise(
      harness.checkpointStore.captureCheckpoint({
        cwd: harness.cwd,
        checkpointRef: checkpointRefForThreadTurn(threadId, 1),
      }),
    );
    await runtime!.runPromise(
      harness.checkpointStore.copyCheckpointRef({
        cwd: harness.cwd,
        fromCheckpointRef: checkpointRefForThreadTurn(threadId, 1),
        toCheckpointRef: checkpointRefForThreadTurnStart(threadId, turnTwoId),
      }),
    );
    fs.writeFileSync(path.join(harness.cwd, "two.txt"), "two\n", "utf8");
    runGit(harness.cwd, ["add", "two.txt"]);
    await runtime!.runPromise(
      harness.checkpointStore.captureCheckpoint({
        cwd: harness.cwd,
        checkpointRef: checkpointRefForThreadTurn(threadId, 2),
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.messages.import",
        commandId: CommandId.makeUnsafe("cmd-import-files-undo-chat"),
        threadId,
        messages: [
          {
            messageId: MessageId.makeUnsafe("message-files-undo-user"),
            role: "user",
            text: "Change two files",
            createdAt,
            updatedAt: createdAt,
          },
          {
            messageId: MessageId.makeUnsafe("message-files-undo-assistant"),
            role: "assistant",
            text: "Changed them",
            createdAt,
            updatedAt: createdAt,
          },
        ],
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-files-undo"),
        threadId,
        session: {
          threadId,
          status: "ready",
          providerName: "claudeAgent",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );
    for (const [turnCount, turnId, filePath] of [
      [1, turnOneId, "one.txt"],
      [2, turnTwoId, "two.txt"],
    ] as const) {
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.diff.complete",
          commandId: CommandId.makeUnsafe(`cmd-files-undo-diff-${turnCount}`),
          threadId,
          turnId,
          completedAt: createdAt,
          checkpointRef: checkpointRefForThreadTurn(threadId, turnCount),
          status: "ready",
          files: [{ path: filePath, kind: "modified", additions: 1, deletions: 0 }],
          checkpointTurnCount: turnCount,
          createdAt,
        }),
      );
    }
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.makeUnsafe("cmd-files-undo-live-placeholder"),
        threadId,
        turnId: placeholderTurnId,
        completedAt: createdAt,
        checkpointRef: CheckpointRef.makeUnsafe("provider-diff:files-undo-placeholder"),
        status: "missing",
        files: [{ path: "placeholder.txt", kind: "modified", additions: 1, deletions: 0 }],
        checkpointTurnCount: 3,
        createdAt,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.checkpoint.revert",
        commandId: CommandId.makeUnsafe("cmd-undo-files-turn-2"),
        threadId,
        turnCount: 2,
        scope: "files",
        createdAt,
      }),
    );
    await waitForThread(
      harness.engine,
      (entry) =>
        entry.checkpoints.some(
          (checkpoint) => checkpoint.checkpointTurnCount === 2 && checkpoint.files?.length === 0,
        ) && entry.activities.some((activity) => activity.kind === "checkpoint.revert.succeeded"),
    );
    const afterFirstUndo = (await Effect.runPromise(harness.engine.getReadModel())).threads.find(
      (entry) => entry.id === threadId,
    );
    expect(afterFirstUndo?.activities.map((activity) => activity.kind)).toEqual([
      "checkpoint.revert.started",
      "checkpoint.revert.succeeded",
    ]);
    expect(
      afterFirstUndo?.checkpoints.find((checkpoint) => checkpoint.checkpointTurnCount === 2)?.files,
    ).toEqual([]);
    expect(fs.readFileSync(path.join(harness.cwd, "one.txt"), "utf8")).toBe("one\n");
    expect(fs.existsSync(path.join(harness.cwd, "two.txt"))).toBe(false);

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.checkpoint.revert",
        commandId: CommandId.makeUnsafe("cmd-undo-files-turn-1"),
        threadId,
        turnCount: 1,
        scope: "files",
        createdAt,
      }),
    );
    await waitForThread(harness.engine, (entry) =>
      entry.checkpoints.some(
        (checkpoint) => checkpoint.checkpointTurnCount === 1 && checkpoint.files?.length === 0,
      ),
    );

    const readModel = await Effect.runPromise(harness.engine.getReadModel());
    const thread = readModel.threads.find((entry) => entry.id === threadId);
    expect(
      thread?.checkpoints
        .filter((checkpoint) => !checkpoint.checkpointRef.startsWith("provider-diff:"))
        .every((checkpoint) => checkpoint.files.length === 0),
    ).toBe(true);
    expect(thread?.latestTurn?.turnId).toBe(placeholderTurnId);
    expect(thread?.messages.map((message) => message.text)).toEqual([
      "Change two files",
      "Changed them",
    ]);
    expect(harness.provider.rollbackConversation).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(harness.cwd, "one.txt"))).toBe(false);
    expect(fs.existsSync(path.join(harness.cwd, "two.txt"))).toBe(false);
    expect(gitRefExists(harness.cwd, checkpointRefForThreadTurn(threadId, 1))).toBe(true);
    expect(gitRefExists(harness.cwd, checkpointRefForThreadTurn(threadId, 2))).toBe(true);
    expect(runGit(harness.cwd, ["rev-parse", checkpointRefForThreadTurn(threadId, 1)]).trim()).toBe(
      runGit(harness.cwd, ["rev-parse", checkpointRefForThreadTurn(threadId, 2)]).trim(),
    );
    expect(
      runGit(harness.cwd, [
        "rev-parse",
        checkpointRefForThreadTurnStart(threadId, turnTwoId),
      ]).trim(),
    ).toBe(runGit(harness.cwd, ["rev-parse", checkpointRefForThreadTurn(threadId, 1)]).trim());
    expect(
      runGit(harness.cwd, [
        "ls-tree",
        "-r",
        "--name-only",
        checkpointRefForThreadTurnStart(threadId, turnTwoId),
      ]),
    ).not.toContain("one.txt");
    expect(runGit(harness.cwd, ["diff", "--cached", "--name-only"]).trim()).toBe("");
    const events = await Effect.runPromise(
      Stream.runCollect(harness.engine.readEvents(0)).pipe(
        Effect.map((chunk) => Array.from(chunk)),
      ),
    );
    const fileUndoEvent = events.find(
      (event) =>
        event.type === "thread.turn-diff-completed" &&
        event.payload.turnId === turnOneId &&
        event.payload.files.length === 0,
    );
    expect(fileUndoEvent?.type === "thread.turn-diff-completed").toBe(true);
    if (fileUndoEvent?.type === "thread.turn-diff-completed") {
      expect(fileUndoEvent.payload.preserveLatestTurn).toBe(true);
    }
    expect(events.some((event) => event.type === "thread.reverted")).toBe(false);

    fs.writeFileSync(path.join(harness.cwd, "later.txt"), "later\n", "utf8");
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.checkpoint.revert",
        commandId: CommandId.makeUnsafe("cmd-full-revert-after-files-undo"),
        threadId,
        turnCount: 1,
        scope: "thread",
        createdAt,
      }),
    );
    await waitForEvent(harness.engine, (event) => event.type === "thread.reverted");
    expect(fs.existsSync(path.join(harness.cwd, "one.txt"))).toBe(false);
    expect(fs.existsSync(path.join(harness.cwd, "two.txt"))).toBe(false);
    expect(fs.existsSync(path.join(harness.cwd, "later.txt"))).toBe(false);
    expect(harness.provider.rollbackConversation).toHaveBeenCalledTimes(1);
  });

  it("undoes staged renames without an active session or HEAD", async () => {
    const harness = await createHarness({
      hasSession: false,
      hasInitialCommit: false,
      seedFilesystemCheckpoints: false,
    });
    const createdAt = new Date().toISOString();
    const threadId = ThreadId.makeUnsafe("thread-1");

    await runtime!.runPromise(
      harness.checkpointStore.captureCheckpoint({
        cwd: harness.cwd,
        checkpointRef: checkpointRefForThreadTurn(threadId, 0),
      }),
    );
    fs.writeFileSync(path.join(harness.cwd, "before.txt"), "before\n", "utf8");
    runGit(harness.cwd, ["add", "before.txt"]);
    await runtime!.runPromise(
      harness.checkpointStore.captureCheckpoint({
        cwd: harness.cwd,
        checkpointRef: checkpointRefForThreadTurn(threadId, 1),
      }),
    );
    runGit(harness.cwd, ["mv", "before.txt", "after.txt"]);
    await runtime!.runPromise(
      harness.checkpointStore.captureCheckpoint({
        cwd: harness.cwd,
        checkpointRef: checkpointRefForThreadTurn(threadId, 2),
      }),
    );

    for (const [turnCount, turnId, filePath] of [
      [1, asTurnId("turn-unborn-add"), "before.txt"],
      [2, asTurnId("turn-unborn-rename"), "after.txt"],
    ] as const) {
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.diff.complete",
          commandId: CommandId.makeUnsafe(`cmd-unborn-diff-${turnCount}`),
          threadId,
          turnId,
          completedAt: createdAt,
          checkpointRef: checkpointRefForThreadTurn(threadId, turnCount),
          status: "ready",
          files: [{ path: filePath, kind: "modified", additions: 1, deletions: 0 }],
          checkpointTurnCount: turnCount,
          createdAt,
        }),
      );
    }

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.checkpoint.revert",
        commandId: CommandId.makeUnsafe("cmd-unborn-undo-rename"),
        threadId,
        turnCount: 2,
        scope: "files",
        createdAt,
      }),
    );
    await waitForThread(
      harness.engine,
      (entry) =>
        entry.checkpoints.some(
          (checkpoint) => checkpoint.checkpointTurnCount === 2 && checkpoint.files?.length === 0,
        ) && entry.activities.some((activity) => activity.kind === "checkpoint.revert.succeeded"),
    );

    expect(fs.existsSync(path.join(harness.cwd, "before.txt"))).toBe(true);
    expect(fs.existsSync(path.join(harness.cwd, "after.txt"))).toBe(false);
    expect(runGit(harness.cwd, ["diff", "--cached", "--name-only"])).toBe("before.txt\n");
    const thread = (await Effect.runPromise(harness.engine.getReadModel())).threads.find(
      (entry) => entry.id === threadId,
    );
    expect(thread?.activities.map((activity) => activity.kind)).toEqual([
      "checkpoint.revert.started",
      "checkpoint.revert.succeeded",
    ]);
    expect(harness.provider.rollbackConversation).not.toHaveBeenCalled();
  });

  it("does not undo files when the exact turn baseline is missing", async () => {
    const harness = await createHarness({ seedFilesystemCheckpoints: false });
    const createdAt = new Date().toISOString();
    const threadId = ThreadId.makeUnsafe("thread-1");
    const turnId = asTurnId("turn-missing-baseline");

    fs.writeFileSync(path.join(harness.cwd, "turn.txt"), "turn\n", "utf8");
    await runtime!.runPromise(
      harness.checkpointStore.captureCheckpoint({
        cwd: harness.cwd,
        checkpointRef: checkpointRefForThreadTurn(threadId, 1),
      }),
    );
    fs.writeFileSync(path.join(harness.cwd, "later.txt"), "later\n", "utf8");

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.makeUnsafe("cmd-missing-baseline-diff"),
        threadId,
        turnId,
        completedAt: createdAt,
        checkpointRef: checkpointRefForThreadTurn(threadId, 1),
        status: "ready",
        files: [{ path: "turn.txt", kind: "modified", additions: 1, deletions: 0 }],
        checkpointTurnCount: 1,
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.checkpoint.revert",
        commandId: CommandId.makeUnsafe("cmd-missing-baseline-undo"),
        threadId,
        turnCount: 1,
        scope: "files",
        createdAt,
      }),
    );

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some((activity) => activity.kind === "checkpoint.revert.failed"),
    );
    expect(thread.activities.some((activity) => activity.kind === "checkpoint.revert.failed")).toBe(
      true,
    );
    expect(fs.readFileSync(path.join(harness.cwd, "turn.txt"), "utf8")).toBe("turn\n");
    expect(fs.readFileSync(path.join(harness.cwd, "later.txt"), "utf8")).toBe("later\n");
    expect(harness.provider.rollbackConversation).not.toHaveBeenCalled();
  });

  it("rechecks live provider state before mutating a projected-idle thread", async () => {
    const harness = await createHarness({
      providerStatus: "running",
      providerActiveTurnId: asTurnId("runtime-turn"),
    });
    const createdAt = new Date().toISOString();
    const threadId = ThreadId.makeUnsafe("thread-1");

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-projected-ready-runtime-running"),
        threadId,
        session: {
          threadId,
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );
    for (const turnCount of [1, 2] as const) {
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.diff.complete",
          commandId: CommandId.makeUnsafe(`cmd-runtime-guard-diff-${turnCount}`),
          threadId,
          turnId: asTurnId(`runtime-guard-turn-${turnCount}`),
          completedAt: createdAt,
          checkpointRef: checkpointRefForThreadTurn(threadId, turnCount),
          status: "ready",
          files: [],
          checkpointTurnCount: turnCount,
          createdAt,
        }),
      );
    }

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.checkpoint.revert",
        commandId: CommandId.makeUnsafe("cmd-runtime-guard-revert"),
        threadId,
        turnCount: 1,
        scope: "thread",
        createdAt,
      }),
    );

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some((activity) => activity.kind === "checkpoint.revert.failed"),
    );
    expect(thread.activities.some((activity) => activity.kind === "checkpoint.revert.failed")).toBe(
      true,
    );
    expect(fs.readFileSync(path.join(harness.cwd, "README.md"), "utf8")).toBe("v3\n");
    expect(harness.provider.rollbackConversation).not.toHaveBeenCalled();
  });

  it("rejects a child-thread revert while its parent-owned provider session is active", async () => {
    const harness = await createHarness({
      providerStatus: "running",
      providerActiveTurnId: asTurnId("parent-runtime-turn"),
    });
    const createdAt = new Date().toISOString();
    const childThreadId = ThreadId.makeUnsafe("subagent:thread-1:child-revert");

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-child-revert-thread-create"),
        threadId: childThreadId,
        projectId: asProjectId("project-1"),
        title: "Child revert",
        modelSelection: { provider: "codex", model: "gpt-5-codex" },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        parentThreadId: ThreadId.makeUnsafe("thread-1"),
        branch: null,
        worktreePath: harness.cwd,
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.checkpoint.revert",
        commandId: CommandId.makeUnsafe("cmd-child-revert-active-parent"),
        threadId: childThreadId,
        turnCount: 0,
        scope: "thread",
        createdAt,
      }),
    );

    const events = await waitForEvent(
      harness.engine,
      (event) =>
        event.type === "thread.activity-appended" &&
        event.payload.threadId === childThreadId &&
        event.payload.activity.kind === "checkpoint.revert.failed",
    );
    const failure = events.find(
      (event) =>
        event.type === "thread.activity-appended" &&
        event.payload.threadId === childThreadId &&
        event.payload.activity.kind === "checkpoint.revert.failed",
    ) as Extract<OrchestrationEvent, { type: "thread.activity-appended" }>;

    expect(failure.payload.activity.payload).toMatchObject({
      detail: `Thread '${childThreadId}' has an active turn. Interrupt the current turn before reverting checkpoints.`,
    });
    expect(harness.provider.rollbackConversation).not.toHaveBeenCalled();
  });

  it.each([
    { location: "same", state: "projected", scope: "thread", allowed: false },
    { location: "alias", state: "projected", scope: "thread", allowed: false },
    { location: "nested", state: "projected", scope: "files", allowed: false },
    { location: "same", state: "runtime", scope: "thread", allowed: false },
    { location: "same", state: "pending", scope: "thread", allowed: false },
    { location: "worktree", state: "projected", scope: "thread", allowed: true },
    { location: "same", state: "error", scope: "thread", allowed: true },
    { location: "same", state: "idle", scope: "files", allowed: true },
  ] as const)(
    "guards shared workspace Undo: $location / $state / $scope",
    async ({ location, state: peerState, scope: revertScope, allowed }) => {
      const harness = await createHarness();
      await seedRevertableThread(harness, "shared-workspace-revert");
      const peerContainer = fs.mkdtempSync(path.join(os.tmpdir(), "synara-undo-peer-"));
      tempDirs.push(peerContainer);
      let peerCwd = harness.cwd;
      if (location === "alias") {
        peerCwd = path.join(peerContainer, "alias");
        fs.symlinkSync(harness.cwd, peerCwd, "dir");
      } else if (location === "nested") {
        peerCwd = path.join(harness.cwd, "nested");
        fs.mkdirSync(peerCwd);
      } else if (location === "worktree") {
        peerCwd = path.join(peerContainer, "worktree");
        runGit(harness.cwd, ["worktree", "add", "--detach", peerCwd, "HEAD"]);
      }
      const peerId = ThreadId.makeUnsafe("shared-workspace-peer");
      const createdAt = new Date().toISOString();
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.create",
          commandId: CommandId.makeUnsafe("shared-workspace-peer-create"),
          threadId: peerId,
          projectId: asProjectId("project-1"),
          title: "Working peer",
          modelSelection: { provider: "codex", model: "gpt-5-codex" },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: peerCwd,
          createdAt,
        }),
      );
      if (peerState === "projected" || peerState === "error")
        await Effect.runPromise(
          harness.engine.dispatch({
            type: "thread.session.set",
            commandId: CommandId.makeUnsafe("shared-workspace-peer-running"),
            threadId: peerId,
            session: {
              threadId: peerId,
              status: peerState === "error" ? "error" : "running",
              providerName: "codex",
              runtimeMode: "approval-required",
              activeTurnId: asTurnId("peer-live-turn"),
              lastError: null,
              updatedAt: createdAt,
            },
            createdAt,
          }),
        );
      if (peerState === "runtime") {
        const listSessions = harness.provider.service.listSessions;
        vi.spyOn(harness.provider.service, "listSessions").mockImplementation(() =>
          listSessions().pipe(
            Effect.map((sessions) => [
              ...sessions,
              {
                provider: "codex",
                status: "running",
                runtimeMode: "full-access",
                threadId: peerId,
                cwd: peerCwd,
                activeTurnId: asTurnId("peer-live-turn"),
                createdAt,
                updatedAt: createdAt,
              } satisfies ProviderSession,
            ]),
          ),
        );
      } else if (peerState === "pending") {
        await Effect.runPromise(
          harness.engine.dispatch({
            type: "thread.turn.start",
            commandId: CommandId.makeUnsafe("shared-workspace-pending-start"),
            threadId: peerId,
            message: {
              messageId: MessageId.makeUnsafe("peer-pending-message"),
              role: "user",
              text: "edit workspace",
              attachments: [],
            },
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            runtimeMode: "approval-required",
            createdAt,
          }),
        );
      }
      if (revertScope === "files")
        await Effect.runPromise(
          harness.engine.dispatch({
            type: "thread.turn.diff.complete",
            commandId: CommandId.makeUnsafe("shared-workspace-files-diff"),
            threadId: ThreadId.makeUnsafe("thread-1"),
            turnId: asTurnId("turn-2"),
            completedAt: createdAt,
            checkpointRef: checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 2),
            status: "ready",
            files: [{ path: "README.md", kind: "modified", additions: 1, deletions: 1 }],
            checkpointTurnCount: 2,
            createdAt,
          }),
        );
      const initialText = revertScope === "files" ? "v3\n" : "peer's live edits\n";
      fs.writeFileSync(path.join(harness.cwd, "README.md"), initialText, "utf8");
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.checkpoint.revert",
          commandId: CommandId.makeUnsafe("shared-workspace-revert-request"),
          threadId: ThreadId.makeUnsafe("thread-1"),
          turnCount: revertScope === "files" ? 2 : 1,
          scope: revertScope,
          createdAt,
        }),
      );
      await harness.drain();
      expect(fs.readFileSync(path.join(harness.cwd, "README.md"), "utf8")).toBe(
        allowed ? "v2\n" : initialText,
      );
      const state = await Effect.runPromise(harness.engine.getReadModel());
      const target = state.threads.find((entry) => entry.id === "thread-1");
      expect(target?.checkpoints).toHaveLength(allowed && revertScope === "thread" ? 1 : 2);
      expect(
        target?.activities.some((activity) => activity.kind === "checkpoint.revert.failed"),
      ).toBe(!allowed);
      expect(harness.provider.rollbackConversation).toHaveBeenCalledTimes(
        allowed && revertScope === "thread" ? 1 : 0,
      );
      expect(listRevertRescueRefs(harness.cwd)).toEqual([]);
    },
  );

  it("keeps full thread revert behavior for explicit thread scope", async () => {
    const harness = await createHarness();
    const createdAt = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.makeUnsafe("cmd-diff-1"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        turnId: asTurnId("turn-1"),
        completedAt: createdAt,
        checkpointRef: checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 1),
        status: "ready",
        files: [],
        checkpointTurnCount: 1,
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.makeUnsafe("cmd-diff-2"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        turnId: asTurnId("turn-2"),
        completedAt: createdAt,
        checkpointRef: checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 2),
        status: "ready",
        files: [],
        checkpointTurnCount: 2,
        createdAt,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.checkpoint.revert",
        commandId: CommandId.makeUnsafe("cmd-revert-request"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        turnCount: 1,
        scope: "thread",
        createdAt,
      }),
    );

    await waitForEvent(harness.engine, (event) => event.type === "thread.reverted");
    const thread = await waitForThread(harness.engine, (entry) => entry.checkpoints.length === 1);

    expect(thread.latestTurn?.turnId).toBe("turn-1");
    expect(thread.checkpoints).toHaveLength(1);
    expect(thread.checkpoints[0]?.checkpointTurnCount).toBe(1);
    expect(harness.provider.rollbackConversation).toHaveBeenCalledTimes(1);
    expect(harness.provider.rollbackConversation).toHaveBeenCalledWith({
      threadId: ThreadId.makeUnsafe("thread-1"),
      numTurns: 1,
    });
    expect(fs.readFileSync(path.join(harness.cwd, "README.md"), "utf8")).toBe("v2\n");
    // Stale refs are dropped only after the completion commits, so `thread.reverted`
    // does not imply the cleanup already ran.
    await waitForGitRefMissing(
      harness.cwd,
      checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 2),
    );
    expect(
      gitRefExists(harness.cwd, checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 2)),
    ).toBe(false);
    await harness.drain();
    // The rescue snapshot is throwaway: a successful revert must not leave one
    // behind, since nothing else ever sweeps them.
    expect(listRevertRescueRefs(harness.cwd)).toEqual([]);
  });

  it("reverts a thread whose provider session is no longer running", async () => {
    const harness = await createHarness({ hasSession: false });
    const createdAt = new Date().toISOString();

    for (const turnCount of [1, 2] as const) {
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.diff.complete",
          commandId: CommandId.makeUnsafe(`cmd-sessionless-revert-diff-${turnCount}`),
          threadId: ThreadId.makeUnsafe("thread-1"),
          turnId: asTurnId(`turn-${turnCount}`),
          completedAt: createdAt,
          checkpointRef: checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), turnCount),
          status: "ready",
          files: [],
          checkpointTurnCount: turnCount,
          createdAt,
        }),
      );
    }

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.checkpoint.revert",
        commandId: CommandId.makeUnsafe("cmd-sessionless-revert"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        turnCount: 1,
        scope: "thread",
        createdAt,
      }),
    );

    // Checkpoints and the provider binding both outlive an idle stop, so the
    // workspace must resolve from the thread/project instead of a live session.
    await waitForEvent(harness.engine, (event) => event.type === "thread.reverted");
    expect(fs.readFileSync(path.join(harness.cwd, "README.md"), "utf8")).toBe("v2\n");
    expect(harness.provider.rollbackConversation).toHaveBeenCalledWith({
      threadId: ThreadId.makeUnsafe("thread-1"),
      numTurns: 1,
    });
  });

  it("restores the workspace when provider conversation rollback fails", async () => {
    const harness = await createHarness();
    const createdAt = new Date().toISOString();
    fs.writeFileSync(path.join(harness.cwd, "untracked-before-revert.txt"), "preserve\n", "utf8");
    harness.provider.rollbackConversation.mockImplementationOnce(() =>
      Effect.fail(new ProviderSessionNotFoundError({ threadId: "thread-1" })),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-compensated-revert-session-set"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );
    for (const turnCount of [1, 2] as const) {
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.diff.complete",
          commandId: CommandId.makeUnsafe(`cmd-compensated-revert-diff-${turnCount}`),
          threadId: ThreadId.makeUnsafe("thread-1"),
          turnId: asTurnId(`turn-${turnCount}`),
          completedAt: createdAt,
          checkpointRef: checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), turnCount),
          status: "ready",
          files: [],
          checkpointTurnCount: turnCount,
          createdAt,
        }),
      );
    }

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.checkpoint.revert",
        commandId: CommandId.makeUnsafe("cmd-compensated-revert"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        turnCount: 1,
        scope: "thread",
        createdAt,
      }),
    );

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some((activity) => activity.kind === "checkpoint.revert.failed"),
    );
    expect(thread.activities.some((activity) => activity.kind === "checkpoint.revert.failed")).toBe(
      true,
    );
    // Proves the revert was refused by the provider and not by an earlier
    // precondition, so the worktree really was restored before compensation.
    expect(harness.provider.rollbackConversation).toHaveBeenCalledWith({
      threadId: ThreadId.makeUnsafe("thread-1"),
      numTurns: 1,
    });
    // The worktree — tracked and untracked alike — must land exactly where it
    // started, because the conversation was never trimmed.
    expect(fs.readFileSync(path.join(harness.cwd, "README.md"), "utf8")).toBe("v3\n");
    expect(fs.readFileSync(path.join(harness.cwd, "untracked-before-revert.txt"), "utf8")).toBe(
      "preserve\n",
    );
    // Cleanup runs only after the completion commits, which never happened.
    expect(
      gitRefExists(harness.cwd, checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 2)),
    ).toBe(true);
    await harness.drain();
    expect(listRevertRescueRefs(harness.cwd)).toEqual([]);
  });

  /**
   * Bring a harness to the state every thread-scope revert test needs: a ready
   * session and two completed turns whose filesystem checkpoints already exist.
   */
  async function seedRevertableThread(
    harness: Awaited<ReturnType<typeof createHarness>>,
    commandPrefix: string,
  ) {
    const createdAt = new Date().toISOString();
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe(`${commandPrefix}-session-set`),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );
    for (const turnCount of [1, 2] as const) {
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.diff.complete",
          commandId: CommandId.makeUnsafe(`${commandPrefix}-diff-${turnCount}`),
          threadId: ThreadId.makeUnsafe("thread-1"),
          turnId: asTurnId(`turn-${turnCount}`),
          completedAt: createdAt,
          checkpointRef: checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), turnCount),
          status: "ready",
          files: [],
          checkpointTurnCount: turnCount,
          createdAt,
        }),
      );
    }
    return createdAt;
  }

  const simulatedRestoreFailure = (cwd: string, detail: string) =>
    new GitCommandError({
      operation: "CheckpointStore.restoreCheckpoint",
      command: "git read-tree",
      cwd,
      detail,
    });

  it("puts the workspace back when the checkpoint restore fails partway through", async () => {
    const harness = await createHarness();
    const threadId = ThreadId.makeUnsafe("thread-1");
    const untrackedPath = path.join(harness.cwd, "untracked-before-revert.txt");
    fs.writeFileSync(untrackedPath, "preserve\n", "utf8");
    const createdAt = await seedRevertableThread(harness, "cmd-partial-restore");

    // A restore is not atomic: it can rewrite part of the tree and then fail.
    // Nothing observable distinguishes that from "the checkpoint was missing and
    // nothing was touched", so the saga has to treat a failure as destructive.
    const targetCheckpointRef = checkpointRefForThreadTurn(threadId, 2);
    harness.failures.restoreCheckpoint = (input) => {
      if (input.checkpointRef !== targetCheckpointRef) {
        return null;
      }
      fs.writeFileSync(path.join(harness.cwd, "README.md"), "half-restored\n", "utf8");
      fs.rmSync(untrackedPath, { force: true });
      return simulatedRestoreFailure(harness.cwd, "simulated mid-restore failure");
    };

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.checkpoint.revert",
        commandId: CommandId.makeUnsafe("cmd-partial-restore-revert"),
        threadId,
        turnCount: 2,
        scope: "thread",
        createdAt,
      }),
    );

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some((activity) => activity.kind === "checkpoint.revert.failed"),
    );
    // The rescue snapshot exists precisely for this: the pre-revert tree is the
    // only correct outcome of a revert that could not finish.
    expect(fs.readFileSync(path.join(harness.cwd, "README.md"), "utf8")).toBe("v3\n");
    expect(fs.readFileSync(untrackedPath, "utf8")).toBe("preserve\n");
    // Nothing was trimmed, so the conversation must be untouched too.
    expect(harness.provider.rollbackConversation).not.toHaveBeenCalled();
    // Compensation succeeded, so the snapshot has done its job and must not leak.
    await harness.drain();
    expect(listRevertRescueRefs(harness.cwd)).toEqual([]);
    const failure = thread.activities.find(
      (activity) => activity.kind === "checkpoint.revert.failed",
    );
    expect(String((failure?.payload as { detail?: string } | undefined)?.detail)).toContain(
      "the workspace was put back",
    );
  });

  it("keeps and names the rescue snapshot when the workspace cannot be put back", async () => {
    const harness = await createHarness();
    const threadId = ThreadId.makeUnsafe("thread-1");
    const createdAt = await seedRevertableThread(harness, "cmd-uncompensated-restore");

    // Every restore fails: the target one leaves the tree half-written, and the
    // compensating one cannot undo it. The snapshot is now the only copy of the
    // pre-revert workspace in existence.
    harness.failures.restoreCheckpoint = (input) => {
      if (input.checkpointRef === checkpointRefForThreadTurn(threadId, 1)) {
        fs.writeFileSync(path.join(harness.cwd, "README.md"), "half-restored\n", "utf8");
        return simulatedRestoreFailure(harness.cwd, "simulated mid-restore failure");
      }
      return input.checkpointRef.includes("/revert-rescue/")
        ? simulatedRestoreFailure(harness.cwd, "simulated compensation failure")
        : null;
    };

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.checkpoint.revert",
        commandId: CommandId.makeUnsafe("cmd-uncompensated-restore-revert"),
        threadId,
        turnCount: 1,
        scope: "thread",
        createdAt,
      }),
    );

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some((activity) => activity.kind === "checkpoint.revert.failed"),
    );
    const rescueRefs = listRevertRescueRefs(harness.cwd);
    expect(rescueRefs).toHaveLength(1);
    const failure = thread.activities.find(
      (activity) => activity.kind === "checkpoint.revert.failed",
    );
    const payload = failure?.payload as { detail?: string } | undefined;
    // Name it in the human-readable detail so a person can find and restore it.
    expect(payload?.detail).toContain(rescueRefs[0]);
  });

  it("keeps a failed rescue cleanup recoverable after restoring the workspace", async () => {
    const harness = await createHarness();
    const threadId = ThreadId.makeUnsafe("thread-1");
    const createdAt = await seedRevertableThread(harness, "cmd-rescue-cleanup-failure");
    const targetCheckpointRef = checkpointRefForThreadTurn(threadId, 2);

    harness.failures.restoreCheckpoint = (input) =>
      input.checkpointRef === targetCheckpointRef
        ? simulatedRestoreFailure(harness.cwd, "simulated target restore failure")
        : null;
    harness.failures.deleteCheckpointRefs = (input) =>
      input.checkpointRefs.some((checkpointRef) => checkpointRef.includes("/revert-rescue/"))
        ? new GitCommandError({
            operation: "CheckpointStore.deleteCheckpointRefs",
            command: "git update-ref -d",
            cwd: harness.cwd,
            detail: "simulated rescue cleanup failure",
          })
        : null;

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.checkpoint.revert",
        commandId: CommandId.makeUnsafe("cmd-rescue-cleanup-failure-revert"),
        threadId,
        turnCount: 2,
        scope: "thread",
        createdAt,
      }),
    );

    await waitForThread(harness.engine, (entry) =>
      entry.activities.some((activity) => activity.kind === "checkpoint.revert.failed"),
    );
    await harness.drain();

    expect(fs.readFileSync(path.join(harness.cwd, "README.md"), "utf8")).toBe("v3\n");
    expect(listRevertRescueRefs(harness.cwd)).toHaveLength(1);
  });

  it("restores turn zero from the persisted checkpoint family", async () => {
    const harness = await createHarness({ seedFilesystemCheckpoints: false });
    const createdAt = new Date().toISOString();
    const threadId = ThreadId.makeUnsafe("thread-1");
    const historicalTurnZeroRef = checkpointRefForThreadTurn(threadId, 0).replace(
      "refs/synara/",
      "refs/historical/",
    );
    const historicalTurnOneRef = CheckpointRef.makeUnsafe(
      checkpointRefForThreadTurn(threadId, 1).replace("refs/synara/", "refs/historical/"),
    );

    runGit(harness.cwd, ["update-ref", historicalTurnZeroRef, "HEAD"]);
    fs.writeFileSync(path.join(harness.cwd, "README.md"), "v2\n", "utf8");
    runGit(harness.cwd, ["add", "."]);
    runGit(harness.cwd, ["commit", "-m", "Second"]);
    runGit(harness.cwd, ["update-ref", historicalTurnOneRef, "HEAD"]);
    fs.writeFileSync(path.join(harness.cwd, "README.md"), "v3\n", "utf8");

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-historical-session-set"),
        threadId,
        session: {
          threadId,
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.makeUnsafe("cmd-historical-diff-1"),
        threadId,
        turnId: asTurnId("turn-1"),
        completedAt: createdAt,
        checkpointRef: historicalTurnOneRef,
        status: "ready",
        files: [],
        checkpointTurnCount: 1,
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.checkpoint.revert",
        commandId: CommandId.makeUnsafe("cmd-historical-revert-zero"),
        threadId,
        turnCount: 0,
        createdAt,
      }),
    );

    await waitForEvent(harness.engine, (event) => event.type === "thread.reverted");
    expect(fs.readFileSync(path.join(harness.cwd, "README.md"), "utf8")).toBe("v1\n");
  });

  it("refuses turn zero when the exact baseline is missing without touching the workspace", async () => {
    const harness = await createHarness({ seedFilesystemCheckpoints: false });
    const createdAt = new Date().toISOString();
    const threadId = ThreadId.makeUnsafe("thread-1");
    const turnOneRef = checkpointRefForThreadTurn(threadId, 1);

    runGit(harness.cwd, ["update-ref", turnOneRef, "HEAD"]);
    fs.writeFileSync(path.join(harness.cwd, "README.md"), "v2\n", "utf8");
    runGit(harness.cwd, ["add", "README.md"]);
    runGit(harness.cwd, ["commit", "-m", "Move HEAD after the missing baseline"]);
    fs.writeFileSync(path.join(harness.cwd, "README.md"), "tracked working change\n", "utf8");
    fs.writeFileSync(path.join(harness.cwd, "untracked.txt"), "keep me\n", "utf8");

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-missing-zero-session-set"),
        threadId,
        session: {
          threadId,
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.makeUnsafe("cmd-missing-zero-diff"),
        threadId,
        turnId: asTurnId("turn-1"),
        completedAt: createdAt,
        checkpointRef: turnOneRef,
        status: "ready",
        files: [],
        checkpointTurnCount: 1,
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.checkpoint.revert",
        commandId: CommandId.makeUnsafe("cmd-missing-zero-revert"),
        threadId,
        turnCount: 0,
        scope: "thread",
        createdAt,
      }),
    );

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.activities.some((activity) => activity.kind === "checkpoint.revert.failed"),
    );
    expect(thread.activities.some((activity) => activity.kind === "checkpoint.revert.failed")).toBe(
      true,
    );
    expect(fs.readFileSync(path.join(harness.cwd, "README.md"), "utf8")).toBe(
      "tracked working change\n",
    );
    expect(fs.readFileSync(path.join(harness.cwd, "untracked.txt"), "utf8")).toBe("keep me\n");
    expect(harness.provider.rollbackConversation).not.toHaveBeenCalled();
  });

  it("processes consecutive revert requests with deterministic rollback sequencing", async () => {
    const harness = await createHarness();
    const createdAt = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-set-inline-revert"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.makeUnsafe("cmd-inline-revert-diff-1"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        turnId: asTurnId("turn-1"),
        completedAt: createdAt,
        checkpointRef: checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 1),
        status: "ready",
        files: [],
        checkpointTurnCount: 1,
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.makeUnsafe("cmd-inline-revert-diff-2"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        turnId: asTurnId("turn-2"),
        completedAt: createdAt,
        checkpointRef: checkpointRefForThreadTurn(ThreadId.makeUnsafe("thread-1"), 2),
        status: "ready",
        files: [],
        checkpointTurnCount: 2,
        createdAt,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.checkpoint.revert",
        commandId: CommandId.makeUnsafe("cmd-sequenced-revert-request-1"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        turnCount: 1,
        createdAt,
      }),
    );
    await waitForThread(
      harness.engine,
      (entry) =>
        entry.activities.filter((activity) => activity.kind === "checkpoint.revert.succeeded")
          .length === 1,
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.checkpoint.revert",
        commandId: CommandId.makeUnsafe("cmd-sequenced-revert-request-0"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        turnCount: 0,
        createdAt,
      }),
    );

    const deadline = Date.now() + 20_000;
    const waitForRollbackCalls = async (): Promise<void> => {
      if (harness.provider.rollbackConversation.mock.calls.length >= 2) {
        return;
      }
      if (Date.now() >= deadline) {
        throw new Error("Timed out waiting for rollbackConversation calls.");
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
      return waitForRollbackCalls();
    };
    await waitForRollbackCalls();
    const settledThread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.activities.filter((activity) => activity.kind === "checkpoint.revert.succeeded")
          .length === 2,
    );

    expect(harness.provider.rollbackConversation).toHaveBeenCalledTimes(2);
    expect(harness.provider.rollbackConversation.mock.calls[0]?.[0]).toEqual({
      threadId: ThreadId.makeUnsafe("thread-1"),
      numTurns: 1,
    });
    expect(harness.provider.rollbackConversation.mock.calls[1]?.[0]).toEqual({
      threadId: ThreadId.makeUnsafe("thread-1"),
      numTurns: 1,
    });
    expect(
      settledThread.activities.filter((activity) => activity.kind === "checkpoint.revert.started"),
    ).toHaveLength(2);
    expect(
      settledThread.activities.filter(
        (activity) => activity.kind === "checkpoint.revert.succeeded",
      ),
    ).toHaveLength(2);
    expect(
      settledThread.activities.some((activity) => activity.kind === "checkpoint.revert.failed"),
    ).toBe(false);
  });

  it("appends an error activity when the requested turn count has no recorded checkpoint", async () => {
    // No `thread.turn.diff.complete` is dispatched, so the thread's current turn
    // count is zero. The missing provider session is deliberate but incidental:
    // a sessionless thread reverts fine once its checkpoints exist.
    const harness = await createHarness({ hasSession: false });
    const createdAt = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.checkpoint.revert",
        commandId: CommandId.makeUnsafe("cmd-revert-unknown-turn-count"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        turnCount: 1,
        createdAt,
      }),
    );

    const events = await waitForEvent(
      harness.engine,
      (event) =>
        event.type === "thread.activity-appended" &&
        event.payload.activity.kind === "checkpoint.revert.failed",
    );
    const failure = events.find(
      (event) =>
        event.type === "thread.activity-appended" &&
        event.payload.activity.kind === "checkpoint.revert.failed",
    ) as Extract<OrchestrationEvent, { type: "thread.activity-appended" }>;

    expect(failure.payload.activity.payload).toMatchObject({
      detail: "Checkpoint turn count 1 exceeds current turn count 0.",
    });
    expect(harness.provider.rollbackConversation).not.toHaveBeenCalled();
  });
});
