import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  BOT_DELEGATION_MESSAGE_PREFIX,
  BOT_REPORT_MESSAGE_PREFIX,
  DEFAULT_PROJECT_AGENT_LIMITS,
  DEFAULT_SERVER_SETTINGS,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  type ModelSelection,
  type OrchestrationCommand,
  type ProjectAgentConfig,
} from "@synara/contracts";
import { Effect, Layer, Option, Stream } from "effect";

import { ServerConfig } from "../../config.ts";
import { GitCore } from "../../git/Services/GitCore.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { BotRepositoryLive } from "../../persistence/Layers/BotRepository.ts";
import { HubWorkRepositoryLive } from "../../persistence/Layers/HubWorkRepository.ts";
import { ProjectAgentRepositoryLive } from "../../persistence/Layers/ProjectAgentRepository.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { BotRepository } from "../../persistence/Services/BotRepository.ts";
import { ProjectAgentRepository } from "../../persistence/Services/ProjectAgentRepository.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import { ProjectAgentService } from "../../projectAgent/Services/ProjectAgentService.ts";
import { ProviderHealth } from "../../provider/Services/ProviderHealth.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { BotService } from "../Services/BotService.ts";
import { BotServiceLive } from "./BotService.ts";

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
  return { dispatched, turns, messages, shells };
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
          activities: [],
        }) as never,
      ),
    getProjectShellById: () => Effect.succeed(Option.none()),
    getProjectShellsByIds: () => Effect.succeed([]),
    getShellSnapshot: () => Effect.succeed({ projects: [], threads: [], spaces: [] } as never),
  } as unknown as ProjectionSnapshotQuery["Service"]);
  const turnsLayer = Layer.succeed(ProjectionTurnRepository, {
    listByThreadId: (input: { threadId: string }) =>
      Effect.succeed(world.turns.get(input.threadId) ?? []),
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
      Effect.sync(() => {
        world.dispatched.push(command);
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
