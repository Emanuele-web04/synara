import { ThreadId } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { applyOrchestrationEvents, syncServerReadModel, syncServerShellSnapshot } from "./store";
import { mergeReadModelThreadDetailWithLiveHotPath } from "./storeNormalization";
import { createSidebarTreeThreadsSelector, isSidebarThreadVisible } from "./storeSelectors";
import {
  makeDomainEvent,
  makeReadModel,
  makeReadModelThread,
  makeState,
  makeThread,
  threadsOf,
} from "./storeTestFixtures";

const deadline = "2026-10-02T10:30:00.000Z";
const reminderAt = "2026-10-02T10:30:01.000Z";

describe("durable thread snooze in the client store", () => {
  it("hides pinned subagents with their snoozed parent", () => {
    const parent = makeThread({ snoozedUntil: deadline });
    const initial = syncServerReadModel(makeState(parent), {
      ...makeReadModel(makeReadModelThread({ snoozedUntil: deadline })),
      threads: [
        makeReadModelThread({ snoozedUntil: deadline }),
        makeReadModelThread({
          id: ThreadId.makeUnsafe("pinned-child"),
          parentThreadId: parent.id,
          isPinned: true,
        }),
      ],
    });
    expect(createSidebarTreeThreadsSelector()(initial)).toEqual([]);
    expect(createSidebarTreeThreadsSelector({ includeSnoozed: true })(initial)).toHaveLength(2);
  });
  it.each(["detail", "shell"] as const)("preserves snooze through %s snapshots", (kind) => {
    const snapshot = makeReadModel(
      makeReadModelThread({ snoozedUntil: deadline, snoozeReminderAt: null }),
    );
    const state = makeState(makeThread());
    const next =
      kind === "detail"
        ? syncServerReadModel(state, snapshot)
        : syncServerShellSnapshot(state, snapshot);
    expect(threadsOf(next)[0]?.snoozedUntil).toBe(deadline);
    expect(next.sidebarThreadSummaryById["thread-1"]?.snoozedUntil).toBe(deadline);
    expect(createSidebarTreeThreadsSelector()(next)).toEqual([]);
    expect(createSidebarTreeThreadsSelector({ includeSnoozed: true })(next)).toHaveLength(1);
  });

  it("hides a pinned thread after scheduling and restores it when the reminder fires", () => {
    const initial = makeState(makeThread({ isPinned: true }));
    const threadId = threadsOf(initial)[0]!.id;
    const snoozed = applyOrchestrationEvents(initial, [
      makeDomainEvent("thread.meta-updated", {
        threadId,
        snoozedUntil: deadline,
        snoozeReminderAt: null,
        updatedAt: "2026-10-02T10:00:00.000Z",
      }),
    ]);
    expect(isSidebarThreadVisible(snoozed.sidebarThreadSummaryById[threadId]!)).toBe(false);
    expect(threadsOf(snoozed)[0]?.snoozedUntil).toBe(deadline);

    const renamed = applyOrchestrationEvents(snoozed, [
      makeDomainEvent(
        "thread.meta-updated",
        { threadId, title: "Later", updatedAt: deadline },
        {
          sequence: 2,
        },
      ),
    ]);
    expect(threadsOf(renamed)[0]?.snoozedUntil).toBe(deadline);

    const restored = applyOrchestrationEvents(renamed, [
      makeDomainEvent(
        "thread.meta-updated",
        {
          threadId,
          snoozedUntil: null,
          snoozeReminderAt: reminderAt,
          settledAt: null,
          updatedAt: reminderAt,
        },
        { sequence: 3 },
      ),
    ]);
    expect(threadsOf(restored)[0]?.snoozedUntil).toBeNull();
    expect(threadsOf(restored)[0]?.snoozeReminderAt).toBe(reminderAt);
    expect(restored.sidebarThreadSummaryById[threadId]?.snoozeReminderAt).toBe(reminderAt);
    expect(createSidebarTreeThreadsSelector()(restored)).toHaveLength(1);
  });

  it("does not let older detail hydration erase a newer snooze", () => {
    const previous = makeThread({
      snoozedUntil: deadline,
      snoozeReminderAt: null,
      updatedAt: "2026-10-02T10:00:01.000Z",
    });
    const stale = makeReadModelThread({
      snoozedUntil: null,
      snoozeReminderAt: reminderAt,
      updatedAt: "2026-10-02T10:00:00.000Z",
    });
    const merged = mergeReadModelThreadDetailWithLiveHotPath(stale, previous);
    expect(merged.snoozedUntil).toBe(deadline);
    expect(merged.snoozeReminderAt).toBeNull();
  });

  it("preserves a newer snooze event when an older snapshot shares its timestamp", () => {
    const previous = makeThread({
      snoozedUntil: deadline,
      snoozeReminderAt: null,
      snoozeSequence: 10,
    });
    const stale = makeReadModelThread({ snoozedUntil: null, snoozeReminderAt: reminderAt });
    const merged = mergeReadModelThreadDetailWithLiveHotPath(stale, previous, 9);
    expect(merged.snoozedUntil).toBe(deadline);
    expect(merged.snoozeReminderAt).toBeNull();
    const current = mergeReadModelThreadDetailWithLiveHotPath(stale, previous, 11);
    expect(current.snoozedUntil).toBeNull();
    expect(current.snoozeReminderAt).toBe(reminderAt);
  });
});
