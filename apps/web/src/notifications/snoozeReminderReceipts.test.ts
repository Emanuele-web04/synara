import { ThreadId } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { claimSnoozeReminder } from "./snoozeReminderReceipts";

describe("snooze reminder receipts", () => {
  const threadId = ThreadId.makeUnsafe("reminder-thread");

  it("claims an overdue reminder once across notification runtime reloads", () => {
    const records = new Map<string, string>();
    const storage = {
      getItem: (key: string) => records.get(key) ?? null,
      setItem: (key: string, value: string) => {
        records.set(key, value);
      },
    };
    expect(claimSnoozeReminder(threadId, "2026-10-02T10:30:00.000Z", storage)).toBe(true);
    expect(claimSnoozeReminder(threadId, "2026-10-02T10:30:00.000Z", storage)).toBe(false);
    expect(claimSnoozeReminder(threadId, "2026-10-02T11:00:00.000Z", storage)).toBe(true);
    expect(claimSnoozeReminder(threadId, "2026-10-02T11:00:00.000Z", storage)).toBe(false);
    expect(claimSnoozeReminder(threadId, "2026-10-02T10:30:00.000Z", storage)).toBe(false);
  });

  it("keeps reminders for different threads independent", () => {
    const records = new Map<string, string>();
    const storage = {
      getItem: (key: string) => records.get(key) ?? null,
      setItem: (key: string, value: string) => {
        records.set(key, value);
      },
    };
    expect(claimSnoozeReminder(threadId, "2026-10-02T10:30:00.000Z", storage)).toBe(true);
    expect(
      claimSnoozeReminder(ThreadId.makeUnsafe("other-thread"), "2026-10-02T10:30:00.000Z", storage),
    ).toBe(true);
    expect(claimSnoozeReminder(threadId, "2026-10-02T10:30:00.000Z", storage)).toBe(false);
  });

  it("allows delivery when browser storage is blocked", () => {
    const storage = {
      getItem: () => {
        throw new Error("Unavailable");
      },
      setItem: () => {
        throw new Error("Unavailable");
      },
    };
    expect(claimSnoozeReminder(threadId, "2026-10-02T10:30:00.000Z", storage)).toBe(true);
  });
});
