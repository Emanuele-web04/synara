import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  CommandId,
  CheckpointRef,
  MessageId,
  ProjectId,
  ThreadId,
  EventId,
  RuntimeItemId,
  TurnId,
  type OrchestrationCommand,
} from "@synara/contracts";
import { Effect, Layer, ManagedRuntime, Option, Stream } from "effect";
import { expect, it } from "vitest";
import { SqlClient } from "effect/unstable/sql";
import { projectProviderRuntimeActivities } from "../providerRuntimeActivityProjection.ts";
import { createEmptyReadModel, projectEvent } from "../projector.ts";

import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { makeSqlitePersistenceLive } from "../../persistence/Layers/Sqlite.ts";
import { ServerConfig } from "../../config.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";

async function createSystem(dbPath: string) {
  const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
    prefix: "synara-async-questions-test-",
  });
  const layer = OrchestrationEngineLive.pipe(
    Layer.provideMerge(OrchestrationProjectionPipelineLive),
    Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
    Layer.provideMerge(OrchestrationEventStoreLive),
    Layer.provideMerge(OrchestrationCommandReceiptRepositoryLive),
    Layer.provideMerge(makeSqlitePersistenceLive(dbPath)),
    Layer.provideMerge(ServerConfigLayer),
    Layer.provideMerge(NodeServices.layer),
  );
  const runtime = ManagedRuntime.make(layer);
  const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
  const sql = await runtime.runPromise(Effect.service(SqlClient.SqlClient));
  const query = await runtime.runPromise(Effect.service(ProjectionSnapshotQuery));
  return {
    engine,
    query,
    sql,
    run: <A, E>(effect: Effect.Effect<A, E>) => runtime.runPromise(effect),
    dispose: () => runtime.dispose(),
  };
}

it.each(["ready", "running"] as const)(
  "persists async questions and admits one answer on a %s thread across restarts",
  async (status) => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "synara-async-questions-"));
    const dbPath = path.join(stateDir, "state.sqlite");
    let system = await createSystem(dbPath);
    const createdAt = "2026-09-10T12:00:00.000Z";
    const threadId = ThreadId.makeUnsafe("async-thread");
    const projectId = ProjectId.makeUnsafe("async-project");
    const turnId = TurnId.makeUnsafe("original-turn");
    const [question] = projectProviderRuntimeActivities({
      type: "item.completed",
      provider: "codex",
      threadId,
      turnId,
      eventId: EventId.makeUnsafe("async-event"),
      itemId: RuntimeItemId.makeUnsafe("question-1"),
      createdAt,
      payload: {
        itemType: "assistant_message",
        asyncQuestions: [{ title: "What triggers it?", options: ["Scrolling", "Tabs"] }],
      },
    });
    expect(question).toBeDefined();
    const appendQuestion = (commandId: string): OrchestrationCommand => ({
      type: "thread.activity.append",
      commandId: CommandId.makeUnsafe(commandId),
      threadId,
      activity: question!,
      createdAt,
    });
    const respond = (
      commandId: string,
    ): Extract<OrchestrationCommand, { type: "thread.turn.start" }> => ({
      type: "thread.turn.start",
      commandId: CommandId.makeUnsafe(commandId),
      threadId,
      asyncUserInputResponse: { activityId: question!.id, answers: ["Switching tabs quickly"] },
      message: {
        messageId: MessageId.makeUnsafe(commandId),
        role: "user",
        text: "client placeholder",
        attachments: [],
      },
      runtimeMode: "approval-required",
      interactionMode: "default",
      dispatchMode: "queue",
      createdAt,
    });
    try {
      await system.run(
        system.engine.dispatch({
          type: "project.create",
          commandId: CommandId.makeUnsafe("create-project"),
          projectId,
          title: "Async questions",
          workspaceRoot: "/tmp/async-project",
          defaultModelSelection: null,
          createdAt,
        }),
      );
      await system.run(
        system.engine.dispatch({
          type: "thread.create",
          commandId: CommandId.makeUnsafe("create-thread"),
          threadId,
          projectId,
          title: "Async questions",
          modelSelection: { provider: "codex", model: "gpt-5-codex" },
          runtimeMode: "approval-required",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt,
        }),
      );
      await system.run(
        system.engine.dispatch({
          type: "thread.messages.import",
          commandId: CommandId.makeUnsafe("original-message"),
          threadId,
          createdAt,
          messages: [
            {
              messageId: MessageId.makeUnsafe("original-message"),
              role: "user",
              text: "Investigate this issue",
              createdAt,
              updatedAt: createdAt,
            },
          ],
        }),
      );
      await system.run(
        system.engine.dispatch({
          type: "thread.turn.diff.complete",
          commandId: CommandId.makeUnsafe("original-checkpoint"),
          threadId,
          turnId,
          checkpointTurnCount: 1,
          checkpointRef: CheckpointRef.makeUnsafe("original-checkpoint"),
          status: "ready",
          files: [],
          completedAt: createdAt,
          createdAt,
        }),
      );
      await system.run(system.engine.dispatch(appendQuestion("question-arrived")));
      const childThreadId = ThreadId.makeUnsafe("subagent:async-thread:child");
      const childQuestionId = EventId.makeUnsafe("child-question");
      await system.run(
        system.engine.dispatch({
          type: "thread.create",
          commandId: CommandId.makeUnsafe("create-child"),
          threadId: childThreadId,
          parentThreadId: threadId,
          projectId,
          title: "Child",
          modelSelection: { provider: "codex", model: "gpt-5-codex" },
          runtimeMode: "approval-required",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt,
        }),
      );
      await system.run(
        system.engine.dispatch({
          type: "thread.activity.append",
          commandId: CommandId.makeUnsafe("child-question"),
          threadId: childThreadId,
          activity: { ...question!, id: childQuestionId },
          createdAt,
        }),
      );
      await expect(
        system.run(
          system.engine.dispatch({
            ...respond("child-answer"),
            threadId: childThreadId,
            asyncUserInputResponse: { activityId: childQuestionId, answers: ["Tabs"] },
          }),
        ),
      ).rejects.toThrow("unavailable");
      const child = Option.getOrThrow(
        await system.run(system.query.getThreadDetailById(childThreadId)),
      );
      expect(child.messages).toHaveLength(0);
      expect(child.activities[0]?.payload).toEqual(question!.payload);

      // A long-running agent must not evict the card from the bounded activity window.
      await system.run(system.sql`
      WITH RECURSIVE numbers(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM numbers WHERE n < 2200)
      INSERT INTO projection_thread_activities
        (activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at)
      SELECT 'work-' || n, ${threadId}, ${turnId}, 'tool', 'tool.completed', 'Done', '{}', n + 100,
        '2026-09-10T12:01:00.000Z' FROM numbers
    `);
      const pending = Option.getOrThrow(
        await system.run(
          system.query.getThreadDetailById(threadId, { includeActivityId: question!.id }),
        ),
      );
      expect(pending.activities.find((activity) => activity.id === question!.id)?.payload).toEqual(
        question!.payload,
      );
      expect(pending.hasPendingUserInput).toBe(false);
      expect(pending.pendingInteractions).toEqual([]);
      const snapshot = await system.run(system.query.getSnapshot());
      expect(
        snapshot.threads
          .find((thread) => thread.id === threadId)
          ?.activities.some((activity) => activity.id === question!.id),
      ).toBe(true);

      await system.dispose();
      system = await createSystem(dbPath);
      await system.run(
        system.engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.makeUnsafe("set-session"),
          threadId,
          session: {
            threadId,
            status,
            providerName: "codex",
            runtimeMode: "approval-required",
            activeTurnId: status === "running" ? turnId : null,
            lastError: null,
            updatedAt: createdAt,
          },
          createdAt,
        }),
      );
      const submissions = await Promise.allSettled([
        system.run(system.engine.dispatch(respond("answer-tab-a"))),
        system.run(system.engine.dispatch(respond("answer-tab-b"))),
      ]);
      expect(submissions.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(submissions.filter((result) => result.status === "rejected")).toHaveLength(1);
      const answered = Option.getOrThrow(
        await system.run(
          system.query.getThreadDetailById(threadId, { includeActivityId: question!.id }),
        ),
      );
      expect(answered.messages).toHaveLength(2);
      const answerMessageId = answered.messages.at(-1)!.id;
      expect(answered.messages.at(-1)?.text).toBe("What triggers it?\nSwitching tabs quickly");
      expect(
        answered.activities.find((activity) => activity.id === question!.id)?.payload,
      ).toMatchObject({
        response: { answers: ["Switching tabs quickly"], messageId: answerMessageId },
      });
      const publicDetail = Option.getOrThrow(
        await system.run(system.query.getThreadDetailById(threadId)),
      );
      expect(publicDetail.activities.some((activity) => activity.id === question!.id)).toBe(false);
      expect(publicDetail.activities.length).toBeLessThanOrEqual(2000);
      expect(
        (await system.run(system.query.getSnapshot())).threads.find(
          (thread) => thread.id === threadId,
        )!.activities.length,
      ).toBeLessThanOrEqual(500);
      expect(answered.messages.at(-1)?.source).toBe("async-user-input");
      await expect(
        system.run(
          system.engine.dispatch({
            type: "thread.message.edit-and-resend",
            commandId: CommandId.makeUnsafe("edit-answer"),
            threadId,
            messageId: answerMessageId,
            text: "Corrected answer",
            runtimeMode: "approval-required",
            interactionMode: "default",
            createdAt,
          }),
        ),
      ).rejects.toThrow("non-native-message");
      const events = Array.from(await system.run(Stream.runCollect(system.engine.readEvents(0))));
      expect(events.filter((event) => event.type === "thread.turn-start-requested")).toHaveLength(
        1,
      );
      expect(
        events.find((event) => event.type === "thread.turn-start-requested")?.payload,
      ).toMatchObject({ dispatchMode: "steer" });
      expect(events.some((event) => event.type === "thread.turn-interrupt-requested")).toBe(false);

      await system.dispose();
      system = await createSystem(dbPath);
      await system.run(system.engine.dispatch(appendQuestion("replayed-item")));
      await expect(
        system.run(system.engine.dispatch(respond("answer-after-restart"))),
      ).rejects.toThrow("already answered");
      const restarted = Option.getOrThrow(
        await system.run(
          system.query.getThreadDetailById(threadId, { includeActivityId: question!.id }),
        ),
      );
      expect(
        restarted.activities.find((activity) => activity.id === question!.id)?.payload,
      ).toMatchObject({ response: { answers: ["Switching tabs quickly"] } });

      await system.run(
        system.engine.dispatch(
          status === "ready"
            ? {
                type: "thread.conversation.rollback.complete",
                commandId: CommandId.makeUnsafe("remove-answer"),
                threadId,
                messageId: answerMessageId,
                numTurns: 1,
                removedTurnIds: [TurnId.makeUnsafe("answer-turn")],
                createdAt,
              }
            : {
                type: "thread.revert.complete",
                commandId: CommandId.makeUnsafe("remove-answer"),
                threadId,
                turnCount: 1,
                createdAt,
              },
        ),
      );
      const reopened = Option.getOrThrow(
        await system.run(
          system.query.getThreadDetailById(threadId, { includeActivityId: question!.id }),
        ),
      );
      expect(reopened.messages.map((message) => message.id)).toEqual(["original-message"]);
      expect(reopened.activities.find((activity) => activity.id === question!.id)?.payload).toEqual(
        question!.payload,
      );

      // The in-memory projector must agree with SQLite when replaying the same history.
      let replayed = createEmptyReadModel(createdAt);
      const history = await system.run(Stream.runCollect(system.engine.readEvents(0)));
      for (const event of history) {
        replayed = await Effect.runPromise(projectEvent(replayed, event));
      }
      expect(
        replayed.threads[0]?.activities.find((activity) => activity.id === question!.id)?.payload,
      ).toEqual(question!.payload);

      await system.dispose();
      system = await createSystem(dbPath);
      await system.run(system.engine.dispatch(respond("replacement-answer")));
      const replaced = Option.getOrThrow(
        await system.run(
          system.query.getThreadDetailById(threadId, { includeActivityId: question!.id }),
        ),
      );
      expect(
        replaced.activities.find((activity) => activity.id === question!.id)?.payload,
      ).toMatchObject({
        response: { messageId: "replacement-answer" },
      });
      await system.run(system.sql`
        WITH RECURSIVE numbers(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM numbers WHERE n < 2200)
        INSERT INTO projection_thread_activities
          (activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at)
        SELECT 'settled-' || n, ${threadId}, NULL, 'info', 'user-input.async', 'Answered',
          ${JSON.stringify({ questions: [{ title: "Which?", options: null }], response: { answers: ["A"], messageId: "replacement-answer" } })},
          n + 3000, '2026-09-10T12:02:00.000Z' FROM numbers
      `);
      const boundedDetail = Option.getOrThrow(
        await system.run(system.query.getThreadDetailById(threadId)),
      );
      expect(boundedDetail.activities).toHaveLength(2000);
      const boundedSnapshot = await system.run(system.query.getSnapshot());
      expect(
        boundedSnapshot.threads.find((thread) => thread.id === threadId)!.activities,
      ).toHaveLength(500);
      await system.run(system.engine.dispatch(appendQuestion("replayed-archived-item")));
      await expect(
        system.run(system.engine.dispatch(respond("duplicate-archived-answer"))),
      ).rejects.toThrow("already answered");
    } finally {
      await system.dispose();
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  },
);
