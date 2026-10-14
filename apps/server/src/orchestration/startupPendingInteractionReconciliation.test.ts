import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { OrchestrationThread, OrchestrationThreadActivity } from "@synara/contracts";
import {
  ApprovalRequestId,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
} from "@synara/contracts";
import { Effect, Layer, ManagedRuntime, Option } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { ServerConfig } from "../config.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { ProjectionPendingInteractionRepositoryLive } from "../persistence/Layers/ProjectionPendingInteractions.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { ProjectionPendingInteractionRepository } from "../persistence/Services/ProjectionPendingInteractions.ts";
import { OrchestrationEngineLive } from "./Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import { reconcileRestartStuckTurns } from "./startupTurnReconciliation.ts";
import { ServerSettingsService } from "../serverSettings.ts";

const PROJECT_ID = ProjectId.makeUnsafe("project-1");
const THREAD_ID = ThreadId.makeUnsafe("thread-1");
const LIFECYCLE_GENERATION = "generation-before-crash";

const structuredQuestions = [
  {
    id: "next_step",
    header: "Next",
    question: "How should the turn continue?",
    options: [{ label: "Cancel", description: "Stop the stale request." }],
  },
];

const pendingInteractionStatus = (thread: OrchestrationThread | undefined, requestId: string) =>
  thread?.pendingInteractions?.find((row) => row.requestId === requestId)?.status;

const failureActivitiesFor = (thread: OrchestrationThread | undefined, requestId: string) =>
  thread?.activities.filter(
    (activity) =>
      (activity.kind === "provider.user-input.respond.failed" ||
        activity.kind === "provider.approval.respond.failed") &&
      (activity.payload as { readonly requestId?: unknown } | null)?.requestId === requestId,
  ) ?? [];

describe("boot-time pending interaction reconciliation", () => {
  let runtime: ManagedRuntime.ManagedRuntime<never, never> | null = null;
  const tempDirs: string[] = [];

  afterEach(async () => {
    if (runtime) {
      await runtime.dispose();
      runtime = null;
    }
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  async function createHarness() {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "synara-startup-pending-"));
    tempDirs.push(workspaceRoot);
    fs.mkdirSync(path.join(workspaceRoot, ".git"));

    const layer = OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionPipelineLive),
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationEventStoreLive),
      Layer.provide(OrchestrationCommandReceiptRepositoryLive),
      Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
      Layer.provideMerge(ProjectionPendingInteractionRepositoryLive),
      Layer.provide(ServerSettingsService.layerTest()),
      Layer.provideMerge(SqlitePersistenceMemory),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
      Layer.provideMerge(NodeServices.layer),
    );
    const managed = ManagedRuntime.make(layer);
    runtime = managed as unknown as ManagedRuntime.ManagedRuntime<never, never>;

    const engine = await managed.runPromise(Effect.service(OrchestrationEngineService));
    const snapshotQuery = await managed.runPromise(Effect.service(ProjectionSnapshotQuery));
    const pendingInteractions = await managed.runPromise(
      Effect.service(ProjectionPendingInteractionRepository),
    );

    const createdAt = new Date().toISOString();
    await Effect.runPromise(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("cmd-project-create"),
        projectId: PROJECT_ID,
        title: "Project",
        workspaceRoot,
        defaultModelSelection: { provider: "codex", model: "gpt-5-codex" },
        createdAt,
      }),
    );
    await Effect.runPromise(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-thread-create"),
        threadId: THREAD_ID,
        projectId: PROJECT_ID,
        title: "Thread",
        modelSelection: { provider: "codex", model: "gpt-5-codex" },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    // The previous process died hard: no runtime, no in-flight turn, and a
    // session projection that already looks perfectly idle.
    await Effect.runPromise(
      engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-seed"),
        threadId: THREAD_ID,
        session: {
          threadId: THREAD_ID,
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

    const appendActivity = (input: {
      readonly id: string;
      readonly kind: string;
      readonly payload: OrchestrationThreadActivity["payload"];
      readonly sequence?: number;
    }) =>
      Effect.runPromise(
        engine.dispatch({
          type: "thread.activity.append",
          commandId: CommandId.makeUnsafe(`cmd-${input.id}`),
          threadId: THREAD_ID,
          activity: {
            id: EventId.makeUnsafe(`activity-${input.id}`),
            tone: "info",
            kind: input.kind,
            summary: input.kind,
            payload: input.payload,
            turnId: null,
            createdAt: new Date().toISOString(),
            ...(input.sequence !== undefined ? { sequence: input.sequence } : {}),
          },
          createdAt: new Date().toISOString(),
        }),
      );

    const readThread = async (): Promise<OrchestrationThread | undefined> =>
      Option.getOrUndefined(await managed.runPromise(snapshotQuery.getThreadDetailById(THREAD_ID)));

    const readPendingCounts = () =>
      managed.runPromise(pendingInteractions.getPendingCountsByThreadId({ threadId: THREAD_ID }));

    // Thread detail hides `confirmed` rows, so answered interactions are read
    // straight from the settlement authority.
    const readRowStatus = async (
      requestId: string,
      interactionKind: "approval" | "userInput" = "userInput",
    ) =>
      Option.getOrUndefined(
        await managed.runPromise(
          pendingInteractions.getByIdentity({
            threadId: THREAD_ID,
            interactionKind,
            requestId: ApprovalRequestId.makeUnsafe(requestId),
          }),
        ),
      )?.status;

    /** Drives the row to the status a failed answer against a dead runtime leaves behind. */
    const markRetryable = async (
      requestId: string,
      interactionKind: "approval" | "userInput" = "userInput",
    ) => {
      const row = Option.getOrThrow(
        await managed.runPromise(
          pendingInteractions.getByIdentity({
            threadId: THREAD_ID,
            interactionKind,
            requestId: ApprovalRequestId.makeUnsafe(requestId),
          }),
        ),
      );
      await managed.runPromise(pendingInteractions.upsert({ ...row, status: "retryable" }));
    };

    const runBootReconciliation = () => managed.runPromise(reconcileRestartStuckTurns);

    return {
      engine,
      pendingInteractions,
      appendActivity,
      readThread,
      readPendingCounts,
      readRowStatus,
      markRetryable,
      runBootReconciliation,
      managed,
    };
  }

  it("settles interactions left unresolved by a previous process and clears their projections", async () => {
    const harness = await createHarness();

    // Two rows a hard-killed process leaves behind. Neither is visible to the
    // timeline-derived pending-request scan: the user-input request carries no
    // structured questions, and the approval already recorded a (non-stale)
    // failure from an answer attempt that hit the dead runtime.
    await harness.appendActivity({
      id: "user-input-requested-orphaned",
      kind: "user-input.requested",
      payload: {
        requestId: "req-orphaned-user-input",
        lifecycleGeneration: LIFECYCLE_GENERATION,
      },
    });
    await harness.appendActivity({
      id: "approval-requested-orphaned",
      kind: "approval.requested",
      payload: {
        requestId: "req-orphaned-approval",
        requestKind: "command",
        lifecycleGeneration: LIFECYCLE_GENERATION,
      },
    });
    await harness.appendActivity({
      id: "approval-respond-failed-orphaned",
      kind: "provider.approval.respond.failed",
      payload: {
        requestId: "req-orphaned-approval",
        detail:
          "Cannot respond to request 'req-orphaned-approval' because the provider runtime is not active",
      },
    });
    await harness.markRetryable("req-orphaned-approval", "approval");

    expect(await harness.readPendingCounts()).toEqual({
      pendingApprovalCount: 1,
      pendingUserInputCount: 1,
    });

    await harness.runBootReconciliation();

    const thread = await harness.readThread();
    expect(await harness.readRowStatus("req-orphaned-user-input")).toBe("confirmed");
    expect(await harness.readRowStatus("req-orphaned-approval", "approval")).toBe("confirmed");
    expect(await harness.readPendingCounts()).toEqual({
      pendingApprovalCount: 0,
      pendingUserInputCount: 0,
    });

    const userInputFailures = failureActivitiesFor(thread, "req-orphaned-user-input");
    expect(userInputFailures).toHaveLength(1);
    expect(userInputFailures[0]?.kind).toBe("provider.user-input.respond.failed");
    expect(userInputFailures[0]?.payload).toMatchObject({
      detail: expect.stringContaining("Stale pending user-input request: req-orphaned-user-input"),
    });
    const approvalFailures = failureActivitiesFor(thread, "req-orphaned-approval").filter(
      (activity) =>
        typeof (activity.payload as { readonly detail?: unknown } | null)?.detail === "string" &&
        ((activity.payload as { readonly detail: string }).detail.startsWith("Stale pending") ??
          false),
    );
    expect(approvalFailures).toHaveLength(1);
  });

  it("emits exactly one settlement when a request is both timeline-open and durably unresolved", async () => {
    const harness = await createHarness();

    await harness.appendActivity({
      id: "user-input-requested-structured",
      kind: "user-input.requested",
      payload: {
        requestId: "req-structured",
        lifecycleGeneration: LIFECYCLE_GENERATION,
        questions: structuredQuestions,
      },
    });

    await harness.runBootReconciliation();

    const thread = await harness.readThread();
    expect(await harness.readRowStatus("req-structured")).toBe("confirmed");
    expect(failureActivitiesFor(thread, "req-structured")).toHaveLength(1);
  });

  it.each([
    { interactionKind: "userInput" as const, stale: true },
    { interactionKind: "approval" as const, stale: true },
    { interactionKind: "userInput" as const, stale: false },
  ])(
    "settles a claimed $interactionKind failure durably (stale=$stale)",
    async ({ interactionKind, stale }) => {
      const harness = await createHarness();
      const requestId = ApprovalRequestId.makeUnsafe("req-claimed-failure");
      const requestKind = interactionKind === "approval" ? "approval" : "user-input";
      const commandId = CommandId.makeUnsafe("cmd-response-claimed");
      await harness.appendActivity({
        id: "claimed-request",
        kind: `${requestKind}.requested`,
        payload: {
          requestId,
          lifecycleGeneration: LIFECYCLE_GENERATION,
          requestKind: "command",
          questions: structuredQuestions,
        },
        sequence: 2_479_474,
      });
      const response = {
        commandId,
        threadId: THREAD_ID,
        requestId,
        lifecycleGeneration: LIFECYCLE_GENERATION,
        createdAt: new Date().toISOString(),
      };
      await Effect.runPromise(
        harness.engine.dispatch(
          interactionKind === "userInput"
            ? { ...response, type: "thread.user-input.respond", answers: {} }
            : { ...response, type: "thread.approval.respond", decision: "cancel" },
        ),
      );
      expect(await harness.readRowStatus(requestId, interactionKind)).toBe("responding");
      await harness.appendActivity({
        id: "claimed-failure",
        kind: `provider.${requestKind}.respond.failed`,
        sequence: 874_284,
        payload: {
          requestId,
          lifecycleGeneration: LIFECYCLE_GENERATION,
          responseCommandId: commandId,
          settlementStatus: "uncertain",
          detail: stale
            ? `Stale pending ${requestKind} request: ${requestId}. Restart the turn to continue.`
            : "Provider response delivery could not be confirmed.",
        },
      });
      expect(await harness.readRowStatus(requestId, interactionKind)).toBe(
        stale ? "confirmed" : "uncertain",
      );
      const row = Option.getOrThrow(
        await harness.managed.runPromise(
          harness.pendingInteractions.getByIdentity({
            threadId: THREAD_ID,
            interactionKind,
            requestId,
          }),
        ),
      );
      expect(row.resolvedAt === null).toBe(!stale);
      const thread = await harness.readThread();
      expect(
        thread?.pendingInteractions?.some((interaction) => interaction.requestId === requestId),
      ).toBe(!stale);
    },
  );

  it.each(["approval", "userInput"] as const)(
    "closes a legacy uncertain %s row even when its stale failure already exists",
    async (interactionKind) => {
      const harness = await createHarness();
      const requestId = ApprovalRequestId.makeUnsafe("req-legacy-stale");
      const requestKind = interactionKind === "approval" ? "approval" : "user-input";
      await harness.appendActivity({
        id: "legacy-request",
        kind: `${requestKind}.requested`,
        payload: {
          requestId,
          lifecycleGeneration: LIFECYCLE_GENERATION,
          requestKind: "command",
          questions: structuredQuestions,
        },
      });
      await harness.appendActivity({
        id: "legacy-failure",
        kind: `provider.${requestKind}.respond.failed`,
        payload: {
          requestId,
          lifecycleGeneration: LIFECYCLE_GENERATION,
          detail: `Stale pending ${requestKind} request: ${requestId}. Restart the turn to continue.`,
        },
      });
      // Simulate a persisted row from the old projection, whose callback is gone.
      const row = Option.getOrThrow(
        await harness.managed.runPromise(
          harness.pendingInteractions.getByIdentity({
            threadId: THREAD_ID,
            interactionKind,
            requestId,
          }),
        ),
      );
      await harness.managed.runPromise(
        harness.pendingInteractions.upsert({ ...row, status: "uncertain", resolvedAt: null }),
      );
      await harness.runBootReconciliation();
      expect(await harness.readRowStatus(requestId, interactionKind)).toBe("confirmed");
      const settled = Option.getOrThrow(
        await harness.managed.runPromise(
          harness.pendingInteractions.getByIdentity({
            threadId: THREAD_ID,
            interactionKind,
            requestId,
          }),
        ),
      );
      expect(settled.resolvedAt).not.toBeNull();
      const failures = failureActivitiesFor(await harness.readThread(), requestId);
      await harness.runBootReconciliation();
      expect(failureActivitiesFor(await harness.readThread(), requestId)).toHaveLength(
        failures.length,
      );
    },
  );

  it("leaves resolved interactions untouched", async () => {
    const harness = await createHarness();

    await harness.appendActivity({
      id: "user-input-requested-answered",
      kind: "user-input.requested",
      payload: {
        requestId: "req-answered",
        lifecycleGeneration: LIFECYCLE_GENERATION,
        questions: structuredQuestions,
      },
    });
    await harness.appendActivity({
      id: "user-input-resolved-answered",
      kind: "user-input.resolved",
      payload: {
        requestId: "req-answered",
        lifecycleGeneration: LIFECYCLE_GENERATION,
        answers: {},
      },
    });
    expect(await harness.readRowStatus("req-answered")).toBe("confirmed");

    await harness.runBootReconciliation();

    const thread = await harness.readThread();
    expect(await harness.readRowStatus("req-answered")).toBe("confirmed");
    expect(failureActivitiesFor(thread, "req-answered")).toHaveLength(0);
    expect(await harness.readPendingCounts()).toEqual({
      pendingApprovalCount: 0,
      pendingUserInputCount: 0,
    });
  });

  it("keeps interactions created after boot answerable", async () => {
    const harness = await createHarness();

    await harness.appendActivity({
      id: "user-input-requested-orphaned",
      kind: "user-input.requested",
      payload: { requestId: "req-orphaned", lifecycleGeneration: LIFECYCLE_GENERATION },
    });
    await harness.runBootReconciliation();

    // A session started in this process asks its own question afterwards.
    await harness.appendActivity({
      id: "user-input-requested-post-boot",
      kind: "user-input.requested",
      payload: {
        requestId: "req-post-boot",
        lifecycleGeneration: "generation-after-boot",
        questions: structuredQuestions,
      },
    });

    const thread = await harness.readThread();
    expect(await harness.readRowStatus("req-orphaned")).toBe("confirmed");
    expect(pendingInteractionStatus(thread, "req-post-boot")).toBe("pending");
    expect(failureActivitiesFor(thread, "req-post-boot")).toHaveLength(0);
    expect(await harness.readPendingCounts()).toEqual({
      pendingApprovalCount: 0,
      pendingUserInputCount: 1,
    });

    // Still answerable: the settlement pass did not claim or fence the new row.
    const claimed = await harness.managed.runPromise(
      harness.pendingInteractions.claimResponse({
        threadId: THREAD_ID,
        interactionKind: "userInput",
        requestId: ApprovalRequestId.makeUnsafe("req-post-boot"),
        lifecycleGeneration: "generation-after-boot",
        responseCommandId: CommandId.makeUnsafe("cmd-post-boot-response"),
        decision: null,
        requestedAt: new Date().toISOString(),
      }),
    );
    expect(claimed).toBe(true);
  });

  it("finalizes the assistant message an orphaned turn left streaming, keeping its text", async () => {
    const harness = await createHarness();
    const turnId = TurnId.makeUnsafe("turn-orphaned");
    const messageId = MessageId.makeUnsafe("assistant:orphaned-item");
    const at = new Date().toISOString();
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-running"),
        threadId: THREAD_ID,
        session: {
          threadId: THREAD_ID,
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: turnId,
          lastError: null,
          updatedAt: at,
        },
        createdAt: at,
      }),
    );
    for (const [index, delta] of ["Partial ", "answer"].entries()) {
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.message.assistant.delta",
          commandId: CommandId.makeUnsafe(`cmd-delta-${index}`),
          threadId: THREAD_ID,
          messageId,
          delta,
          turnId,
          createdAt: new Date().toISOString(),
        }),
      );
    }
    const before = (await harness.readThread())?.messages.find((m) => m.id === messageId);
    expect(before).toMatchObject({ streaming: true, text: "Partial answer" });

    await harness.runBootReconciliation();
    // A second boot pass has nothing left to do.
    await harness.runBootReconciliation();

    const thread = await harness.readThread();
    const messages = thread?.messages.filter((m) => m.id === messageId) ?? [];
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ streaming: false, text: "Partial answer", turnId });
    expect(thread?.session).toMatchObject({ status: "interrupted", activeTurnId: null });
  });
});
