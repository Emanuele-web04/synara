import { OrchestrationCommandInternalError } from "../orchestration/Errors";
import { assert, it } from "@effect/vitest";
import {
  ProjectId,
  MessageId,
  ThreadId,
  type ChatAttachment,
  type HubWorkRecord,
  type OrchestrationCommand,
  type OrchestrationThreadShell,
  type SynaraCreateThreadsInput,
} from "@synara/contracts";
import { Effect, Layer, Option } from "effect";

import type { ServerConfigShape } from "../config.ts";
import type { GitCoreShape } from "../git/Services/GitCore.ts";
import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { HubWorkRepositoryLive } from "../persistence/Layers/HubWorkRepository.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { HubWorkRepository } from "../persistence/Services/HubWorkRepository.ts";
import type { ProviderDiscoveryServiceShape } from "../provider/Services/ProviderDiscoveryService.ts";
import { makeCreateThreadsHandler, type GatewayCreationContext } from "./creationCoordinator.ts";
import { AgentGatewayOperationRepositoryLive } from "./Layers/AgentGatewayOperationRepository.ts";
import { AgentGatewayOperationRepository } from "./Services/AgentGatewayOperationRepository.ts";
import { GatewayToolError } from "./toolRuntime.ts";

const NOW = "2026-10-02T10:00:00.000Z";
const PROJECT_ID = ProjectId.makeUnsafe("hub-saga");
const CALLER_ID = ThreadId.makeUnsafe("hub-coordinator");
const WORK_ID = "hub-saga-work";
const TARGET = { provider: "codex", model: "gpt-5.5" } as const;
const INPUT: typeof SynaraCreateThreadsInput.Type = {
  requestId: "hub-saga-request",
  threads: [{ prompt: "Implement the original human task", target: TARGET }],
};

const caller: OrchestrationThreadShell = {
  id: CALLER_ID,
  projectId: PROJECT_ID,
  title: "Hub coordinator",
  modelSelection: TARGET,
  runtimeMode: "approval-required",
  interactionMode: "default",
  envMode: "local",
  branch: null,
  worktreePath: null,
  associatedWorktreePath: null,
  associatedWorktreeBranch: null,
  associatedWorktreeRef: null,
  createBranchFlowCompleted: false,
  isPinned: false,
  parentThreadId: null,
  subagentAgentId: null,
  subagentNickname: null,
  subagentRole: null,
  forkSourceThreadId: null,
  sidechatSourceThreadId: null,
  lastKnownPr: null,
  latestTurn: null,
  latestUserMessageAt: null,
  createdAt: NOW,
  updatedAt: NOW,
  archivedAt: null,
  handoff: null,
  session: null,
};

function work(workId: string): HubWorkRecord {
  return {
    id: workId,
    projectId: PROJECT_ID,
    targetProjectId: PROJECT_ID,
    sourceThreadId: CALLER_ID,
    sourceMessageId: null,
    title: "Original human task",
    workerThreadId: null,
    state: "starting",
    queueReason: null,
    resultSummary: null,
    progress: null,
    requestId: `${INPUT.requestId}:${workId}`,
    scopeKey: `hub-saga-source:${workId}`,
    fingerprint: "hub-saga-plan",
    taskIndex: 0,
    creationSpec: INPUT.threads[0]!,
    sourceMessages: [],
    slotHeld: true,
    admittedAt: NOW,
    admissionCommandId: null,
    admissionMessageId: null,
    admissionPreviousState: null,
    admissionPreviousSlotHeld: false,
    revision: 0,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

const makeFixture = Effect.fn(function* (scenario: string) {
  const workId = `${WORK_ID}:${scenario}`;
  const operationRepository = yield* AgentGatewayOperationRepository;
  const hubWork = yield* HubWorkRepository;
  yield* hubWork.submit([work(workId)]);
  const commands: OrchestrationCommand[] = [];
  const prepareCalls: Array<{ threadId: string; messageId: string }> = [];
  let authorized = true;
  let revokeDuringPreparation = false;
  let failAfterLink = false;
  let failCleanup = false;
  let linkCount = 0;
  const attachments: readonly ChatAttachment[] = [
    {
      type: "assistant-selection",
      id: "source-quote",
      text: "Quoted evidence",
      assistantMessageId: MessageId.makeUnsafe("assistant-source"),
    },
  ];
  const dispatch: OrchestrationEngineShape["dispatch"] = (command) =>
    Effect.gen(function* () {
      if (failCleanup && command.type === "thread.delete")
        return yield* Effect.fail(
          new OrchestrationCommandInternalError({
            commandId: command.commandId,
            commandType: command.type,
            detail: "Cannot stop worker",
          }),
        );
      commands.push(command);
      return { sequence: commands.length };
    });
  const handler = yield* makeCreateThreadsHandler({
    operationRepository,
    orchestrationEngine: { dispatch } as OrchestrationEngineShape,
    snapshotQuery: {
      getProjectShellById: () =>
        Effect.succeed(
          Option.some({
            id: PROJECT_ID,
            kind: "project",
            title: "Hub",
            workspaceRoot: "/tmp/hub-saga",
            defaultModelSelection: null,
            scripts: [],
            isPinned: false,
            createdAt: NOW,
            updatedAt: NOW,
          }),
        ),
    } as unknown as ProjectionSnapshotQueryShape,
    providerDiscovery: {
      listModels: () => Effect.succeed({ models: [{ slug: TARGET.model, name: TARGET.model }] }),
    } as unknown as ProviderDiscoveryServiceShape,
    git: {} as GitCoreShape,
    serverConfig: { worktreesDir: "/tmp/hub-saga-worktrees" } as ServerConfigShape,
    loadProviderAvailabilities: Effect.succeed(new Map()),
    requireThreadShell: () => Effect.succeed(caller),
  });
  const context: GatewayCreationContext = {
    kind: "hub-work",
    batchId: "hub-work-batch:fixture",
    callerThreadId: CALLER_ID,
    workItemId: workId,
    sourceTurnId: null,
    assertAuthority: () =>
      authorized
        ? Effect.void
        : Effect.fail(new GatewayToolError("capability_denied", "Hub authority was revoked")),
    prepareAttachments: (threadId, messageId) =>
      Effect.sync(() => {
        prepareCalls.push({ threadId, messageId });
        if (revokeDuringPreparation) authorized = false;
        return attachments;
      }),
    recordWorker: (threadId) =>
      Effect.gen(function* () {
        const record = yield* hubWork.get(workId);
        assert.isNotNull(record);
        yield* hubWork.save({
          record: {
            ...record!,
            workerThreadId: threadId,
            state: "working",
            revision: record!.revision + 1,
          },
          expectedRevision: record!.revision,
        });
        linkCount += 1;
        if (failAfterLink) return yield* Effect.fail(new Error("link transaction interrupted"));
      }),
  };
  return {
    handler,
    context,
    commands,
    prepareCalls,
    attachments,
    hubWork,
    operationRepository,
    workId,
    revokeDuringPreparation: () => {
      revokeDuringPreparation = true;
    },
    failCleanup: () => {
      failCleanup = true;
    },
    failAfterLink: () => {
      failAfterLink = true;
    },
    linkCount: () => linkCount,
    getOperation: () =>
      operationRepository.getByScope({
        callerThreadId: CALLER_ID,
        callerTurnId: `hub-work:${workId}`,
        operationKind: "create_threads",
      }),
  };
});

const layer = it.layer(
  Layer.mergeAll(AgentGatewayOperationRepositoryLive, HubWorkRepositoryLive).pipe(
    Layer.provideMerge(SqlitePersistenceMemory),
  ),
);

layer("Hub work creation saga", (it) => {
  it.effect(
    "creates from a durable Hub task without a provider turn and replays the committed worker link",
    () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture("replay");
        const result = yield* fixture.handler(INPUT, fixture.context);
        assert.notEqual(result.isError, true);
        const start = fixture.commands.find((command) => command.type === "thread.turn.start");
        assert.isDefined(start);
        if (start?.type !== "thread.turn.start") throw new Error("missing worker start");
        assert.deepEqual(start.message.attachments, fixture.attachments);
        assert.deepEqual(fixture.prepareCalls, [
          { threadId: start.threadId, messageId: start.message.messageId },
        ]);
        const record = yield* fixture.hubWork.get(fixture.workId);
        assert.equal(record?.workerThreadId, start.threadId);
        assert.equal(record?.state, "working");
        assert.equal((yield* fixture.getOperation())?.status, "completed");
        const replay = yield* fixture.handler(INPUT, fixture.context);
        assert.deepEqual(replay, result);
        assert.deepEqual(
          fixture.commands.map((command) => command.type),
          ["thread.create", "thread.turn.start"],
        );
        assert.equal(fixture.linkCount(), 1);
        assert.equal(fixture.prepareCalls.length, 1);

        const inactive = yield* fixture.handler(INPUT, {
          kind: "provider-session",
          callerThreadId: CALLER_ID,
          callerTurnId: null,
          assertAuthority: () => Effect.void,
        });
        assert.equal(inactive.isError, true);
        assert.include(JSON.stringify(inactive), "caller_turn_inactive");
        assert.equal(fixture.commands.length, 2);
      }),
  );

  it.effect(
    "compensates the created shell when authority is revoked during attachment preparation",
    () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture("revoked");
        fixture.revokeDuringPreparation();
        const result = yield* fixture.handler(INPUT, fixture.context);
        assert.equal(result.isError, true);
        assert.equal(fixture.prepareCalls.length, 1);
        assert.deepEqual(
          fixture.commands.map((command) => command.type),
          ["thread.create", "thread.delete"],
        );
        assert.equal(fixture.linkCount(), 0);
        assert.isNull((yield* fixture.hubWork.get(fixture.workId))?.workerThreadId);
        assert.equal((yield* fixture.getOperation())?.status, "failed");
      }),
  );

  it.effect("keeps a started worker operation nonterminal when linking and cleanup both fail", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture("cleanup-pending");
      fixture.failAfterLink();
      fixture.failCleanup();
      const result = yield* fixture.handler(INPUT, fixture.context);
      assert.equal(result.isError, true);
      assert.include(JSON.stringify(result), "compensationPending");
      assert.equal((yield* fixture.getOperation())?.status, "compensating");
      assert.isNull((yield* fixture.hubWork.get(fixture.workId))?.workerThreadId);
      assert.deepEqual(
        fixture.commands.map((command) => command.type),
        ["thread.create", "thread.turn.start"],
      );
    }),
  );

  it.effect(
    "rolls back the Hub worker link on commit failure and refuses replacement dispatch on replay",
    () =>
      Effect.gen(function* () {
        const fixture = yield* makeFixture("link-failed");
        fixture.failAfterLink();
        const result = yield* fixture.handler(INPUT, fixture.context);
        assert.equal(result.isError, true);
        assert.equal(fixture.linkCount(), 1);
        const record = yield* fixture.hubWork.get(fixture.workId);
        assert.isNull(record?.workerThreadId);
        assert.equal(record?.state, "starting");
        assert.equal(record?.revision, 0);
        assert.equal((yield* fixture.getOperation())?.status, "failed");
        assert.deepEqual(
          fixture.commands.map((command) => command.type),
          ["thread.create", "thread.turn.start", "thread.delete"],
        );
        const replay = yield* fixture.handler(INPUT, fixture.context);
        assert.equal(replay.isError, true);
        assert.include(JSON.stringify(replay), "operation_failed");
        assert.equal(fixture.commands.length, 3);
        assert.equal(fixture.prepareCalls.length, 1);
        assert.equal(fixture.linkCount(), 1);
      }),
  );
});
