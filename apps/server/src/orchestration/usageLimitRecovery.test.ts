// FILE: usageLimitRecovery.test.ts
// Purpose: Verify serialized recovery admission and user cancellation ownership.

import {
  CommandId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type OrchestrationThread,
  type UsageLimitRecovery,
} from "@synara/contracts";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { projectEvent } from "./projector.ts";

const NOW = "2026-10-31T10:00:00.000Z";
const START = "2026-10-31T09:00:00.000Z";
const RESET = "2026-10-31T11:00:00.000Z";
const THREAD_ID = ThreadId.makeUnsafe("limited-thread");
const TURN_ID = TurnId.makeUnsafe("failed-turn");
const PROJECT_ID = ProjectId.makeUnsafe("limited-project");
type Event = Omit<OrchestrationEvent, "sequence">;

function recovery(patch: Partial<UsageLimitRecovery> = {}): UsageLimitRecovery {
  return {
    id: "limit-episode",
    turnId: TURN_ID,
    resetAt: RESET,
    autoResume: true,
    provider: "codex",
    providerInstanceId: "codex",
    model: "gpt-5-codex",
    bindingKey: "opaque-account-binding",
    policyEpoch: 0,
    ...patch,
  };
}

function readModel(patch: Partial<OrchestrationThread> = {}): OrchestrationReadModel {
  return {
    snapshotSequence: 1,
    updatedAt: NOW,
    spaces: [],
    projects: [
      {
        id: PROJECT_ID,
        title: "Project",
        workspaceRoot: "/tmp/usage-limit-recovery-project",
        defaultModelSelection: null,
        scripts: [],
        createdAt: START,
        updatedAt: NOW,
        deletedAt: null,
      },
    ],
    threads: [
      {
        id: THREAD_ID,
        projectId: PROJECT_ID,
        title: "Limited task",
        modelSelection: { provider: "codex", model: "gpt-5-codex" },
        interactionMode: "default",
        runtimeMode: "full-access",
        branch: null,
        worktreePath: null,
        parentThreadId: null,
        sidechatSourceThreadId: null,
        createdAt: START,
        updatedAt: NOW,
        latestTurn: {
          turnId: TURN_ID,
          state: "error",
          requestedAt: START,
          startedAt: START,
          completedAt: NOW,
          assistantMessageId: null,
        },
        handoff: null,
        messages: [],
        session: null,
        activities: [],
        proposedPlans: [],
        checkpoints: [],
        deletedAt: null,
        usageLimitRecoverySource: {
          turnId: TURN_ID,
          bindingKey: "opaque-account-binding",
          policyEpoch: 0,
        },
        ...patch,
      },
    ],
  };
}

function schedule(wait = recovery()): OrchestrationCommand {
  return {
    type: "thread.usage-limit.schedule",
    commandId: CommandId.makeUnsafe(`schedule-${wait.id}`),
    threadId: THREAD_ID,
    recovery: wait,
    createdAt: NOW,
  };
}

function resume(wait = recovery(), policyEpoch = wait.policyEpoch): OrchestrationCommand {
  return {
    type: "thread.usage-limit.resume",
    commandId: CommandId.makeUnsafe(`resume-${wait.id}`),
    threadId: THREAD_ID,
    recoveryId: wait.id,
    policyEpoch,
    createdAt: new Date().toISOString(),
  };
}

async function decide(
  model: OrchestrationReadModel,
  command: OrchestrationCommand,
): Promise<readonly Event[]> {
  const result = await Effect.runPromise(decideOrchestrationCommand({ readModel: model, command }));
  return "type" in result ? [result] : result;
}

async function apply(model: OrchestrationReadModel, command: OrchestrationCommand) {
  const events = await decide(model, command);
  let next = model;
  for (const event of events) {
    next = await Effect.runPromise(
      projectEvent(next, {
        ...event,
        sequence: next.snapshotSequence + 1,
      } as OrchestrationEvent),
    );
  }
  return { model: next, thread: next.threads[0]!, events };
}

function continuations(events: readonly Event[]) {
  return events.filter((event) => event.type === "thread.goal-continuation-requested");
}

describe("usage-limit recovery command ownership", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it("arms only the current failed turn with a future, advancing reset", async () => {
    const armed = await apply(readModel(), schedule());
    expect(armed.thread.usageLimitRecovery).toMatchObject({
      id: "limit-episode",
      state: "waiting",
    });
    expect(armed.thread.messages).toHaveLength(0);
    expect(armed.thread.latestTurn?.state).toBe("error");
    for (const [model, wait] of [
      [readModel(), recovery({ resetAt: NOW })],
      [readModel({ usageLimitRecoveryLastResetAt: RESET }), recovery()],
      [readModel({ latestTurn: null }), recovery()],
      [
        readModel({ latestTurn: { ...readModel().threads[0]!.latestTurn!, state: "completed" } }),
        recovery(),
      ],
      [
        readModel({
          latestTurn: {
            ...readModel().threads[0]!.latestTurn!,
            turnId: TurnId.makeUnsafe("newer-turn"),
          },
        }),
        recovery(),
      ],
    ] as const) {
      const result = await apply(model, schedule(wait));
      expect(result.thread.usageLimitRecovery).toBeUndefined();
      expect(continuations(result.events)).toHaveLength(0);
    }
  });

  it("does not arm a historical failed task without the source frozen for its live turn", async () => {
    for (const source of [
      null,
      {
        turnId: TurnId.makeUnsafe("older-turn"),
        bindingKey: "opaque-account-binding",
        policyEpoch: 0,
      },
      { turnId: TURN_ID, bindingKey: "changed-account-binding", policyEpoch: 0 },
      { turnId: TURN_ID, bindingKey: "opaque-account-binding", policyEpoch: 1 },
    ]) {
      const result = await apply(readModel({ usageLimitRecoverySource: source }), schedule());
      expect(result.thread.usageLimitRecovery).toBeUndefined();
      expect(continuations(result.events)).toHaveLength(0);
    }
  });

  it("freezes eligibility only for the provider turn that still owns the session", async () => {
    const source = { turnId: TURN_ID, bindingKey: "new-live-binding", policyEpoch: 2 };
    const sourceCommand: OrchestrationCommand = {
      type: "thread.usage-limit.source",
      commandId: CommandId.makeUnsafe("freeze-live-source"),
      threadId: THREAD_ID,
      source,
      createdAt: NOW,
    };
    const running = readModel({
      usageLimitRecoverySource: null,
      latestTurn: { ...readModel().threads[0]!.latestTurn!, state: "running", completedAt: null },
      session: {
        threadId: THREAD_ID,
        status: "running",
        providerName: "codex",
        providerInstanceId: "codex",
        runtimeMode: "full-access",
        activeTurnId: TURN_ID,
        lastError: null,
        updatedAt: NOW,
      },
    });
    const frozen = await apply(running, sourceCommand);
    expect(frozen.thread.usageLimitRecoverySource).toEqual(source);
    const stale = await apply(
      {
        ...running,
        threads: [
          {
            ...running.threads[0]!,
            session: {
              ...running.threads[0]!.session!,
              activeTurnId: TurnId.makeUnsafe("replacement-live-turn"),
            },
          },
        ],
      },
      sourceCommand,
    );
    expect(stale.thread.usageLimitRecoverySource).toBeNull();
    const historical = await apply(readModel({ usageLimitRecoverySource: null }), sourceCommand);
    expect(historical.thread.usageLimitRecoverySource).toBeNull();
  });

  it("commits terminal failure and its waiting recovery under the same command", async () => {
    const runningSession = {
      threadId: THREAD_ID,
      status: "running" as const,
      providerName: "codex",
      providerInstanceId: "codex",
      runtimeMode: "full-access" as const,
      activeTurnId: TURN_ID,
      lastError: null,
      updatedAt: START,
    };
    const commandId = CommandId.makeUnsafe("atomic-limit-terminal");
    const result = await apply(
      readModel({
        latestTurn: { ...readModel().threads[0]!.latestTurn!, state: "running", completedAt: null },
        session: runningSession,
      }),
      {
        type: "thread.session.set",
        commandId,
        threadId: THREAD_ID,
        createdAt: NOW,
        session: {
          ...runningSession,
          status: "error",
          activeTurnId: null,
          lastError: "Usage limit reached",
          updatedAt: NOW,
        },
        usageLimitRecovery: recovery(),
      },
    );
    expect(result.events.map((event) => event.type)).toEqual([
      "thread.session-set",
      "thread.meta-updated",
    ]);
    expect(result.events.every((event) => event.commandId === commandId)).toBe(true);
    expect(result.thread.session?.status).toBe("error");
    expect(result.thread.latestTurn?.state).toBe("error");
    expect(result.thread.usageLimitRecovery).toMatchObject({
      id: "limit-episode",
      state: "waiting",
    });
    expect(result.thread.messages).toHaveLength(0);
  });

  it("a Stop committed before terminal failure prevents that turn arming later", async () => {
    const stopped = await apply(readModel(), {
      type: "thread.turn.interrupt",
      commandId: CommandId.makeUnsafe("stop-before-limit"),
      threadId: THREAD_ID,
      requestedBy: "user",
      createdAt: NOW,
    });
    expect(stopped.thread.usageLimitRecoveryCancelledTurnId).toBe(TURN_ID);
    const late = await apply(stopped.model, schedule());
    expect(late.thread.usageLimitRecovery ?? null).toBeNull();
    expect(continuations(late.events)).toHaveLength(0);
    const nextTurn = TurnId.makeUnsafe("later-deliberate-turn");
    const subsequent = await apply(
      {
        ...late.model,
        threads: [
          {
            ...late.thread,
            latestTurn: { ...late.thread.latestTurn!, turnId: nextTurn },
            usageLimitRecoverySource: {
              turnId: nextTurn,
              bindingKey: "opaque-account-binding",
              policyEpoch: 0,
            },
          },
        ],
      },
      schedule(recovery({ id: "later-limit", turnId: nextTurn })),
    );
    expect(subsequent.thread.usageLimitRecovery?.id).toBe("later-limit");
  });

  it("a Stop during startup leaves a tombstone before any provider turn id exists", async () => {
    const stopped = await apply(readModel({ latestTurn: null, session: null }), {
      type: "thread.session.stop",
      commandId: CommandId.makeUnsafe("stop-startup"),
      threadId: THREAD_ID,
      createdAt: NOW,
    });
    const result = await apply(
      {
        ...stopped.model,
        threads: [{ ...stopped.thread, latestTurn: readModel().threads[0]!.latestTurn }],
      },
      schedule(),
    );
    expect(result.thread.usageLimitRecovery ?? null).toBeNull();
  });

  it("stale cancellation and stale recovery-specific Stop preserve a replacement wait", async () => {
    const replacement = recovery({ id: "replacement" });
    const initial = readModel({ usageLimitRecovery: replacement });
    for (const command of [
      {
        type: "thread.usage-limit.cancel",
        commandId: CommandId.makeUnsafe("stale-cancel"),
        threadId: THREAD_ID,
        recoveryId: "old-episode",
        createdAt: NOW,
      },
      {
        type: "thread.turn.interrupt",
        commandId: CommandId.makeUnsafe("stale-wait-stop"),
        threadId: THREAD_ID,
        usageLimitRecoveryId: "old-episode",
        requestedBy: "user",
        createdAt: NOW,
      },
    ] as const) {
      const result = await apply(initial, command);
      expect(result.thread.usageLimitRecovery).toEqual(replacement);
      expect(result.events.some((event) => event.type === "thread.turn-interrupt-requested")).toBe(
        false,
      );
    }
  });

  it.each([
    [
      "manual message",
      {
        type: "thread.turn.start",
        message: {
          messageId: MessageId.makeUnsafe("manual-message"),
          role: "user",
          text: "Continue differently",
          attachments: [],
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        dispatchMode: "queue",
        createdAt: NOW,
      },
    ],
    [
      "account route",
      {
        type: "thread.meta.update",
        modelSelection: { provider: "codex", instanceId: "codex-other", model: "gpt-5-codex" },
      },
    ],
    [
      "model",
      { type: "thread.meta.update", modelSelection: { provider: "codex", model: "gpt-5.4" } },
    ],
    ["goal edit", { type: "thread.meta.update", goal: "A deliberate replacement objective" }],
    ["pause", { type: "thread.meta.update", goalPaused: true }],
    ["archive", { type: "thread.archive" }],
    ["delete", { type: "thread.delete" }],
  ] as const)("%s invalidates the wait before its other effects", async (_label, patch) => {
    const result = await apply(readModel({ usageLimitRecovery: recovery() }), {
      ...patch,
      commandId: CommandId.makeUnsafe("deliberate-user-change"),
      threadId: THREAD_ID,
    } as OrchestrationCommand);
    expect(result.thread.usageLimitRecovery).toBeNull();
    expect(result.events[0]).toMatchObject({
      type: "thread.meta-updated",
      payload: { usageLimitRecovery: null },
    });
    expect(continuations(result.events)).toHaveLength(0);
  });

  it("admits one due continuation and retains its episode without replaying the failed prompt", async () => {
    const initial = readModel({ usageLimitRecovery: recovery() });
    await expect(decide(initial, resume())).rejects.toThrow("not ready");
    vi.setSystemTime(RESET);
    const result = await apply(initial, resume());
    expect(continuations(result.events)).toHaveLength(1);
    expect(continuations(result.events)[0]).toMatchObject({
      payload: {
        trigger: "turn-completed",
        sourceTurnId: TURN_ID,
        usageLimitRecovery: { id: "limit-episode", state: "resuming" },
      },
    });
    expect(result.thread.usageLimitRecovery).toMatchObject({ state: "resuming" });
    expect(result.thread.usageLimitRecoveryLastResetAt).toBe(RESET);
    expect(result.thread.messages).toHaveLength(0);
    const duplicate = await apply(result.model, {
      ...resume(),
      commandId: CommandId.makeUnsafe("different-delivery-id"),
    });
    expect(continuations(duplicate.events)).toHaveLength(0);
  });

  it("a stale wait id cannot consume the current wait, and an old policy epoch cannot resume", async () => {
    vi.setSystemTime(RESET);
    const initial = readModel({ usageLimitRecovery: recovery() });
    const stale = await apply(initial, resume(recovery({ id: "stale" })));
    expect(stale.thread.usageLimitRecovery?.id).toBe("limit-episode");
    const changedPolicy = await apply(initial, resume(recovery(), 1));
    expect(changedPolicy.thread.usageLimitRecovery).toBeNull();
    expect(continuations(changedPolicy.events)).toHaveLength(0);
  });

  it.each(["hasPendingApprovals", "hasPendingUserInput"] as const)(
    "%s blocks admission without consuming the wait and can be retried after settlement",
    async (key) => {
      vi.setSystemTime(RESET);
      const initial = readModel({ usageLimitRecovery: recovery(), [key]: true });
      await expect(decide(initial, resume())).rejects.toThrow("not ready");
      expect(initial.threads[0]?.usageLimitRecovery?.id).toBe("limit-episode");
      const result = await apply(
        { ...initial, threads: [{ ...initial.threads[0]!, [key]: false }] },
        resume(),
      );
      expect(continuations(result.events)).toHaveLength(1);
    },
  );

  it("a route changed outside the original wait is revalidated at due admission", async () => {
    vi.setSystemTime(RESET);
    const result = await apply(
      readModel({
        usageLimitRecovery: recovery(),
        modelSelection: { provider: "codex", instanceId: "other-account", model: "gpt-5-codex" },
      }),
      resume(),
    );
    expect(result.thread.usageLimitRecovery).toBeNull();
    expect(continuations(result.events)).toHaveLength(0);
  });

  it("resumes only the goal pause it owns and excludes the waiting span from pursuit time", async () => {
    const armed = await apply(
      readModel({ goal: "Finish the complete task", goalStartedAt: START, goalPausedAt: null }),
      schedule(),
    );
    expect(armed.thread.goalPausedAt).toBe(NOW);
    expect(armed.thread.usageLimitRecovery).toMatchObject({
      goalStartedAt: START,
      goalPausedAt: NOW,
    });
    vi.setSystemTime(RESET);
    const result = await apply(armed.model, resume());
    expect(result.thread.goalPausedAt).toBeNull();
    expect(result.thread.goalStartedAt).toBe(NOW);
    expect(continuations(result.events)).toHaveLength(1);
    const manualPause = "2026-10-31T10:30:00.000Z";
    const changed = await apply(
      { ...armed.model, threads: [{ ...armed.thread, goalPausedAt: manualPause }] },
      resume(),
    );
    expect(changed.thread.usageLimitRecovery).toBeNull();
    expect(changed.thread.goalPausedAt).toBe(manualPause);
    expect(continuations(changed.events)).toHaveLength(0);
  });

  it("does not arm a goal that was already paused deliberately", async () => {
    const result = await apply(
      readModel({ goal: "Keep paused", goalStartedAt: START, goalPausedAt: START }),
      schedule(),
    );
    expect(result.thread.usageLimitRecovery).toBeUndefined();
    expect(result.thread.goalPausedAt).toBe(START);
  });

  it.each(["interrupted", "stopped", "error"] as const)(
    "terminal %s settles owned Resuming but preserves an ordinary quota wait",
    async (status) => {
      const resumedTurnId = TurnId.makeUnsafe("resumed-turn");
      const baseSession = {
        threadId: THREAD_ID,
        providerName: "codex" as const,
        runtimeMode: "full-access" as const,
        activeTurnId: resumedTurnId,
        status: "running" as const,
        lastError: null,
        updatedAt: NOW,
      };
      const command = {
        type: "thread.session.set" as const,
        commandId: CommandId.makeUnsafe(`settle-${status}`),
        threadId: THREAD_ID,
        session: { ...baseSession, status, activeTurnId: null },
        createdAt: NOW,
      };
      const stopped = await apply(
        readModel({
          session: baseSession,
          usageLimitRecovery: recovery({ state: "resuming", resumedTurnId }),
        }),
        command,
      );
      expect(stopped.thread.usageLimitRecovery).toBeNull();
      const waiting = await apply(
        readModel({
          session: { ...baseSession, status: "error", activeTurnId: null },
          usageLimitRecovery: recovery(),
        }),
        command,
      );
      expect(waiting.thread.usageLimitRecovery?.id).toBe("limit-episode");
    },
  );

  it("a Stop during unknown turn admission also blocks a later quota refusal of the accepted turn", async () => {
    const actual = TurnId.makeUnsafe("accepted-after-stop");
    const initial = readModel({
      usageLimitRecovery: recovery({ state: "resuming" }),
      goal: "Finish task",
      goalStartedAt: START,
      goalPausedAt: null,
    });
    const stopped = await apply(initial, {
      type: "thread.turn.interrupt",
      commandId: CommandId.makeUnsafe("stop-awaiting-accepted-id"),
      threadId: THREAD_ID,
      usageLimitRecoveryId: "limit-episode",
      requestedBy: "user",
      createdAt: NOW,
    });
    expect(stopped.thread.goalPausedAt).toBe(NOW);
    const blocked = await apply(stopped.model, {
      type: "thread.usage-limit.cancel-turn",
      commandId: CommandId.makeUnsafe("fence-accepted-after-stop"),
      threadId: THREAD_ID,
      recoveryId: "limit-episode",
      sourceTurnId: TURN_ID,
      turnId: actual,
      createdAt: NOW,
    });
    const late = {
      ...blocked.model,
      threads: [
        {
          ...blocked.thread,
          latestTurn: { ...blocked.thread.latestTurn!, turnId: actual },
          usageLimitRecoverySource: {
            turnId: actual,
            bindingKey: recovery().bindingKey,
            policyEpoch: 0,
          },
        },
      ],
    };
    const result = await apply(
      late,
      schedule(recovery({ id: "late-native-refusal", turnId: actual })),
    );
    expect(result.thread.usageLimitRecovery).toBeNull();
    expect(result.thread.usageLimitRecoveryCancelledTurnId).toBe(actual);
  });

  it("recovery-specific Stop during continuation targets only its recorded resumed turn", async () => {
    const resumedTurnId = TurnId.makeUnsafe("resumed-turn");
    const result = await apply(
      readModel({ usageLimitRecovery: recovery({ state: "resuming", resumedTurnId }) }),
      {
        type: "thread.turn.interrupt",
        commandId: CommandId.makeUnsafe("stop-owned-continuation"),
        threadId: THREAD_ID,
        usageLimitRecoveryId: "limit-episode",
        requestedBy: "user",
        createdAt: NOW,
      },
    );
    expect(result.thread.usageLimitRecovery).toBeNull();
    expect(
      result.events.find((event) => event.type === "thread.turn-interrupt-requested"),
    ).toMatchObject({
      payload: { turnId: resumedTurnId, requestedBy: "user" },
    });
  });
});
