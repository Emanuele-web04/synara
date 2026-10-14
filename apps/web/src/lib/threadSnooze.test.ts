import { ThreadId } from "@synara/contracts";
import { describe, expect, it } from "vitest";
import {
  getFallbackThreadIdAfterSnooze,
  hasUnseenSnoozeReturn,
  resolveThreadStatusPill,
} from "../components/Sidebar.logic";
import { formatSnoozeRemainingTime } from "./relativeTime";
import { parseFutureDateTimeLocalValue, toDateTimeLocalValue } from "./threadSnooze";

describe("snooze remaining time", () => {
  const now = Date.parse("2026-10-02T12:00:00Z");
  it.each([
    ["2026-10-02T12:28:00Z", "28 min left"],
    ["2026-10-02T13:28:00Z", "1 hr 28 min left"],
    ["2026-10-04T13:28:00Z", "2 days 1 hr left"],
    ["2026-10-02T12:00:30Z", "Less than a minute left"],
    ["2026-10-02T11:59:59Z", "Returning…"],
  ])("shows the remaining duration for %s", (deadline, expected) => {
    expect(formatSnoozeRemainingTime(deadline, now)).toBe(expected);
  });
});

const make = (id: ThreadId, fields = {}) => ({
  id,
  createdAt: "2026-10-01T12:00:00Z",
  ...fields,
});

describe("focus after snooze", () => {
  const current = ThreadId.makeUnsafe("current");
  const visited = ThreadId.makeUnsafe("visited");
  const recent = ThreadId.makeUnsafe("recent");
  it("prefers the last visited eligible chat over the most recently active chat", () => {
    expect(
      getFallbackThreadIdAfterSnooze({
        snoozedThreadId: current,
        threads: [
          make(current),
          make(visited, { lastVisitedAt: "2026-10-02T11:00:00Z" }),
          make(recent, { latestHumanMessageAt: "2026-10-02T12:00:00Z" }),
        ],
      }),
    ).toBe(visited);
  });
  it("falls back to recent human activity, excluding snoozed and archived chats", () => {
    expect(
      getFallbackThreadIdAfterSnooze({
        snoozedThreadId: current,
        threads: [
          make(current),
          make(visited),
          make(recent, { latestHumanMessageAt: "2026-10-02T12:00:00Z" }),
          make(ThreadId.makeUnsafe("snoozed"), {
            snoozedUntil: "2026-10-03T12:00:00Z",
            lastVisitedAt: "2026-10-02T12:01:00Z",
          }),
          make(ThreadId.makeUnsafe("archived"), {
            archivedAt: "2026-10-02T12:01:00Z",
            lastVisitedAt: "2026-10-02T12:01:00Z",
          }),
        ],
      }),
    ).toBe(recent);
  });
  it("requests a new chat when no eligible alternative remains", () => {
    expect(
      getFallbackThreadIdAfterSnooze({ snoozedThreadId: current, threads: [make(current)] }),
    ).toBeNull();
  });
});

describe("custom snooze time", () => {
  const now = new Date(2026, 9, 2, 12, 0).getTime();
  it("round-trips a local date-time and only accepts future times", () => {
    const value = toDateTimeLocalValue(new Date(2026, 9, 3, 9, 30));
    expect(value).toBe("2026-10-03T09:30");
    expect(parseFutureDateTimeLocalValue(value, now)?.getTime()).toBe(
      new Date(2026, 9, 3, 9, 30).getTime(),
    );
    expect(parseFutureDateTimeLocalValue("2026-10-02T11:59", now)).toBeNull();
    expect(parseFutureDateTimeLocalValue("", now)).toBeNull();
  });
});

describe("returned from snooze", () => {
  const returned = {
    snoozedUntil: null,
    snoozeReminderAt: "2026-10-02T12:00:00Z",
    lastVisitedAt: "2026-10-02T11:00:00Z",
  };
  it("stays unread until opened after the reminder", () => {
    expect(hasUnseenSnoozeReturn(returned)).toBe(true);
    expect(hasUnseenSnoozeReturn({ ...returned, lastVisitedAt: "2026-10-02T12:05:00Z" })).toBe(
      false,
    );
    expect(hasUnseenSnoozeReturn({ ...returned, snoozedUntil: "2026-10-03T09:00:00Z" })).toBe(
      false,
    );
  });
  it("shows a dismissible Reminder status that outranks a plain completion", () => {
    const status = resolveThreadStatusPill({
      thread: {
        ...returned,
        interactionMode: "default",
        latestTurn: null,
        session: null,
        updatedAt: "2026-10-02T12:00:00Z",
      },
      hasPendingApprovals: false,
      hasPendingUserInput: false,
    });
    expect(status?.label).toBe("Reminder");
    expect(
      resolveThreadStatusPill({
        thread: {
          ...returned,
          interactionMode: "default",
          latestTurn: null,
          session: null,
          updatedAt: "2026-10-02T12:00:00Z",
          dismissedStatusKey: status?.dismissalKey,
        },
        hasPendingApprovals: false,
        hasPendingUserInput: false,
      }),
    ).toBeNull();
  });
});
