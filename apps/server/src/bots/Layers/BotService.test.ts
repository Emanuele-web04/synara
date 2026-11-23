import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  BOT_CARD_RESOLVED_ACTIVITY_KIND,
  BOT_DELEGATION_MESSAGE_PREFIX,
  BotCard,
  BOT_REPORT_MESSAGE_PREFIX,
  DEFAULT_PROJECT_AGENT_LIMITS,
  DEFAULT_SERVER_SETTINGS,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  type HubWorkRecord,
  type ModelSelection,
  type OrchestrationCommand,
  type ProjectAgentConfig,
} from "@synara/contracts";
import { Deferred, Effect, Fiber, Layer, Option, Schema, Stream } from "effect";
import { TestClock } from "effect/testing";
import { beforeEach, vi } from "vitest";

import { accountStateDirectory } from "../../accountAuth.ts";
import { ServerConfig } from "../../config.ts";
import { GitCore } from "../../git/Services/GitCore.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { BotRepositoryLive } from "../../persistence/Layers/BotRepository.ts";
import { HubWorkRepositoryLive } from "../../persistence/Layers/HubWorkRepository.ts";
import { ProjectAgentRepositoryLive } from "../../persistence/Layers/ProjectAgentRepository.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { BotRepository } from "../../persistence/Services/BotRepository.ts";
import { HubWorkRepository } from "../../persistence/Services/HubWorkRepository.ts";
import { ProjectAgentRepository } from "../../persistence/Services/ProjectAgentRepository.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import { ProjectAgentService } from "../../projectAgent/Services/ProjectAgentService.ts";
import { ProviderHealth } from "../../provider/Services/ProviderHealth.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { BotService } from "../Services/BotService.ts";
import { clearServerAltoAccess } from "../synbotGate.ts";
import { BotServiceLive } from "./BotService.ts";

/**
 * The Alto gate as these tests see it. A Vitest worker has no desktop flavor, which the real gate
 * treats as a host that requires Alto; tests run as a free host unless they say otherwise, and
 * count the entitlement checks that reach the Account API.
 */
const gate = vi.hoisted(() => ({
  requiresAlto: false,
  granted: true,
  checks: 0,
  /** While set, every entitlement check waits for it, as a slow Account API would. */
  hold: null as Promise<void> | null,
}));
vi.mock("../synbotGate.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../synbotGate.ts")>();
  return {
    ...actual,
    requiresServerSynbotAlto: () => gate.requiresAlto,
    checkServerSynbotAltoAccess: async () => {
      if (!gate.requiresAlto) return true;
      gate.checks += 1;
      if (gate.hold) await gate.hold;
      return gate.granted;
    },
  };
});

beforeEach(() => {
  gate.requiresAlto = false;
  gate.granted = true;
  gate.checks = 0;
  gate.hold = null;
});

const now = "2026-11-05T10:00:00.000Z";
const model = { provider: "codex", model: "gpt-6-luna" } as unknown as ModelSelection;

interface Fixture {
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly name: string;
  readonly kind: "main" | "bot";
  readonly autonomy?: "auto" | "ask";
}

const MAIN: Fixture = {
  projectId: ProjectId.makeUnsafe("bot-main"),
  threadId: ThreadId.makeUnsafe("thread-main"),
  name: "SynBot",
  kind: "main",
};
const FRONTEND: Fixture = {
  projectId: ProjectId.makeUnsafe("bot-frontend"),
  threadId: ThreadId.makeUnsafe("thread-frontend"),
  name: "Frontend",
  kind: "bot",
};
const QA: Fixture = {
  projectId: ProjectId.makeUnsafe("bot-qa"),
  threadId: ThreadId.makeUnsafe("thread-qa"),
  name: "QA",
  kind: "bot",
  autonomy: "ask",
};

/** Mutable world the mocks read: turns, messages and shells per thread. */
function makeWorld() {
  const dispatched: OrchestrationCommand[] = [];
  const turns = new Map<string, Array<Record<string, unknown>>>();
  const messages = new Map<string, Array<Record<string, unknown>>>();
  const shells = new Map<string, Record<string, unknown>>();
  for (const fixture of [MAIN, FRONTEND, QA]) {
    shells.set(fixture.threadId, {
      id: fixture.threadId,
      projectId: fixture.projectId,
      runtimeMode: "approval-required",
      interactionMode: "default",
      session: null,
      latestTurn: null,
      lastKnownPr: null,
    });
    turns.set(fixture.threadId, []);
    messages.set(fixture.threadId, []);
  }
  /** Holds the settle sweep inside its read of one thread's turns, to order it against Stop. */
  const gate: {
    current: {
      readonly threadId: ThreadId;
      readonly reached: Deferred.Deferred<void>;
      readonly release: Deferred.Deferred<void>;
    } | null;
  } = { current: null };
  /** Turn starts fail while set, as when the engine cannot take the command. */
  const failTurnStarts = { current: false };
  /**
   * The projection's pending turn start per thread: one slot, as in ProjectionTurns. Dispatched
   * turn starts fill it only while `projectPendingStarts` is set; a test clears it the way a
   * provider turn that starts running does.
   */
  const pendingStarts = new Map<string, string>();
  const projectPendingStarts = { current: false };
  return {
    dispatched,
    turns,
    messages,
    shells,
    gate,
    failTurnStarts,
    pendingStarts,
    projectPendingStarts,
  };
}

type World = ReturnType<typeof makeWorld>;

function makeLayer(world: World) {
  const snapshot = Layer.succeed(ProjectionSnapshotQuery, {
    getThreadShellById: (threadId: ThreadId) =>
      Effect.succeed(Option.fromNullishOr(world.shells.get(threadId)) as never),
    getThreadDetailWithoutActivitiesById: (threadId: ThreadId) =>
      Effect.succeed(
        Option.some({ id: threadId, messages: world.messages.get(threadId) ?? [] }) as never,
      ),
    getThreadDetailById: (threadId: ThreadId) =>
      Effect.succeed(
        Option.some({
          id: threadId,
          messages: world.messages.get(threadId) ?? [],
          // The activities the service appended to this thread, as the projection would hold them.
          activities: world.dispatched.flatMap((command) =>
            command.type === "thread.activity.append" && command.threadId === threadId
              ? [command.activity]
              : [],
          ),
        }) as never,
      ),
    getProjectShellById: () => Effect.succeed(Option.none()),
    getProjectShellsByIds: () => Effect.succeed([]),
    getShellSnapshot: () => Effect.succeed({ projects: [], threads: [], spaces: [] } as never),
  } as unknown as ProjectionSnapshotQuery["Service"]);
  const turnsLayer = Layer.succeed(ProjectionTurnRepository, {
    listByThreadId: (input: { threadId: string }) =>
      Effect.gen(function* () {
        const gate = world.gate.current;
        if (gate && gate.threadId === input.threadId) {
          yield* Deferred.succeed(gate.reached, undefined);
          yield* Deferred.await(gate.release);
        }
        return world.turns.get(input.threadId) ?? [];
      }),
    getPendingTurnStartByThreadId: (input: { threadId: string }) =>
      Effect.sync(() => {
        const messageId = world.pendingStarts.get(input.threadId);
        return messageId === undefined
          ? Option.none()
          : Option.some({ threadId: input.threadId, messageId } as never);
      }),
    getByTurnId: (input: { threadId: string; turnId: string }) =>
      Effect.succeed(
        Option.fromNullishOr(
          (world.turns.get(input.threadId) ?? []).find(
            (turn) => turn.turnId === input.turnId,
          ) as never,
        ),
      ),
  } as unknown as ProjectionTurnRepository["Service"]);
  const engine = Layer.succeed(OrchestrationEngineService, {
    dispatch: (command: OrchestrationCommand) =>
      command.type === "thread.turn.start" && world.failTurnStarts.current
        ? Effect.fail({ _tag: "EngineUnavailable", message: "The engine is busy." })
        : Effect.sync(() => {
            world.dispatched.push(command);
            if (command.type === "thread.turn.start" && world.projectPendingStarts.current) {
              world.pendingStarts.set(command.threadId, command.message.messageId);
            }
            return { sequence: world.dispatched.length };
          }),
  } as unknown as OrchestrationEngineService["Service"]);
  const projectAgent = Layer.succeed(ProjectAgentService, {
    streamWorkItemEvents: () => Stream.never,
    linkProject: () => Effect.void,
    unlinkProject: () => Effect.void,
    pauseGroup: () => Effect.void,
  } as unknown as ProjectAgentService["Service"]);
  return BotServiceLive.pipe(
    Layer.provide(snapshot),
    Layer.provide(turnsLayer),
    Layer.provide(engine),
    Layer.provide(projectAgent),
    Layer.provide(
      Layer.succeed(ServerSettingsService, {
        getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
      } as unknown as ServerSettingsService["Service"]),
    ),
    Layer.provide(
      Layer.succeed(ProviderHealth, {
        getStatuses: Effect.succeed([]),
        refresh: Effect.succeed([]),
      } as unknown as ProviderHealth["Service"]),
    ),
    Layer.provide(Layer.succeed(GitCore, {} as unknown as GitCore["Service"])),
    Layer.provideMerge(BotRepositoryLive),
    Layer.provideMerge(ProjectAgentRepositoryLive),
    Layer.provideMerge(HubWorkRepositoryLive),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "synbot-" })),
    Layer.provideMerge(NodeServices.layer),
  );
}

const seed = Effect.gen(function* () {
  const configs = yield* ProjectAgentRepository;
  const bots = yield* BotRepository;
  for (const fixture of [MAIN, FRONTEND, QA]) {
    const config: ProjectAgentConfig = {
      projectId: fixture.projectId,
      coordinatorThreadId: fixture.threadId,
      coordinatorName: fixture.name,
      coordinatorModelSelection: model,
      limits: { ...DEFAULT_PROJECT_AGENT_LIMITS, maxConcurrentWorkers: 1 },
      captureEnabled: true,
      enabled: true,
      automationId: null,
      revision: 1,
      createdAt: now,
      updatedAt: now,
      disabledAt: null,
    };
    yield* configs.saveConfig(config, null);
    yield* bots.upsertProfile({
      projectId: fixture.projectId,
      kind: fixture.kind,
      role: fixture.name,
      mascot: { shape: fixture.kind === "main" ? "synara" : "circle", color: "#1a80fa" },
      scope: { projects: "all", paths: [] },
      autonomy: fixture.autonomy ?? "auto",
      pinnedSkills: [],
      pinned: false,
      revision: 0,
      createdAt: now,
      updatedAt: now,
    });
  }
});

/** The user typed in SynBot's chat: a human message started turn `turn-user`. */
function userTurn(world: World) {
  world.messages.get(MAIN.threadId)!.push({
    id: MessageId.makeUnsafe("msg-user"),
    role: "user",
    text: "Add multiply to the frontend and test it",
    attachments: [],
    turnId: TurnId.makeUnsafe("turn-user"),
    streaming: false,
    createdAt: now,
    updatedAt: now,
  });
  world.turns.get(MAIN.threadId)!.push({
    threadId: MAIN.threadId,
    turnId: TurnId.makeUnsafe("turn-user"),
    pendingMessageId: MessageId.makeUnsafe("msg-user"),
    state: "running",
    requestedAt: now,
    completedAt: null,
    assistantMessageId: null,
  });
}

const turnStarts = (world: World, threadId: ThreadId) =>
  world.dispatched.filter(
    (command): command is Extract<OrchestrationCommand, { type: "thread.turn.start" }> =>
      command.type === "thread.turn.start" && command.threadId === threadId,
  );

it.effect("delegates from a user request with provenance, then settles and reports once", () => {
  const world = makeWorld();
  return Effect.gen(function* () {
    yield* seed;
    userTurn(world);
    const bots = yield* BotService;
    const caller = yield* bots.resolveCaller({ threadId: MAIN.threadId, turnId: "turn-user" });
    assert.ok(caller);
    assert.strictEqual(caller.humanRooted, true);
    assert.deepStrictEqual(caller.chain, [MAIN.projectId]);

    const delegation = yield* bots.delegate({
      caller,
      targetBotId: FRONTEND.projectId,
      brief: "Add multiply() and its tests",
      requestId: "multiply",
    });
    assert.strictEqual(delegation.state, "sent");
    assert.strictEqual(delegation.depth, 1);
    // Retrying the same hand-off replays it.
    const replay = yield* bots.delegate({
      caller,
      targetBotId: FRONTEND.projectId,
      brief: "Add multiply() and its tests",
      requestId: "multiply",
    });
    assert.strictEqual(replay.id, delegation.id);
    const starts = turnStarts(world, FRONTEND.threadId);
    assert.strictEqual(starts.length, 1);
    const messageId = `${BOT_DELEGATION_MESSAGE_PREFIX}${delegation.id}`;
    assert.strictEqual(starts[0]!.message.messageId, messageId);
    assert.strictEqual(starts[0]!.dispatchOrigin, "agent");
    assert.include(starts[0]!.message.text, "Add multiply to the frontend and test it");
    const activities = world.dispatched.filter(
      (command) => command.type === "thread.activity.append",
    );
    assert.strictEqual(activities.length, 2);

    // Hub work started from the delegation message is authorized by the user's message.
    const sources = yield* bots.delegatedSources(messageId);
    assert.deepStrictEqual(
      sources?.map((source) => source.messageId),
      ["msg-user"],
    );

    // The target's turn finishes with a reply: the delegation settles and the requester wakes.
    world.messages.get(FRONTEND.threadId)!.push({
      id: MessageId.makeUnsafe("reply-frontend"),
      role: "assistant",
      text: "Added multiply() with tests; PR #7.",
      turnId: TurnId.makeUnsafe("turn-frontend"),
      streaming: false,
      createdAt: now,
      updatedAt: now,
    });
    world.turns.get(FRONTEND.threadId)!.push({
      threadId: FRONTEND.threadId,
      turnId: TurnId.makeUnsafe("turn-frontend"),
      pendingMessageId: MessageId.makeUnsafe(messageId),
      state: "completed",
      requestedAt: now,
      completedAt: now,
      assistantMessageId: MessageId.makeUnsafe("reply-frontend"),
    });
    yield* bots.evaluateDelegations({});
    yield* bots.evaluateDelegations({});
    const reports = turnStarts(world, MAIN.threadId);
    assert.strictEqual(reports.length, 1);
    assert.ok(reports[0]!.message.messageId.startsWith(BOT_REPORT_MESSAGE_PREFIX));
    assert.include(reports[0]!.message.text, "Added multiply() with tests; PR #7.");
    const snapshot = yield* bots.snapshot();
    assert.strictEqual(snapshot.delegations[0]?.state, "completed");
  }).pipe(Effect.provide(makeLayer(world)));
});

it.effect("work that ends while Alto has lapsed settles, and reports once Alto is back", () => {
  const world = makeWorld();
  return Effect.gen(function* () {
    yield* seed;
    userTurn(world);
    const bots = yield* BotService;
    const caller = (yield* bots.resolveCaller({ threadId: MAIN.threadId, turnId: "turn-user" }))!;
    const delegation = yield* bots.delegate({
      caller,
      targetBotId: FRONTEND.projectId,
      brief: "Add multiply() and its tests",
      requestId: "multiply",
    });
    const messageId = `${BOT_DELEGATION_MESSAGE_PREFIX}${delegation.id}`;
    world.messages.get(FRONTEND.threadId)!.push({
      id: MessageId.makeUnsafe("reply-frontend"),
      role: "assistant",
      text: "Added multiply() with tests.",
      turnId: TurnId.makeUnsafe("turn-frontend"),
      streaming: false,
      createdAt: now,
      updatedAt: now,
    });
    world.turns.get(FRONTEND.threadId)!.push({
      threadId: FRONTEND.threadId,
      turnId: TurnId.makeUnsafe("turn-frontend"),
      pendingMessageId: MessageId.makeUnsafe(messageId),
      state: "completed",
      requestedAt: now,
      completedAt: now,
      assistantMessageId: MessageId.makeUnsafe("reply-frontend"),
    });

    gate.requiresAlto = true;
    gate.granted = false;
    yield* bots.evaluateDelegations({});
    const settled = yield* (yield* BotRepository).getDelegation(delegation.id);
    assert.strictEqual(settled?.state, "completed");
    // Waking the asker is new work: it waits for Alto.
    assert.strictEqual(turnStarts(world, MAIN.threadId).length, 0);

    gate.granted = true;
    yield* bots.evaluateDelegations({});
    yield* bots.evaluateDelegations({});
    assert.strictEqual(turnStarts(world, MAIN.threadId).length, 1);
  }).pipe(Effect.provide(makeLayer(world)));
});

it.effect("starts a second hand-off to one bot only after the first turn start is taken", () => {
  const world = makeWorld();
  return Effect.gen(function* () {
    yield* seed;
    userTurn(world);
    world.projectPendingStarts.current = true;
    const bots = yield* BotService;
    const caller = yield* bots.resolveCaller({ threadId: MAIN.threadId, turnId: "turn-user" });
    assert.ok(caller);

    const first = yield* bots.delegate({
      caller,
      targetBotId: FRONTEND.projectId,
      brief: "Part one",
      requestId: "part-1",
    });
    const firstMessageId = `${BOT_DELEGATION_MESSAGE_PREFIX}${first.id}`;
    assert.strictEqual(world.pendingStarts.get(FRONTEND.threadId), firstMessageId);

    // While the first start still holds the thread's pending slot, starting the second would
    // replace it and attribute the first turn to the second message: the second waits.
    const second = yield* Effect.forkChild(
      bots.delegate({
        caller,
        targetBotId: FRONTEND.projectId,
        brief: "Part two",
        requestId: "part-2",
      }),
    );
    yield* TestClock.adjust("500 millis");
    assert.strictEqual(turnStarts(world, FRONTEND.threadId).length, 1);

    // The first turn starts running, which clears the slot; the second start goes out.
    world.pendingStarts.delete(FRONTEND.threadId);
    yield* TestClock.adjust("100 millis");
    const secondDelegation = yield* Fiber.join(second);
    assert.deepStrictEqual(
      turnStarts(world, FRONTEND.threadId).map((start) => start.message.messageId as string),
      [firstMessageId, `${BOT_DELEGATION_MESSAGE_PREFIX}${secondDelegation.id}`],
    );
  }).pipe(Effect.provide(makeLayer(world)));
});

it.effect("enforces the chain rules and asks before starting when the bot says so", () => {
  const world = makeWorld();
  return Effect.gen(function* () {
    yield* seed;
    userTurn(world);
    const bots = yield* BotService;
    const caller = (yield* bots.resolveCaller({ threadId: MAIN.threadId, turnId: "turn-user" }))!;
    const self = yield* Effect.flip(
      bots.delegate({ caller, targetBotId: MAIN.projectId, brief: "x", requestId: "self" }),
    );
    assert.include(self.message, "itself");

    const asked = yield* bots.delegate({
      caller,
      targetBotId: QA.projectId,
      brief: "Review the change",
      requestId: "qa",
    });
    assert.strictEqual(asked.state, "awaiting-start");
    assert.strictEqual(turnStarts(world, QA.threadId).length, 0);

    // A bot in the chain cannot be asked again.
    const chained = { ...caller, chain: [MAIN.projectId, FRONTEND.projectId], depth: 1 };
    const cycle = yield* Effect.flip(
      bots.delegate({
        caller: chained,
        targetBotId: FRONTEND.projectId,
        brief: "x",
        requestId: "c",
      }),
    );
    assert.include(cycle.message, "already in this delegation chain");
    const deep = { ...caller, chain: [MAIN.projectId], depth: 3 };
    const tooDeep = yield* Effect.flip(
      bots.delegate({ caller: deep, targetBotId: FRONTEND.projectId, brief: "x", requestId: "d" }),
    );
    assert.strictEqual(tooDeep.code, "limit");
    const noSources = { ...caller, sourceMessages: [] };
    const unauthorized = yield* Effect.flip(
      bots.delegate({
        caller: noSources,
        targetBotId: FRONTEND.projectId,
        brief: "x",
        requestId: "e",
      }),
    );
    assert.strictEqual(unauthorized.code, "forbidden");
  }).pipe(Effect.provide(makeLayer(world)));
});

it.effect("grants full control only to user-rooted bot turns while the setting is on", () => {
  const world = makeWorld();
  return Effect.gen(function* () {
    yield* seed;
    userTurn(world);
    world.shells.set(MAIN.threadId, {
      ...world.shells.get(MAIN.threadId),
      session: { activeTurnId: TurnId.makeUnsafe("turn-user") },
    });
    const bots = yield* BotService;
    const target = ThreadId.makeUnsafe("thread-user-chat");
    const granted = yield* bots.fullControlFor({
      callerThreadId: MAIN.threadId,
      targetThreadId: target,
    });
    assert.strictEqual(granted?.botName, "SynBot");
    yield* bots.updateSettings({ controlWithoutAsking: false });
    const refused = yield* bots.fullControlFor({
      callerThreadId: MAIN.threadId,
      targetThreadId: target,
    });
    assert.strictEqual(refused, null);
    const notABot = yield* bots.fullControlFor({
      callerThreadId: target,
      targetThreadId: MAIN.threadId,
    });
    assert.strictEqual(notABot, null);
  }).pipe(Effect.provide(makeLayer(world)));
});

it.effect("stops one bot's turn and the work handed to it, or every bot", () => {
  const world = makeWorld();
  return Effect.gen(function* () {
    yield* seed;
    userTurn(world);
    const bots = yield* BotService;
    const caller = (yield* bots.resolveCaller({ threadId: MAIN.threadId, turnId: "turn-user" }))!;
    const toFrontend = yield* bots.delegate({
      caller,
      targetBotId: FRONTEND.projectId,
      brief: "Add multiply()",
      requestId: "frontend",
    });
    const toQa = yield* bots.delegate({
      caller,
      targetBotId: QA.projectId,
      brief: "Review the change",
      requestId: "qa",
    });
    for (const fixture of [MAIN, FRONTEND]) {
      world.shells.set(fixture.threadId, {
        ...world.shells.get(fixture.threadId),
        session: { activeTurnId: TurnId.makeUnsafe(`turn-${fixture.name}`) },
      });
    }
    const interrupts = () =>
      world.dispatched.flatMap((command) =>
        command.type === "thread.turn.interrupt" ? [command.threadId] : [],
      );

    const one = yield* bots.stopAll({ botId: FRONTEND.projectId });
    assert.deepStrictEqual(one.cancelledDelegationIds, [toFrontend.id]);
    assert.deepStrictEqual(one.interruptedThreadIds, [FRONTEND.threadId]);
    // SynBot's own turn and its hand-off to QA keep going.
    assert.notInclude(interrupts(), MAIN.threadId);
    const afterOne = yield* bots.snapshot();
    assert.strictEqual(
      afterOne.delegations.find((delegation) => delegation.id === toQa.id)?.state,
      "awaiting-start",
    );

    const missing = yield* Effect.flip(bots.stopAll({ botId: ProjectId.makeUnsafe("bot-gone") }));
    assert.strictEqual(missing.code, "not-found");

    const all = yield* bots.stopAll();
    assert.deepStrictEqual(all.cancelledDelegationIds, [toQa.id]);
    assert.include(all.interruptedThreadIds, MAIN.threadId);
  }).pipe(Effect.provide(makeLayer(world)));
});

/** A task of Frontend's as its Hub stores it. */
function frontendTask(
  id: string,
  taskIndex: number,
  state: HubWorkRecord["state"],
  workerThreadId: ThreadId | null,
): HubWorkRecord {
  return {
    id,
    projectId: FRONTEND.projectId,
    targetProjectId: FRONTEND.projectId,
    sourceThreadId: FRONTEND.threadId,
    sourceMessageId: null,
    title: `Task ${id}`,
    workerThreadId,
    state,
    queueReason: null,
    resultSummary: null,
    progress: null,
    requestId: "frontend-work",
    scopeKey: "frontend-source",
    fingerprint: "frontend-plan",
    taskIndex,
    creationSpec: { prompt: `Task ${id}`, target: model },
    sourceMessages: [],
    slotHeld: workerThreadId !== null,
    admittedAt: workerThreadId === null ? null : now,
    admissionCommandId: null,
    admissionMessageId: null,
    admissionPreviousState: null,
    admissionPreviousSlotHeld: false,
    revision: 0,
    createdAt: now,
    updatedAt: now,
  };
}

const interruptedThreads = (world: World) =>
  world.dispatched.flatMap((command) =>
    command.type === "thread.turn.interrupt" ? [command.threadId] : [],
  );

it.effect("stops a bot's tasks, the one waiting on the user included", () => {
  const world = makeWorld();
  return Effect.gen(function* () {
    yield* seed;
    const waitingWorker = ThreadId.makeUnsafe("worker-waiting");
    const workingWorker = ThreadId.makeUnsafe("worker-working");
    yield* (yield* HubWorkRepository).submit({
      projectId: FRONTEND.projectId,
      requestId: "frontend-work",
      scopeKey: "frontend-source",
      fingerprint: "frontend-plan",
      records: [
        frontendTask("work-waiting", 0, "waiting", waitingWorker),
        frontendTask("work-working", 1, "working", workingWorker),
        frontendTask("work-done", 2, "completed", ThreadId.makeUnsafe("worker-done")),
      ],
    });
    const bots = yield* BotService;
    // A task waiting on an approval makes the bot wait on the user: the UI offers Stop.
    const before = yield* bots.snapshot();
    assert.strictEqual(before.bots.find((bot) => bot.id === FRONTEND.projectId)?.status, "waiting");

    const stopped = yield* bots.stopAll({ botId: FRONTEND.projectId });
    assert.sameMembers([...stopped.interruptedThreadIds], [waitingWorker, workingWorker]);
    assert.sameMembers(interruptedThreads(world), [waitingWorker, workingWorker]);
  }).pipe(Effect.provide(makeLayer(world)));
});

it.effect("cancelling a hand-off stops its task even while it waits on the user", () => {
  const world = makeWorld();
  return Effect.gen(function* () {
    yield* seed;
    userTurn(world);
    const waitingWorker = ThreadId.makeUnsafe("worker-waiting");
    yield* (yield* HubWorkRepository).submit({
      projectId: FRONTEND.projectId,
      requestId: "frontend-work",
      scopeKey: "frontend-source",
      fingerprint: "frontend-plan",
      records: [frontendTask("work-waiting", 0, "waiting", waitingWorker)],
    });
    const bots = yield* BotService;
    const caller = (yield* bots.resolveCaller({ threadId: MAIN.threadId, turnId: "turn-user" }))!;
    const delegation = yield* bots.delegate({
      caller,
      targetBotId: FRONTEND.projectId,
      brief: "Add multiply()",
      requestId: "frontend",
    });
    // Frontend started the task for this hand-off; the task now waits on an approval.
    const repository = yield* BotRepository;
    const record = (yield* repository.getDelegation(delegation.id))!;
    yield* repository.saveDelegation({ ...record, state: "waiting", taskIds: ["work-waiting"] });

    const cancelled = yield* bots.cancelDelegation({ delegationId: delegation.id });
    assert.strictEqual(cancelled.state, "cancelled");
    assert.include(interruptedThreads(world), waitingWorker);
  }).pipe(Effect.provide(makeLayer(world)));
});

/** A turn in a bot's thread, started by `pendingMessageId`; a reply when it has completed. */
function putTurn(
  world: World,
  threadId: ThreadId,
  turnId: string,
  pendingMessageId: string,
  reply: string | null,
) {
  const turns = world.turns.get(threadId)!;
  const index = turns.findIndex((turn) => turn.turnId === turnId);
  const assistantMessageId = reply === null ? null : MessageId.makeUnsafe(`reply-${turnId}`);
  if (reply !== null) {
    world.messages.get(threadId)!.push({
      id: assistantMessageId,
      role: "assistant",
      text: reply,
      turnId: TurnId.makeUnsafe(turnId),
      streaming: false,
      createdAt: now,
      updatedAt: now,
    });
  }
  const next = {
    threadId,
    turnId: TurnId.makeUnsafe(turnId),
    pendingMessageId: MessageId.makeUnsafe(pendingMessageId),
    state: reply === null ? "running" : "completed",
    requestedAt: now,
    completedAt: reply === null ? null : now,
    assistantMessageId,
  };
  if (index === -1) turns.push(next);
  else turns[index] = next;
}

const delegationMessage = (delegationId: string) =>
  `${BOT_DELEGATION_MESSAGE_PREFIX}${delegationId}`;

const reportsTo = (world: World, threadId: ThreadId) =>
  turnStarts(world, threadId).filter((command) =>
    command.message.messageId.startsWith(BOT_REPORT_MESSAGE_PREFIX),
  );

it.effect("reports a hand-off only once the work its bot handed on has come back", () => {
  const world = makeWorld();
  return Effect.gen(function* () {
    yield* seed;
    userTurn(world);
    const bots = yield* BotService;
    yield* bots.update({ id: QA.projectId, autonomy: "auto" });
    const main = (yield* bots.resolveCaller({ threadId: MAIN.threadId, turnId: "turn-user" }))!;
    const toFrontend = yield* bots.delegate({
      caller: main,
      targetBotId: FRONTEND.projectId,
      brief: "Add multiply() and have it tested",
      requestId: "frontend",
    });
    // Frontend's turn hands the testing on to QA, then ends.
    putTurn(world, FRONTEND.threadId, "turn-frontend", delegationMessage(toFrontend.id), null);
    const frontend = (yield* bots.resolveCaller({
      threadId: FRONTEND.threadId,
      turnId: "turn-frontend",
    }))!;
    const toQa = yield* bots.delegate({
      caller: frontend,
      targetBotId: QA.projectId,
      brief: "Test multiply()",
      requestId: "qa",
    });
    assert.strictEqual(toQa.depth, 2);
    putTurn(
      world,
      FRONTEND.threadId,
      "turn-frontend",
      delegationMessage(toFrontend.id),
      "QA is on it.",
    );
    yield* bots.evaluateDelegations({});
    assert.lengthOf(reportsTo(world, MAIN.threadId), 0, "Frontend only handed the work on");

    // QA finishes: its report wakes Frontend, and SynBot still waits.
    putTurn(world, QA.threadId, "turn-qa", delegationMessage(toQa.id), "3 of 3 tests pass.");
    yield* bots.evaluateDelegations({});
    const toFrontendReport = reportsTo(world, FRONTEND.threadId);
    assert.lengthOf(toFrontendReport, 1);
    yield* bots.evaluateDelegations({});
    assert.lengthOf(reportsTo(world, MAIN.threadId), 0, "the report has not woken Frontend yet");

    // Frontend answers QA's report: SynBot gets one report, with that answer.
    putTurn(
      world,
      FRONTEND.threadId,
      "turn-frontend-report",
      toFrontendReport[0]!.message.messageId,
      "multiply() is in, and QA passed it.",
    );
    yield* bots.evaluateDelegations({});
    yield* bots.evaluateDelegations({});
    const toMain = reportsTo(world, MAIN.threadId);
    assert.lengthOf(toMain, 1);
    assert.include(toMain[0]!.message.text, "multiply() is in, and QA passed it.");
  }).pipe(Effect.provide(makeLayer(world)));
});

it.effect("a Stop pressed while the settle sweep reads the hand-off stays stopped", () => {
  const world = makeWorld();
  return Effect.gen(function* () {
    yield* seed;
    userTurn(world);
    const bots = yield* BotService;
    const main = (yield* bots.resolveCaller({ threadId: MAIN.threadId, turnId: "turn-user" }))!;
    const delegation = yield* bots.delegate({
      caller: main,
      targetBotId: FRONTEND.projectId,
      brief: "Add multiply()",
      requestId: "frontend",
    });
    putTurn(world, FRONTEND.threadId, "turn-frontend", delegationMessage(delegation.id), null);
    world.shells.set(FRONTEND.threadId, {
      ...world.shells.get(FRONTEND.threadId),
      session: { activeTurnId: TurnId.makeUnsafe("turn-frontend") },
    });

    // The sweep reads the hand-off as running, and is held there.
    const reached = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    world.gate.current = { threadId: FRONTEND.threadId, reached, release };
    const sweep = yield* Effect.forkChild(bots.evaluateDelegations({}));
    yield* Deferred.await(reached);
    world.gate.current = null;
    // The user presses Stop meanwhile; the sweep then finishes with what it read.
    const stop = yield* Effect.forkChild(bots.cancelDelegation({ delegationId: delegation.id }));
    for (let step = 0; step < 20; step += 1) yield* Effect.yieldNow;
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(sweep);
    const stopped = yield* Fiber.join(stop);

    assert.strictEqual(stopped.state, "cancelled");
    const snapshot = yield* bots.snapshot();
    assert.strictEqual(
      snapshot.delegations.find((entry) => entry.id === delegation.id)?.state,
      "cancelled",
    );
    assert.include(interruptedThreads(world), FRONTEND.threadId);
    // Stopped by the user: SynBot is not woken.
    yield* bots.evaluateDelegations({});
    assert.lengthOf(reportsTo(world, MAIN.threadId), 0);
  }).pipe(Effect.provide(makeLayer(world)));
});

it.effect("a hand-off whose delivery failed is delivered when the bot asks again", () => {
  const world = makeWorld();
  return Effect.gen(function* () {
    yield* seed;
    userTurn(world);
    const bots = yield* BotService;
    const main = (yield* bots.resolveCaller({ threadId: MAIN.threadId, turnId: "turn-user" }))!;
    const ask = bots.delegate({
      caller: main,
      targetBotId: FRONTEND.projectId,
      brief: "Add multiply()",
      requestId: "frontend",
    });
    world.failTurnStarts.current = true;
    yield* Effect.flip(ask);
    assert.lengthOf(turnStarts(world, FRONTEND.threadId), 0);

    world.failTurnStarts.current = false;
    const retried = yield* ask;
    assert.lengthOf(turnStarts(world, FRONTEND.threadId), 1);
    assert.strictEqual(retried.state, "sent");
    assert.isNotNull(retried.startedAt);
    // Once delivered, asking again changes nothing.
    yield* ask;
    assert.lengthOf(turnStarts(world, FRONTEND.threadId), 1);
  }).pipe(Effect.provide(makeLayer(world)));
});

it.effect("removing a bot fails the work handed to it back to the asker", () => {
  const world = makeWorld();
  return Effect.gen(function* () {
    yield* seed;
    userTurn(world);
    const bots = yield* BotService;
    const main = (yield* bots.resolveCaller({ threadId: MAIN.threadId, turnId: "turn-user" }))!;
    // QA asks before starting, so this hand-off waits for a Start that will never come.
    const toQa = yield* bots.delegate({
      caller: main,
      targetBotId: QA.projectId,
      brief: "Review the change",
      requestId: "qa",
    });
    assert.strictEqual(toQa.state, "awaiting-start");

    yield* bots.remove({ id: QA.projectId });
    const snapshot = yield* bots.snapshot();
    const ended = snapshot.delegations.find((entry) => entry.id === toQa.id);
    assert.strictEqual(ended?.state, "failed");
    assert.strictEqual(ended?.resultSummary, "QA was removed.");
    const reports = reportsTo(world, MAIN.threadId);
    assert.lengthOf(reports, 1, "SynBot is told");
    assert.notOk(snapshot.bots.some((bot) => bot.id === QA.projectId));
  }).pipe(Effect.provide(makeLayer(world)));
});

it.effect("stopping a hand-off leaves the target's unrelated turn running", () => {
  const world = makeWorld();
  return Effect.gen(function* () {
    yield* seed;
    userTurn(world);
    const bots = yield* BotService;
    const main = (yield* bots.resolveCaller({ threadId: MAIN.threadId, turnId: "turn-user" }))!;
    const delegation = yield* bots.delegate({
      caller: main,
      targetBotId: FRONTEND.projectId,
      brief: "Add multiply()",
      requestId: "frontend",
    });
    // The user chats with Frontend directly; the hand-off's message waits in its queue.
    putTurn(world, FRONTEND.threadId, "turn-own", "msg-own", null);
    world.shells.set(FRONTEND.threadId, {
      ...world.shells.get(FRONTEND.threadId),
      session: { activeTurnId: TurnId.makeUnsafe("turn-own") },
    });

    const stopped = yield* bots.cancelDelegation({ delegationId: delegation.id });
    assert.strictEqual(stopped.state, "cancelled");
    assert.notInclude(interruptedThreads(world), FRONTEND.threadId);
  }).pipe(Effect.provide(makeLayer(world)));
});

it.effect("a Start card stays answerable however long the names and the brief", () => {
  const world = makeWorld();
  return Effect.gen(function* () {
    yield* seed;
    userTurn(world);
    const bots = yield* BotService;
    const main = (yield* bots.resolveCaller({ threadId: MAIN.threadId, turnId: "turn-user" }))!;
    const longName = { ...main, bot: { ...main.bot, name: "N".repeat(200) } };
    const asked = yield* bots.delegate({
      caller: longName,
      targetBotId: QA.projectId,
      brief: "Review ".repeat(100),
      requestId: "qa",
    });
    const cardId = `synbot:card:start:${asked.id}`;
    const posted = world.dispatched.find(
      (command) =>
        command.type === "thread.activity.append" &&
        (command.activity.payload as { id?: string }).id === cardId,
    );
    assert.ok(posted?.type === "thread.activity.append");
    const card = Schema.decodeUnknownSync(BotCard)(posted.activity.payload);
    assert.isAtMost(card.title.length, 400);

    const answer = yield* bots.cardAction({ threadId: QA.threadId, cardId, optionId: "start" });
    assert.strictEqual(answer.optionId, "start");
    assert.lengthOf(turnStarts(world, QA.threadId), 1, "Start delivers the hand-off");
    world.dispatched.push({
      type: "thread.activity.append",
      threadId: QA.threadId,
      activity: {
        id: `${cardId}:resolved`,
        kind: "synbot.card.resolved",
        payload: { cardId },
      },
    } as unknown as OrchestrationCommand);
    const again = yield* Effect.flip(
      bots.cardAction({ threadId: QA.threadId, cardId, optionId: "not-now" }),
    );
    assert.strictEqual(again.code, "conflict");
  }).pipe(Effect.provide(makeLayer(world)));
});

it.effect("Not now on a Start card stops the hand-off without waking the asker", () => {
  const world = makeWorld();
  return Effect.gen(function* () {
    yield* seed;
    userTurn(world);
    const bots = yield* BotService;
    const main = (yield* bots.resolveCaller({ threadId: MAIN.threadId, turnId: "turn-user" }))!;
    const asked = yield* bots.delegate({
      caller: main,
      targetBotId: QA.projectId,
      brief: "Review the change",
      requestId: "qa",
    });
    const cardId = `synbot:card:start:${asked.id}`;
    const unknown = yield* Effect.flip(
      bots.cardAction({ threadId: QA.threadId, cardId, optionId: "maybe" }),
    );
    assert.strictEqual(unknown.code, "invalid");

    yield* bots.cardAction({ threadId: QA.threadId, cardId, optionId: "not-now" });
    const snapshot = yield* bots.snapshot();
    assert.strictEqual(
      snapshot.delegations.find((entry) => entry.id === asked.id)?.state,
      "cancelled",
    );
    assert.lengthOf(turnStarts(world, QA.threadId), 0);
    yield* bots.evaluateDelegations({});
    assert.lengthOf(reportsTo(world, MAIN.threadId), 0);
  }).pipe(Effect.provide(makeLayer(world)));
});

it.effect("allows four hand-offs per turn and refuses a fifth", () => {
  const world = makeWorld();
  return Effect.gen(function* () {
    yield* seed;
    userTurn(world);
    const bots = yield* BotService;
    const main = (yield* bots.resolveCaller({ threadId: MAIN.threadId, turnId: "turn-user" }))!;
    for (const requestId of ["a", "b", "c", "d"]) {
      yield* bots.delegate({
        caller: main,
        targetBotId: FRONTEND.projectId,
        brief: `Part ${requestId}`,
        requestId,
      });
    }
    const fifth = yield* Effect.flip(
      bots.delegate({ caller: main, targetBotId: QA.projectId, brief: "Part e", requestId: "e" }),
    );
    assert.strictEqual(fifth.code, "limit");
  }).pipe(Effect.provide(makeLayer(world)));
});

it.effect("cancelling an intermediate hand-off also stops its downstream child hand-off", () => {
  const world = makeWorld();
  return Effect.gen(function* () {
    yield* seed;
    userTurn(world);
    const bots = yield* BotService;
    yield* bots.update({ id: QA.projectId, autonomy: "auto" });
    const main = (yield* bots.resolveCaller({ threadId: MAIN.threadId, turnId: "turn-user" }))!;
    const toFrontend = yield* bots.delegate({
      caller: main,
      targetBotId: FRONTEND.projectId,
      brief: "Build and test",
      requestId: "frontend",
    });
    putTurn(world, FRONTEND.threadId, "turn-frontend", delegationMessage(toFrontend.id), null);
    const frontend = (yield* bots.resolveCaller({
      threadId: FRONTEND.threadId,
      turnId: "turn-frontend",
    }))!;
    const toQa = yield* bots.delegate({
      caller: frontend,
      targetBotId: QA.projectId,
      brief: "Run QA",
      requestId: "qa",
    });
    putTurn(world, QA.threadId, "turn-qa", delegationMessage(toQa.id), null);
    world.shells.set(QA.threadId, {
      ...world.shells.get(QA.threadId),
      session: { activeTurnId: TurnId.makeUnsafe("turn-qa") },
    });

    yield* bots.cancelDelegation({ delegationId: toFrontend.id });
    const snapshot = yield* bots.snapshot();
    assert.strictEqual(
      snapshot.delegations.find((entry) => entry.id === toFrontend.id)?.state,
      "cancelled",
    );
    assert.strictEqual(
      snapshot.delegations.find((entry) => entry.id === toQa.id)?.state,
      "cancelled",
    );
    assert.include(interruptedThreads(world), QA.threadId);
  }).pipe(Effect.provide(makeLayer(world)));
});

it.effect(
  "an abandoned failed sibling delivery does not block completed siblings from recapping",
  () => {
    const world = makeWorld();
    return Effect.gen(function* () {
      yield* seed;
      userTurn(world);
      const bots = yield* BotService;
      yield* bots.update({ id: QA.projectId, autonomy: "auto" });
      const main = (yield* bots.resolveCaller({ threadId: MAIN.threadId, turnId: "turn-user" }))!;
      const ok = yield* bots.delegate({
        caller: main,
        targetBotId: FRONTEND.projectId,
        brief: "Frontend part",
        requestId: "frontend",
      });
      world.failTurnStarts.current = true;
      yield* Effect.flip(
        bots.delegate({
          caller: main,
          targetBotId: QA.projectId,
          brief: "QA part",
          requestId: "qa",
        }),
      );
      world.failTurnStarts.current = false;
      // Requester turn ended without retrying the failed sibling.
      world.shells.set(MAIN.threadId, {
        ...world.shells.get(MAIN.threadId),
        session: { activeTurnId: null },
      });
      putTurn(
        world,
        FRONTEND.threadId,
        "turn-frontend",
        delegationMessage(ok.id),
        "Frontend done.",
      );
      yield* bots.evaluateDelegations({});
      assert.lengthOf(reportsTo(world, MAIN.threadId), 1);
      // The abandoned one is settled, not left open for every sweep to re-read.
      const snapshot = yield* bots.snapshot();
      const failed = snapshot.delegations.find((entry) => entry.toBotId === QA.projectId);
      assert.strictEqual(failed?.state, "failed");
      assert.isNotNull(failed?.settledAt);
      yield* bots.evaluateDelegations({});
      assert.lengthOf(reportsTo(world, MAIN.threadId), 1);
    }).pipe(Effect.provide(makeLayer(world)));
  },
);

it.effect("stopAll suppresses already-settled-but-unreported delegations", () => {
  const world = makeWorld();
  return Effect.gen(function* () {
    yield* seed;
    userTurn(world);
    const bots = yield* BotService;
    yield* bots.update({ id: QA.projectId, autonomy: "auto" });
    const main = (yield* bots.resolveCaller({ threadId: MAIN.threadId, turnId: "turn-user" }))!;
    const d1 = yield* bots.delegate({
      caller: main,
      targetBotId: FRONTEND.projectId,
      brief: "Part 1",
      requestId: "d1",
    });
    yield* bots.delegate({
      caller: main,
      targetBotId: QA.projectId,
      brief: "Part 2",
      requestId: "d2",
    });
    // d1 settles while d2 is still open (so d1 is settledAt != null, reportedAt == null).
    putTurn(world, FRONTEND.threadId, "turn-fe", delegationMessage(d1.id), "Done.");
    yield* bots.evaluateDelegations({ threadId: FRONTEND.threadId });
    assert.lengthOf(reportsTo(world, MAIN.threadId), 0);

    yield* bots.stopAll({});
    yield* bots.evaluateDelegations({});
    assert.lengthOf(reportsTo(world, MAIN.threadId), 0);
  }).pipe(Effect.provide(makeLayer(world)));
});

it.effect("proposing the same bot again after Not now creates a fresh answerable card", () => {
  const world = makeWorld();
  return Effect.gen(function* () {
    yield* seed;
    userTurn(world);
    const bots = yield* BotService;
    const main = (yield* bots.resolveCaller({ threadId: MAIN.threadId, turnId: "turn-user" }))!;
    const draft = {
      name: "Docs",
      role: "Documentation",
      scope: { projects: "all" as const, paths: [] },
    };
    const first = yield* bots.propose({ caller: main, draft });
    yield* bots.cardAction({
      threadId: MAIN.threadId,
      cardId: first.cardId,
      optionId: "dismiss",
    });
    const second = yield* bots.propose({ caller: main, draft });
    assert.notStrictEqual(second.cardId, first.cardId);
  }).pipe(Effect.provide(makeLayer(world)));
});

// ── The Alto gate ────────────────────────────────────────────────────

it.effect("turns in chats that are not bots never reach the Alto check", () => {
  const world = makeWorld();
  return Effect.gen(function* () {
    yield* seed;
    // A plain Hub: a coordinator thread with no bot profile.
    const hubThread = ThreadId.makeUnsafe("thread-plain-hub");
    yield* (yield* ProjectAgentRepository).saveConfig(
      {
        projectId: ProjectId.makeUnsafe("plain-hub"),
        coordinatorThreadId: hubThread,
        coordinatorName: "Hub",
        coordinatorModelSelection: model,
        limits: DEFAULT_PROJECT_AGENT_LIMITS,
        captureEnabled: true,
        enabled: true,
        automationId: null,
        revision: 1,
        createdAt: now,
        updatedAt: now,
        disabledAt: null,
      },
      null,
    );
    gate.requiresAlto = true;
    gate.granted = false;
    const bots = yield* BotService;
    for (const threadId of [ThreadId.makeUnsafe("thread-user-chat"), hubThread]) {
      assert.strictEqual(yield* bots.formatContextForTurn({ threadId, messageId: "m-1" }), "");
      assert.strictEqual(yield* bots.resolveCaller({ threadId, turnId: null }), null);
      assert.strictEqual(
        yield* bots.fullControlFor({ callerThreadId: threadId, targetThreadId: MAIN.threadId }),
        null,
      );
      yield* bots.noteControl({
        callerThreadId: threadId,
        targetThreadId: MAIN.threadId,
        action: "send",
      } as never);
    }
    assert.strictEqual(gate.checks, 0);

    // A bot's own chat is checked, and refused with the reason.
    assert.strictEqual(
      yield* bots.formatContextForTurn({ threadId: MAIN.threadId, messageId: "m-1" }),
      "",
    );
    const locked = yield* Effect.flip(
      bots.resolveCaller({ threadId: MAIN.threadId, turnId: null }),
    );
    assert.strictEqual(locked.code, "subscription-required");
    assert.isAbove(gate.checks, 0);
  }).pipe(Effect.provide(makeLayer(world)));
});

it.effect("the settle sweep makes no Alto check while no delegation concerns it", () => {
  const world = makeWorld();
  return Effect.gen(function* () {
    yield* seed;
    userTurn(world);
    gate.requiresAlto = true;
    gate.granted = false;
    const bots = yield* BotService;
    yield* bots.evaluateDelegations({});
    yield* bots.evaluateDelegations({ threadId: FRONTEND.threadId });
    assert.strictEqual(gate.checks, 0);

    gate.granted = true;
    const main = (yield* bots.resolveCaller({ threadId: MAIN.threadId, turnId: "turn-user" }))!;
    yield* bots.delegate({
      caller: main,
      targetBotId: FRONTEND.projectId,
      brief: "x",
      requestId: "x",
    });
    gate.checks = 0;
    // An event in a chat no delegation involves costs nothing either.
    yield* bots.evaluateDelegations({ threadId: ThreadId.makeUnsafe("thread-user-chat") });
    assert.strictEqual(gate.checks, 0);
    yield* bots.evaluateDelegations({});
    assert.strictEqual(gate.checks, 1);
  }).pipe(Effect.provide(makeLayer(world)));
});

/** Fails if `effect` has not finished within `ms` of real time (the test clock stays put). */
const within = <A, E, R>(ms: number, effect: Effect.Effect<A, E, R>) =>
  Effect.raceFirst(
    effect,
    Effect.promise(() => new Promise((resolve) => setTimeout(resolve, ms))).pipe(
      Effect.andThen(Effect.die(new Error(`did not finish within ${ms} ms`))),
    ),
  );

it.effect("after Alto lapses, Stop, cancel and Not now still work; starting work does not", () => {
  const world = makeWorld();
  return Effect.gen(function* () {
    yield* seed;
    userTurn(world);
    const bots = yield* BotService;
    const main = (yield* bots.resolveCaller({ threadId: MAIN.threadId, turnId: "turn-user" }))!;
    const toFrontend = yield* bots.delegate({
      caller: main,
      targetBotId: FRONTEND.projectId,
      brief: "Build it",
      requestId: "frontend",
    });
    const toQa = yield* bots.delegate({
      caller: main,
      targetBotId: QA.projectId,
      brief: "Check it",
      requestId: "qa",
    });
    const proposal = yield* bots.propose({
      caller: main,
      draft: { name: "Docs", role: "Docs", scope: { projects: "all", paths: [] } },
    });
    const accept = yield* bots.propose({
      caller: main,
      draft: { name: "Ops", role: "Ops", scope: { projects: "all", paths: [] } },
    });
    putTurn(world, FRONTEND.threadId, "turn-frontend", delegationMessage(toFrontend.id), null);
    world.shells.set(FRONTEND.threadId, {
      ...world.shells.get(FRONTEND.threadId),
      session: { activeTurnId: TurnId.makeUnsafe("turn-frontend") },
    });

    gate.requiresAlto = true;
    gate.granted = false;
    // A slow Account API: a sweep stuck on the check must not hold up Stop.
    let release!: () => void;
    gate.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sweep = yield* Effect.forkChild(bots.evaluateDelegations({}));
    for (let spin = 0; spin < 1_000 && gate.checks === 0; spin += 1) yield* Effect.yieldNow;
    assert.strictEqual(gate.checks, 1);

    const cancelled = yield* within(2_000, bots.cancelDelegation({ delegationId: toQa.id }));
    assert.strictEqual(cancelled.state, "cancelled");
    const stopped = yield* within(2_000, bots.stopAll({ botId: FRONTEND.projectId }));
    assert.deepStrictEqual(stopped.cancelledDelegationIds, [toFrontend.id]);
    assert.include(interruptedThreads(world), FRONTEND.threadId);
    const dismissed = yield* bots.cardAction({
      threadId: MAIN.threadId,
      cardId: proposal.cardId,
      optionId: "dismiss",
    });
    assert.deepStrictEqual(dismissed.createdBotIds, []);
    assert.strictEqual(gate.checks, 1);

    release();
    yield* Fiber.join(sweep);
    // Accepting or starting work stays locked.
    const created = yield* Effect.flip(
      bots.cardAction({ threadId: MAIN.threadId, cardId: accept.cardId, optionId: "create:0" }),
    );
    assert.strictEqual(created.code, "subscription-required");
  }).pipe(Effect.provide(makeLayer(world)));
});

it.effect("stopping one bot leaves what it handed on running and reports every id", () => {
  const world = makeWorld();
  return Effect.gen(function* () {
    yield* seed;
    userTurn(world);
    const bots = yield* BotService;
    yield* bots.update({ id: QA.projectId, autonomy: "auto" });
    const main = (yield* bots.resolveCaller({ threadId: MAIN.threadId, turnId: "turn-user" }))!;
    const toFrontend = yield* bots.delegate({
      caller: main,
      targetBotId: FRONTEND.projectId,
      brief: "Build and test",
      requestId: "frontend",
    });
    putTurn(world, FRONTEND.threadId, "turn-frontend", delegationMessage(toFrontend.id), null);
    const frontend = (yield* bots.resolveCaller({
      threadId: FRONTEND.threadId,
      turnId: "turn-frontend",
    }))!;
    const toQa = yield* bots.delegate({
      caller: frontend,
      targetBotId: QA.projectId,
      brief: "Run QA",
      requestId: "qa",
    });

    const one = yield* bots.stopAll({ botId: FRONTEND.projectId });
    assert.deepStrictEqual(one.cancelledDelegationIds, [toFrontend.id]);
    const after = yield* bots.snapshot();
    assert.strictEqual(after.delegations.find((entry) => entry.id === toQa.id)?.state, "sent");
    const all = yield* bots.stopAll();
    assert.deepStrictEqual(all.cancelledDelegationIds, [toQa.id]);
  }).pipe(Effect.provide(makeLayer(world)));
});

it.effect("cancelling a hand-off leaves a same-root hand-off from another turn running", () => {
  const world = makeWorld();
  return Effect.gen(function* () {
    yield* seed;
    userTurn(world);
    const bots = yield* BotService;
    const repository = yield* BotRepository;
    const main = (yield* bots.resolveCaller({ threadId: MAIN.threadId, turnId: "turn-user" }))!;
    const toFrontend = yield* bots.delegate({
      caller: main,
      targetBotId: FRONTEND.projectId,
      brief: "Build it",
      requestId: "frontend",
    });
    putTurn(world, FRONTEND.threadId, "turn-frontend", delegationMessage(toFrontend.id), null);
    const parent = (yield* repository.getDelegation(toFrontend.id))!;
    // Frontend handed this on from another turn: another branch of the same root reached it.
    const other = {
      ...parent,
      id: "d-other-branch",
      requestId: `${FRONTEND.threadId}:turn-elsewhere`,
      depth: 3,
      fromBotId: FRONTEND.projectId,
      fromThreadId: FRONTEND.threadId,
      fromTurnId: "turn-elsewhere",
      toBotId: QA.projectId,
      toThreadId: QA.threadId,
      messageId: delegationMessage("d-other-branch"),
      state: "sent" as const,
      startedAt: parent.createdAt,
    };
    yield* repository.insertDelegation(other);

    yield* bots.cancelDelegation({ delegationId: toFrontend.id });
    const snapshot = yield* bots.snapshot();
    assert.strictEqual(snapshot.delegations.find((entry) => entry.id === other.id)?.state, "sent");
  }).pipe(Effect.provide(makeLayer(world)));
});

it.effect("stopping a task whose chat is still being created says so", () => {
  const world = makeWorld();
  return Effect.gen(function* () {
    yield* seed;
    yield* (yield* HubWorkRepository).submit({
      projectId: FRONTEND.projectId,
      requestId: "frontend-work",
      scopeKey: "frontend-source",
      fingerprint: "frontend-plan",
      records: [frontendTask("work-starting", 0, "starting", null)],
    });
    const bots = yield* BotService;
    const refused = yield* Effect.flip(bots.stopAll({ taskId: "work-starting" }));
    assert.strictEqual(refused.code, "conflict");
    assert.include(refused.message, "still starting");
  }).pipe(Effect.provide(makeLayer(world)));
});

it.effect("stopping a task this host does not have, or another bot's, is refused", () => {
  const world = makeWorld();
  return Effect.gen(function* () {
    yield* seed;
    yield* (yield* HubWorkRepository).submit({
      projectId: FRONTEND.projectId,
      requestId: "frontend-work",
      scopeKey: "frontend-source",
      fingerprint: "frontend-plan",
      records: [frontendTask("work-queued", 0, "queued", null)],
    });
    const bots = yield* BotService;
    const missing = yield* Effect.flip(bots.stopAll({ taskId: "work-missing" }));
    assert.strictEqual(missing.code, "not-found");
    const otherBot = yield* Effect.flip(
      bots.stopAll({ botId: QA.projectId, taskId: "work-queued" }),
    );
    assert.strictEqual(otherBot.code, "not-found");
    const own = yield* bots.stopAll({ botId: FRONTEND.projectId, taskId: "work-queued" });
    assert.deepStrictEqual(own.cancelledTaskIds, ["work-queued"]);
  }).pipe(Effect.provide(makeLayer(world)));
});

it.effect("an open SynBot stream ends with SUBSCRIPTION_REQUIRED once Alto access is gone", () => {
  const world = makeWorld();
  return Effect.gen(function* () {
    yield* seed;
    gate.requiresAlto = true;
    gate.granted = true;
    const bots = yield* BotService;
    const config = yield* ServerConfig;
    const credentialDir = accountStateDirectory(config.baseDir, config.devUrl);
    const collect = () =>
      Effect.forkChild(
        bots.streamEvents().pipe(
          Stream.runCollect,
          Effect.map((events) => ({ ok: true as const, events })),
          Effect.catch((error) => Effect.succeed({ ok: false as const, code: error.code })),
        ),
      );

    // Sign-out ends it at once.
    const signedOut = yield* collect();
    for (let spin = 0; spin < 1_000 && gate.checks === 0; spin += 1) yield* Effect.yieldNow;
    yield* Effect.yieldNow;
    clearServerAltoAccess(credentialDir);
    assert.deepStrictEqual(yield* Fiber.join(signedOut), {
      ok: false,
      code: "subscription-required",
    });

    // So does a lapse found by its periodic re-check.
    const lapsed = yield* collect();
    for (let spin = 0; spin < 1_000 && gate.checks < 2; spin += 1) yield* Effect.yieldNow;
    gate.granted = false;
    yield* TestClock.adjust("5 minutes");
    assert.deepStrictEqual(yield* Fiber.join(lapsed), {
      ok: false,
      code: "subscription-required",
    });

    // A host that does not require Alto keeps its stream.
    gate.requiresAlto = false;
    const free = yield* collect();
    yield* Effect.yieldNow;
    clearServerAltoAccess(credentialDir);
    yield* TestClock.adjust("10 minutes");
    yield* Effect.yieldNow;
    assert.isUndefined(free.pollUnsafe());
    yield* Fiber.interrupt(free);
  }).pipe(Effect.provide(makeLayer(world)));
});

it.effect("proposing an accepted bot again answers with the same card, not a second bot", () => {
  const world = makeWorld();
  return Effect.gen(function* () {
    yield* seed;
    userTurn(world);
    const bots = yield* BotService;
    const main = (yield* bots.resolveCaller({ threadId: MAIN.threadId, turnId: "turn-user" }))!;
    const draft = {
      name: "Docs",
      role: "Documentation",
      scope: { projects: "all" as const, paths: [] },
    };
    const first = yield* bots.propose({ caller: main, draft });
    // The user pressed Create bot (recorded as the card's answer; creating the Hub is out of
    // this fixture's reach).
    world.dispatched.push({
      type: "thread.activity.append",
      threadId: MAIN.threadId,
      activity: {
        id: `${first.cardId}:resolved`,
        kind: BOT_CARD_RESOLVED_ACTIVITY_KIND,
        payload: { cardId: first.cardId, optionId: "create:0" },
      },
    } as never);
    const again = yield* bots.propose({ caller: main, draft });
    assert.strictEqual(again.cardId, first.cardId);
    const answered = yield* Effect.flip(
      bots.cardAction({ threadId: MAIN.threadId, cardId: again.cardId, optionId: "create:0" }),
    );
    assert.strictEqual(answered.code, "conflict");
  }).pipe(Effect.provide(makeLayer(world)));
});

it.effect("a sibling still being dispatched is not taken for an abandoned one", () => {
  const world = makeWorld();
  return Effect.gen(function* () {
    yield* seed;
    userTurn(world);
    const bots = yield* BotService;
    yield* bots.update({ id: QA.projectId, autonomy: "auto" });
    const main = (yield* bots.resolveCaller({ threadId: MAIN.threadId, turnId: "turn-user" }))!;
    const toFrontend = yield* bots.delegate({
      caller: main,
      targetBotId: FRONTEND.projectId,
      brief: "Frontend part",
      requestId: "frontend",
    });
    // QA's thread still holds another pending start, so this dispatch waits for it.
    world.pendingStarts.set(QA.threadId, "msg-earlier");
    const toQa = yield* Effect.forkChild(
      bots.delegate({ caller: main, targetBotId: QA.projectId, brief: "QA part", requestId: "qa" }),
    );
    yield* TestClock.adjust("200 millis");
    assert.lengthOf(turnStarts(world, QA.threadId), 0);

    // The asker's turn has ended and Frontend finished: QA is mid-dispatch, not abandoned.
    putTurn(world, FRONTEND.threadId, "turn-fe", delegationMessage(toFrontend.id), "Done.");
    yield* bots.evaluateDelegations({});
    assert.lengthOf(reportsTo(world, MAIN.threadId), 0);
    const during = yield* bots.snapshot();
    assert.strictEqual(
      during.delegations.find((entry) => entry.toBotId === QA.projectId)?.state,
      "sent",
    );

    world.pendingStarts.delete(QA.threadId);
    yield* TestClock.adjust("200 millis");
    const qa = yield* Fiber.join(toQa);
    assert.lengthOf(turnStarts(world, QA.threadId), 1);
    putTurn(world, QA.threadId, "turn-qa", delegationMessage(qa.id), "Checked.");
    yield* bots.evaluateDelegations({});
    const reports = reportsTo(world, MAIN.threadId);
    assert.lengthOf(reports, 1);
    assert.include(reports[0]!.message.text, "Checked.");
  }).pipe(Effect.provide(makeLayer(world)));
});
