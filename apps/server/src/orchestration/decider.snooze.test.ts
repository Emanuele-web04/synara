import {
  CommandId,
  MessageId,
  ProjectId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type OrchestrationThread,
} from "@synara/contracts";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { projectEvent } from "./projector.ts";

const NOW = "2026-10-02T10:00:00.000Z";
const DUE = "2026-10-02T09:30:00.000Z";
const FUTURE = "2026-10-02T11:00:00.000Z";
const THREAD_ID = ThreadId.makeUnsafe("snooze-thread");

function makeReadModel(patch: Partial<OrchestrationThread> = {}): OrchestrationReadModel {
  return {
    snapshotSequence: 1,
    updatedAt: NOW,
    spaces: [],
    projects: [],
    threads: [
      {
        id: THREAD_ID,
        projectId: ProjectId.makeUnsafe("snooze-project"),
        title: "Return to this",
        modelSelection: { provider: "codex", model: "gpt-5-codex" },
        interactionMode: "default",
        runtimeMode: "full-access",
        branch: null,
        worktreePath: null,
        parentThreadId: null,
        sidechatSourceThreadId: null,
        createdAt: NOW,
        updatedAt: NOW,
        latestTurn: null,
        handoff: null,
        messages: [],
        session: null,
        activities: [],
        proposedPlans: [],
        checkpoints: [],
        deletedAt: null,
        ...patch,
      },
    ],
  };
}

const metaCommand = (
  patch: Partial<Extract<OrchestrationCommand, { type: "thread.meta.update" }>>,
): OrchestrationCommand => ({
  type: "thread.meta.update",
  commandId: CommandId.makeUnsafe("snooze-command"),
  threadId: THREAD_ID,
  ...patch,
});

async function apply(readModel: OrchestrationReadModel, command: OrchestrationCommand) {
  const result = await Effect.runPromise(decideOrchestrationCommand({ readModel, command }));
  const events = Array.isArray(result) ? result : [result];
  let next = readModel;
  for (const event of events) {
    next = await Effect.runPromise(
      projectEvent(next, { ...event, sequence: next.snapshotSequence + 1 } as OrchestrationEvent),
    );
  }
  return next.threads[0]!;
}

describe("thread snooze", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it.each([FUTURE, null])(
    "scheduling or cancelling %s clears a previous reminder",
    async (snoozedUntil) => {
      const thread = await apply(
        makeReadModel({ snoozedUntil: DUE, snoozeReminderAt: DUE }),
        metaCommand({ snoozedUntil }),
      );
      expect(thread.snoozedUntil).toBe(snoozedUntil);
      expect(thread.snoozeReminderAt).toBeNull();
    },
  );

  it("expires the matching due deadline and restores a Done thread", async () => {
    const thread = await apply(
      makeReadModel({ snoozedUntil: DUE, settledAt: DUE }),
      metaCommand({ snoozedUntil: null, expectedSnoozedUntil: DUE }),
    );
    expect(thread.snoozedUntil).toBeNull();
    expect(thread.snoozeReminderAt).toBe(NOW);
    expect(thread.settledAt).toBeNull();
  });

  it.each([FUTURE, null])(
    "rejects expiry after rescheduling or cancelling to %s",
    async (snoozedUntil) => {
      await expect(
        apply(
          makeReadModel({ snoozedUntil }),
          metaCommand({ snoozedUntil: null, expectedSnoozedUntil: DUE }),
        ),
      ).rejects.toThrow("snooze deadline changed");
    },
  );

  it("rejects expiry before the authoritative deadline", async () => {
    await expect(
      apply(
        makeReadModel({ snoozedUntil: FUTURE }),
        metaCommand({ snoozedUntil: null, expectedSnoozedUntil: FUTURE }),
      ),
    ).rejects.toThrow("not due");
  });

  it("rejects expiry of an archived thread", async () => {
    await expect(
      apply(
        makeReadModel({ snoozedUntil: DUE, archivedAt: DUE }),
        metaCommand({ snoozedUntil: null, expectedSnoozedUntil: DUE }),
      ),
    ).rejects.toThrow("archived");
  });

  it.each(["thread.archive", "thread.delete"] as const)(
    "%s clears scheduling and reminders",
    async (type) => {
      const thread = await apply(makeReadModel({ snoozedUntil: FUTURE, snoozeReminderAt: DUE }), {
        type,
        commandId: CommandId.makeUnsafe(type),
        threadId: THREAD_ID,
      });
      expect(thread.snoozedUntil).toBeNull();
      expect(thread.snoozeReminderAt).toBeNull();
    },
  );

  it.each(["user", "automation", "agent"] as const)(
    "only human turns cancel scheduling (%s)",
    async (dispatchOrigin) => {
      const thread = await apply(makeReadModel({ snoozedUntil: FUTURE, snoozeReminderAt: DUE }), {
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe(`turn-${dispatchOrigin}`),
        threadId: THREAD_ID,
        dispatchOrigin,
        message: {
          messageId: MessageId.makeUnsafe(`message-${dispatchOrigin}`),
          role: "user",
          text: "Continue",
          attachments: [],
        },
        interactionMode: "default",
        runtimeMode: "full-access",
        createdAt: NOW,
      });
      expect(thread.snoozedUntil).toBe(dispatchOrigin === "user" ? null : FUTURE);
      expect(thread.snoozeReminderAt).toBe(dispatchOrigin === "user" ? null : DUE);
    },
  );
});
