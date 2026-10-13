import {
  CommandId,
  EventId,
  MessageId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  ProjectId,
  ThreadId,
  type ModelSelection,
  type OrchestrationCommand,
  type OrchestrationReadModel,
} from "@synara/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { projectEvent } from "./projector.ts";
import {
  resolvePendingProviderHandoff,
  toProviderHandoffActivityModelSelection,
} from "@synara/shared/providerHandoff";

const NOW = "2026-10-02T18:00:00.000Z";
const THREAD_ID = ThreadId.makeUnsafe("thread-provider-handoff");
const SOURCE: ModelSelection = { provider: "codex", model: "gpt-5.4" };
const TARGET: ModelSelection = { provider: "claudeAgent", model: "claude-sonnet-4-6" };

function makeReadModel(
  session: OrchestrationReadModel["threads"][number]["session"] = null,
): OrchestrationReadModel {
  return {
    snapshotSequence: 1,
    updatedAt: NOW,
    spaces: [],
    projects: [],
    threads: [
      {
        id: THREAD_ID,
        projectId: ProjectId.makeUnsafe("project-provider-handoff"),
        title: "Provider handoff",
        modelSelection: SOURCE,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        branch: "feature/handoff",
        worktreePath: "/tmp/worktrees/handoff",
        createdAt: NOW,
        updatedAt: NOW,
        latestTurn: null,
        handoff: null,
        messages: [],
        session,
        activities: [],
        proposedPlans: [],
        checkpoints: [],
        deletedAt: null,
      },
    ],
  };
}

const decideHandoff = (modelSelection: ModelSelection, readModel = makeReadModel()) =>
  Effect.runPromise(
    decideOrchestrationCommand({
      command: {
        type: "thread.meta.update",
        commandId: CommandId.makeUnsafe("cmd-provider-handoff"),
        threadId: THREAD_ID,
        modelSelection,
        providerHandoff: true,
      },
      readModel,
    }),
  );

describe("decider same-thread provider handoff", () => {
  it("records the source selection alongside the target selection", async () => {
    const event = await decideHandoff({ provider: "claudeAgent", model: "claude-sonnet-4-6" });
    const events = Array.isArray(event) ? event : [event];
    expect(events.map((row) => row.type)).toEqual([
      "thread.activity-appended",
      "thread.meta-updated",
    ]);
    expect(events[0]).toMatchObject({
      payload: {
        activity: {
          kind: "provider.handoff.requested",
          payload: { handoffCommandId: "cmd-provider-handoff" },
        },
      },
    });
    const single = events.find((row) => row.type === "thread.meta-updated");
    expect(single).toMatchObject({
      type: "thread.meta-updated",
      payload: {
        threadId: THREAD_ID,
        modelSelection: { provider: "claudeAgent", model: "claude-sonnet-4-6" },
        providerHandoff: { sourceModelSelection: SOURCE },
      },
    });
    // The handoff only rebinds the provider; the workspace stays untouched.
    expect(single?.payload).not.toHaveProperty("worktreePath");
    expect(single?.payload).not.toHaveProperty("branch");
  });

  it("keeps same-provider account switches on the new-thread handoff", async () => {
    await expect(
      decideHandoff({
        provider: "codex",
        instanceId: "codex-work",
        model: "gpt-5.4",
      }),
    ).rejects.toThrow(/hand off to a new thread instead/);
  });

  it("rejects a handoff while the session is running", async () => {
    await expect(
      decideHandoff(
        { provider: "claudeAgent", model: "claude-sonnet-4-6" },
        makeReadModel({
          threadId: THREAD_ID,
          status: "running",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: NOW,
        }),
      ),
    ).rejects.toThrow(/still has a running turn/);
  });

  async function apply(command: OrchestrationCommand, readModel: OrchestrationReadModel) {
    const result = await Effect.runPromise(decideOrchestrationCommand({ command, readModel }));
    for (const event of Array.isArray(result) ? result : [result]) {
      readModel = await Effect.runPromise(
        projectEvent(readModel, { ...event, sequence: readModel.snapshotSequence + 1 }),
      );
    }
    return readModel;
  }
  const begin = (readModel = makeReadModel()) =>
    apply(
      {
        type: "thread.meta.update",
        commandId: CommandId.makeUnsafe("pending"),
        threadId: THREAD_ID,
        modelSelection: TARGET,
        providerHandoff: true,
      },
      readModel,
    );
  const common = {
    commandId: CommandId.makeUnsafe("competing"),
    threadId: THREAD_ID,
    createdAt: NOW,
  };
  const competing: OrchestrationCommand[] = [
    { ...common, type: "thread.meta.update", modelSelection: SOURCE },
    { ...common, type: "thread.meta.update", modelSelection: SOURCE, providerHandoff: true },
    { ...common, type: "thread.runtime-mode.set", runtimeMode: "approval-required" },
    { ...common, type: "thread.interaction-mode.set", interactionMode: "plan" },
    {
      ...common,
      type: "thread.turn.start",
      message: {
        messageId: MessageId.makeUnsafe("message"),
        role: "user",
        text: "Do work",
        attachments: [],
      },
      runtimeMode: "full-access",
      interactionMode: "default",
    },
    {
      ...common,
      type: "thread.turn.dispatch-queued",
      messageId: MessageId.makeUnsafe("queued"),
      runtimeMode: "full-access",
      interactionMode: "default",
      dispatchMode: "queue",
    },
    { ...common, type: "thread.checkpoint.revert", turnCount: 0 },
    {
      ...common,
      type: "thread.conversation.rollback",
      messageId: MessageId.makeUnsafe("message"),
      numTurns: 0,
    },
    {
      ...common,
      type: "thread.message.edit-and-resend",
      messageId: MessageId.makeUnsafe("message"),
      text: "Edited",
      runtimeMode: "full-access",
      interactionMode: "default",
    },
    { ...common, type: "thread.goal.continue", goalStartedAt: NOW, trigger: "goal-updated" },
  ];
  it.each(competing)("refuses $type while a durable handoff is pending", async (command) => {
    const model = await begin();
    await expect(apply(command, model)).rejects.toThrow(/still switching/);
    expect(resolvePendingProviderHandoff(model.threads[0]!.activities)?.handoffCommandId).toBe(
      "pending",
    );
    expect(model.threads[0]?.messages).toEqual([]);
  });
  const workspace = {
    envMode: "worktree",
    branch: "feature/handoff",
    worktreePath: "/tmp/worktrees/handoff",
    workingDirectory: "/tmp/worktrees/handoff/nested",
    associatedWorktreePath: "/tmp/worktrees/handoff",
    associatedWorktreeBranch: "feature/handoff",
    associatedWorktreeRef: "refs/heads/feature/handoff",
  } as const;
  const beginInWorkspace = () => {
    const model = makeReadModel();
    return begin({
      ...model,
      threads: model.threads.map((thread) => ({ ...thread, ...workspace })),
    });
  };
  const workspaceMutations = [
    { field: "envMode", patch: { envMode: "local" } },
    { field: "branch", patch: { branch: "feature/other" } },
    { field: "worktreePath", patch: { worktreePath: "/tmp/other-worktree" } },
    { field: "workingDirectory", patch: { workingDirectory: "/tmp/other-directory" } },
    { field: "associatedWorktreePath", patch: { associatedWorktreePath: "/tmp/other-worktree" } },
    { field: "associatedWorktreeBranch", patch: { associatedWorktreeBranch: "feature/other" } },
    { field: "associatedWorktreeRef", patch: { associatedWorktreeRef: "refs/heads/other" } },
    { field: "branch cleared", patch: { branch: null } },
    { field: "worktreePath cleared", patch: { worktreePath: null } },
    { field: "workingDirectory cleared", patch: { workingDirectory: null } },
    { field: "associatedWorktreePath cleared", patch: { associatedWorktreePath: null } },
    { field: "associatedWorktreeBranch cleared", patch: { associatedWorktreeBranch: null } },
    { field: "associatedWorktreeRef cleared", patch: { associatedWorktreeRef: null } },
  ] satisfies ReadonlyArray<{
    field: string;
    patch: Partial<Extract<OrchestrationCommand, { type: "thread.meta.update" }>>;
  }>;
  it.each(workspaceMutations)(
    "refuses $field changes while a handoff is pending",
    async ({ patch }) => {
      const model = await beginInWorkspace();
      await expect(
        apply({ ...common, type: "thread.meta.update", ...patch }, model),
      ).rejects.toThrow(/still switching/);
      expect(model.threads[0]).toMatchObject(workspace);
      expect(resolvePendingProviderHandoff(model.threads[0]!.activities)?.handoffCommandId).toBe(
        "pending",
      );
    },
  );
  it("permits exact workspace reaffirmation with rename, pin, and notes while pending", async () => {
    const model = await beginInWorkspace();
    const metadata = {
      title: "Renamed while switching",
      isPinned: true,
      notes: "Keep these notes",
    };
    const after = await apply(
      { ...common, type: "thread.meta.update", ...workspace, ...metadata },
      model,
    );
    expect(after.threads[0]).toMatchObject({ ...workspace, ...metadata });
    expect(resolvePendingProviderHandoff(after.threads[0]!.activities)?.handoffCommandId).toBe(
      "pending",
    );
  });
  const settlement = (outcome: "completed" | "failed"): OrchestrationCommand => ({
    type: "thread.provider.handoff.settle",
    commandId: CommandId.makeUnsafe(`settle-${outcome}`),
    threadId: THREAD_ID,
    handoffCommandId: CommandId.makeUnsafe("pending"),
    sourceModelSelection: SOURCE,
    targetModelSelection: TARGET,
    outcome,
    contextText: "Bounded recap",
    createdAt: NOW,
  });
  it.each(["completed", "failed"] as const)(
    "settles %s atomically without moving newer metadata backward",
    async (outcome) => {
      let model = await begin();
      model = await apply(
        { ...common, type: "thread.meta.update", title: "Renamed while switching" },
        model,
      );
      const newer = "2040-01-01T00:00:00.000Z";
      model = {
        ...model,
        threads: model.threads.map((thread) => ({ ...thread, updatedAt: newer })),
      };
      const after = await apply(settlement(outcome), model);
      const thread = after.threads[0]!;
      const expectedSelection = outcome === "completed" ? TARGET : SOURCE;
      expect(thread.modelSelection).toEqual({
        ...expectedSelection,
        instanceId: expectedSelection.provider,
      });
      expect(thread.title).toBe("Renamed while switching");
      expect(thread.updatedAt).toBe(newer);
      expect(thread.activities.at(-1)?.createdAt).toBe(newer);
      expect(resolvePendingProviderHandoff(thread.activities)).toBeNull();
      expect(thread.branch).toBe("feature/handoff");
      expect(thread.worktreePath).toBe("/tmp/worktrees/handoff");
    },
  );
  it("refuses stale settlement and still permits stop while admission is held", async () => {
    const model = await begin();
    await expect(
      apply(
        {
          ...settlement("completed"),
          handoffCommandId: CommandId.makeUnsafe("older"),
        } as OrchestrationCommand,
        model,
      ),
    ).rejects.toThrow(/no longer owns/);
    const stopped = await apply({ ...common, type: "thread.session.stop" }, model);
    expect(resolvePendingProviderHandoff(stopped.threads[0]!.activities)?.handoffCommandId).toBe(
      "pending",
    );
  });
  it.each(["stop", "interrupt", "archive-unarchive"] as const)(
    "keeps %s cancellation authoritative at atomic settlement without releasing admission early",
    async (action) => {
      let model = await begin();
      model = await apply(
        {
          ...common,
          type:
            action === "stop"
              ? "thread.session.stop"
              : action === "interrupt"
                ? "thread.turn.interrupt"
                : "thread.archive",
        },
        model,
      );
      if (action === "archive-unarchive") {
        model = await apply({ ...common, type: "thread.unarchive" }, model);
      }
      expect(resolvePendingProviderHandoff(model.threads[0]!.activities)?.handoffCommandId).toBe(
        "pending",
      );
      await expect(apply(settlement("completed"), model)).rejects.toThrow(/cancelled/);
      const failed = await apply(settlement("failed"), model);
      expect(resolvePendingProviderHandoff(failed.threads[0]!.activities)).toBeNull();
      expect(failed.threads[0]?.modelSelection).toEqual({ ...SOURCE, instanceId: SOURCE.provider });
    },
  );
  it("restores a cancelled archived request but refuses successful settlement", async () => {
    const pending = await begin();
    const archived = {
      ...pending,
      threads: pending.threads.map((thread) => ({ ...thread, archivedAt: NOW })),
    };
    await expect(apply(settlement("completed"), archived)).rejects.toThrow(/archived/);
    const failed = await apply(settlement("failed"), archived);
    expect(failed.threads[0]?.archivedAt).toBe(NOW);
    expect(failed.threads[0]?.modelSelection).toEqual({ ...SOURCE, instanceId: SOURCE.provider });
    expect(resolvePendingProviderHandoff(failed.threads[0]!.activities)).toBeNull();
  });
  it("does not replace a durable request with a stale recovery reservation", async () => {
    const model = await begin();
    const command: OrchestrationCommand = {
      ...common,
      type: "thread.activity.append",
      activity: {
        id: EventId.makeUnsafe("provider-handoff-requested:older"),
        kind: "provider.handoff.requested",
        tone: "info",
        summary: "Switching",
        turnId: null,
        createdAt: NOW,
        payload: {
          handoffCommandId: "older",
          sourceModelSelection: toProviderHandoffActivityModelSelection(SOURCE),
          targetModelSelection: toProviderHandoffActivityModelSelection(TARGET),
        },
      },
    };
    await expect(apply(command, model)).rejects.toThrow(/still switching/);
    await expect(apply(command, makeReadModel())).rejects.toThrow(/no longer owns/);
  });
});
