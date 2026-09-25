import { describe, expect, it } from "vitest";

import type { WorkLogLiveActivity } from "../workLog";
import { formatLiveActivityMeta, liveActivityElapsedMs } from "./liveActivityPresentation";

const STARTED_AT = "2026-07-26T14:00:00.000Z";

function runningActivity(overrides: Partial<WorkLogLiveActivity> = {}): WorkLogLiveActivity {
  return {
    state: "running_tool",
    label: "Bash",
    startedAt: STARTED_AT,
    lastActivityAt: "2026-07-26T14:02:11.000Z",
    elapsedSeconds: 131,
    ...overrides,
  };
}

describe("live activity presentation", () => {
  it("freezes elapsed time and labels paused background work", () => {
    const activity = runningActivity({ state: "paused", background: true });
    const nowMs = Date.parse("2026-07-26T14:03:00.000Z");
    expect(liveActivityElapsedMs(activity, nowMs)).toBe(131_000);
    expect(liveActivityElapsedMs(activity, nowMs + 60_000)).toBe(131_000);
    expect(formatLiveActivityMeta(activity, nowMs)).toContain("Paused");
    expect(formatLiveActivityMeta(activity, nowMs)).not.toContain("Running in background");
  });
  it("renders recent activity and elapsed time from one normalized state", () => {
    const activity = runningActivity();
    const nowMs = Date.parse("2026-07-26T14:02:14.000Z");

    expect(liveActivityElapsedMs(activity, nowMs)).toBe(134_000);
    expect(formatLiveActivityMeta(activity, nowMs)).toBe("Active 3s ago · 2m 14s elapsed");
  });

  it("describes detached work as running in the background instead of idle", () => {
    const activity: WorkLogLiveActivity = {
      state: "waiting",
      label: "Bash",
      startedAt: STARTED_AT,
      lastActivityAt: STARTED_AT,
      background: true,
    };
    const nowMs = Date.parse("2026-07-26T14:03:00.000Z");

    expect(formatLiveActivityMeta(activity, nowMs)).toBe("Running in background · 3m elapsed");
  });

  it("reports quiet live tools without claiming they are frozen", () => {
    expect(
      formatLiveActivityMeta(
        runningActivity({
          lastActivityAt: "2026-07-26T14:01:44.000Z",
          elapsedSeconds: 104,
        }),
        Date.parse("2026-07-26T14:02:14.000Z"),
      ),
    ).toBe("No activity for 30s · 2m 14s elapsed");
  });

  it("never reports a quiet subagent as idle while it is still running", () => {
    const quietSubagent: WorkLogLiveActivity = {
      state: "running_tool",
      label: "Explore composer model/effort UI",
      startedAt: STARTED_AT,
      lastActivityAt: "2026-07-26T14:00:00.100Z",
    };
    const nowMs = Date.parse("2026-07-26T14:04:55.000Z");

    expect(formatLiveActivityMeta(quietSubagent, nowMs, { subagent: true })).toBe(
      "Subagent working · 4m 55s elapsed",
    );
    // Same activity without the subagent hint keeps the generic idle wording.
    expect(formatLiveActivityMeta(quietSubagent, nowMs)).toBe(
      "No activity for 4m 54s · 4m 55s elapsed",
    );
    // Terminal states are unaffected by the hint.
    expect(
      formatLiveActivityMeta(
        { ...quietSubagent, state: "failed", lastActivityAt: "2026-07-26T14:04:55.000Z" },
        nowMs,
        { subagent: true },
      ),
    ).toBe("Failed · 4m 55s elapsed");
  });

  it("keeps progress and terminal states provider-agnostic", () => {
    const completed = runningActivity({
      state: "completed",
      lastActivityAt: "2026-07-26T14:02:14.000Z",
      elapsedSeconds: 134,
      progress: 1,
    });

    // A tool call that simply succeeded says so with its own verb; no status tail.
    expect(formatLiveActivityMeta(completed, Date.parse("2026-07-26T14:03:00.000Z"))).toBeNull();

    expect(
      formatLiveActivityMeta(
        { ...completed, state: "failed" },
        Date.parse("2026-07-26T14:03:00.000Z"),
      ),
    ).toBe("Failed · 2m 14s elapsed · 100%");
  });

  it("does not invent elapsed time when a terminal event has no known start", () => {
    const activity: WorkLogLiveActivity = {
      state: "completed",
      label: "Deploy",
      lastActivityAt: "2026-07-26T14:02:14.000Z",
    };

    expect(liveActivityElapsedMs(activity, Date.parse("2026-07-26T14:03:00.000Z"))).toBeNull();
    expect(formatLiveActivityMeta(activity, Date.parse("2026-07-26T14:03:00.000Z"))).toBeNull();
  });
});
