// FILE: worktreeWorkspace.integration.test.ts
// Purpose: Proves that multiple conversations share one worktree without sharing provider state.
// Layer: Server integration tests

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  WorktreeWorkspaceId,
} from "@synara/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Stream } from "effect";

import {
  makeOrchestrationIntegrationHarness,
  type OrchestrationIntegrationHarness,
} from "./OrchestrationEngineHarness.integration.ts";
import type { TestTurnResponse } from "./TestProviderAdapter.integration.ts";

const PROJECT_ID = ProjectId.makeUnsafe("workspace-project");
const WORKSPACE_ID = WorktreeWorkspaceId.makeUnsafe("workspace-shared");
const FIRST_THREAD_ID = ThreadId.makeUnsafe("workspace-thread-first");
const SECOND_THREAD_ID = ThreadId.makeUnsafe("workspace-thread-second");
const MODEL_SELECTION = {
  provider: "codex" as const,
  model: DEFAULT_MODEL_BY_PROVIDER.codex,
};

function nowIso(): string {
  return new Date().toISOString();
}

function worktreeCount(cwd: string): number {
  return execFileSync("git", ["worktree", "list", "--porcelain"], {
    cwd,
    encoding: "utf8",
  })
    .split("\n")
    .filter((line) => line.startsWith("worktree ")).length;
}

function responseFor(input: {
  threadId: ThreadId;
  text: string;
  mutateWorkspace: TestTurnResponse["mutateWorkspace"];
}): TestTurnResponse {
  const createdAt = nowIso();
  return {
    events: [
      {
        type: "turn.started",
        eventId: EventId.makeUnsafe(`${input.threadId}-started`),
        provider: "codex",
        createdAt,
        threadId: input.threadId,
        turnId: `${input.threadId}-turn`,
      },
      {
        type: "message.delta",
        eventId: EventId.makeUnsafe(`${input.threadId}-message`),
        provider: "codex",
        createdAt,
        threadId: input.threadId,
        turnId: `${input.threadId}-turn`,
        delta: input.text,
      },
      {
        type: "turn.completed",
        eventId: EventId.makeUnsafe(`${input.threadId}-completed`),
        provider: "codex",
        createdAt,
        threadId: input.threadId,
        turnId: `${input.threadId}-turn`,
        status: "completed",
      },
    ],
    ...(input.mutateWorkspace ? { mutateWorkspace: input.mutateWorkspace } : {}),
  };
}

function withHarness<A, E>(use: (harness: OrchestrationIntegrationHarness) => Effect.Effect<A, E>) {
  return Effect.acquireUseRelease(
    makeOrchestrationIntegrationHarness(),
    use,
    (harness) => harness.dispose,
  ).pipe(Effect.provide(NodeServices.layer));
}

it.live("keeps conversation state isolated while sharing one workspace and worktree", () =>
  withHarness((harness) =>
    Effect.gen(function* () {
      const createdAt = nowIso();
      const headRef = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: harness.workspaceDir,
        encoding: "utf8",
      }).trim();
      const initialWorktreeCount = worktreeCount(harness.workspaceDir);

      yield* harness.engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("workspace-project-create"),
        projectId: PROJECT_ID,
        title: "Workspace integration project",
        workspaceRoot: harness.workspaceDir,
        repositoryIdentity: "fixture:workspace-integration",
        defaultTargetRef: "main",
        defaultModelSelection: MODEL_SELECTION,
        createdAt,
      });

      yield* harness.engine.dispatch({
        type: "workspace.attach",
        commandId: CommandId.makeUnsafe("workspace-attach"),
        workspaceId: WORKSPACE_ID,
        threadId: FIRST_THREAD_ID,
        projectId: PROJECT_ID,
        title: "Shared workspace",
        path: harness.workspaceDir,
        branch: "main",
        headRef,
        targetRef: "main",
        sourceKind: "branch",
        sourceRef: "main",
        modelSelection: MODEL_SELECTION,
        runtimeMode: "full-access",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        createdAt,
      });

      const secondConversationCommand = {
        type: "workspace.conversation.create" as const,
        commandId: CommandId.makeUnsafe("workspace-second-conversation"),
        workspaceId: WORKSPACE_ID,
        threadId: SECOND_THREAD_ID,
        title: "Second conversation",
        modelSelection: MODEL_SELECTION,
        runtimeMode: "full-access" as const,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        createdAt,
      };
      yield* harness.engine.dispatch(secondConversationCommand);
      yield* harness.engine.dispatch(secondConversationCommand);

      yield* harness.adapterHarness!.queueTurnResponseForNextSession(
        responseFor({
          threadId: FIRST_THREAD_ID,
          text: "First conversation completed.\n",
          mutateWorkspace: ({ cwd }) =>
            Effect.sync(() => {
              fs.writeFileSync(path.join(cwd, "README.md"), "shared edit from first\n", "utf8");
            }),
        }),
      );
      yield* harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("workspace-first-turn"),
        threadId: FIRST_THREAD_ID,
        message: {
          messageId: MessageId.makeUnsafe("workspace-first-message"),
          role: "user",
          text: "Make a shared edit",
          attachments: [],
        },
        modelSelection: MODEL_SELECTION,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        createdAt: nowIso(),
      });
      const firstThread = yield* harness.waitForThread(
        FIRST_THREAD_ID,
        (thread) =>
          thread.session?.status === "ready" &&
          thread.messages.some(
            (message) =>
              message.role === "assistant" && message.text.includes("First conversation"),
          ),
      );

      yield* harness.adapterHarness!.queueTurnResponseForNextSession(
        responseFor({
          threadId: SECOND_THREAD_ID,
          text: "Second conversation observed the shared edit.\n",
          mutateWorkspace: ({ cwd }) =>
            Effect.sync(() => {
              assert.equal(
                fs.readFileSync(path.join(cwd, "README.md"), "utf8"),
                "shared edit from first\n",
              );
              fs.writeFileSync(path.join(cwd, "second-conversation.txt"), "visible to both\n");
            }),
        }),
      );
      yield* harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("workspace-second-turn"),
        threadId: SECOND_THREAD_ID,
        message: {
          messageId: MessageId.makeUnsafe("workspace-second-message"),
          role: "user",
          text: "Observe the shared edit",
          attachments: [],
        },
        modelSelection: MODEL_SELECTION,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        createdAt: nowIso(),
      });
      const secondThread = yield* harness.waitForThread(
        SECOND_THREAD_ID,
        (thread) =>
          thread.session?.status === "ready" &&
          thread.messages.some(
            (message) =>
              message.role === "assistant" && message.text.includes("Second conversation"),
          ),
      );

      assert.equal(firstThread.worktreePath, harness.workspaceDir);
      assert.equal(secondThread.worktreePath, harness.workspaceDir);
      const providerSessions = yield* harness.providerService.listSessions();
      const firstSession = providerSessions.find((session) => session.threadId === FIRST_THREAD_ID);
      const secondSession = providerSessions.find(
        (session) => session.threadId === SECOND_THREAD_ID,
      );
      assert.equal(firstSession?.cwd, harness.workspaceDir);
      assert.equal(secondSession?.cwd, harness.workspaceDir);
      assert.notEqual(firstSession?.threadId, secondSession?.threadId);
      assert.deepEqual(
        harness.adapterHarness!.listActiveSessionIds().toSorted(),
        [FIRST_THREAD_ID, SECOND_THREAD_ID].toSorted(),
      );
      assert.equal(worktreeCount(harness.workspaceDir), initialWorktreeCount);
      assert.equal(
        fs.readFileSync(path.join(harness.workspaceDir, "second-conversation.txt"), "utf8"),
        "visible to both\n",
      );

      yield* harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.makeUnsafe("workspace-second-rename"),
        threadId: SECOND_THREAD_ID,
        title: "Renamed conversation",
      });
      yield* harness.waitForThread(
        SECOND_THREAD_ID,
        (thread) => thread.title === "Renamed conversation",
      );

      yield* harness.engine.dispatch({
        type: "thread.archive",
        commandId: CommandId.makeUnsafe("workspace-second-archive"),
        threadId: SECOND_THREAD_ID,
      });
      yield* harness.waitForThread(SECOND_THREAD_ID, (thread) => thread.archivedAt !== null);
      yield* harness.engine.dispatch({
        type: "thread.unarchive",
        commandId: CommandId.makeUnsafe("workspace-second-unarchive"),
        threadId: SECOND_THREAD_ID,
      });
      yield* harness.waitForThread(SECOND_THREAD_ID, (thread) => thread.archivedAt === null);

      const snapshot = yield* harness.snapshotQuery.getSnapshot();
      const workspaceShell = yield* harness.snapshotQuery.getWorkspaceShellSnapshot!();
      const events = Array.from(yield* Stream.runCollect(harness.engine.readEvents(0)));
      const workspaceThreads = snapshot.threads.filter(
        (thread) => thread.workspaceId === WORKSPACE_ID,
      );

      assert.equal(snapshot.workspaces?.length, 1);
      assert.equal(workspaceThreads.length, 2);
      assert.equal(
        workspaceThreads.every((thread) => thread.worktreePath === harness.workspaceDir),
        true,
      );
      assert.equal(
        workspaceShell.threads.filter((thread) => thread.workspaceId === WORKSPACE_ID).length,
        2,
      );
      assert.equal(events.filter((event) => event.type === "workspace.created").length, 1);
      assert.equal(events.filter((event) => event.type === "thread.created").length, 2);
    }),
  ),
);
