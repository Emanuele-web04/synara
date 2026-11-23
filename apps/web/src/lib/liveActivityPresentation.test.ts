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
  it("keeps a running tool call's row free of timing; elapsed stays available", () => {
    const activity = runningActivity({ label: "Settings" });
    const nowMs = Date.parse("2026-07-26T14:02:14.000Z");

    // The row reads like any running tool call; the details panel shows timing.
    expect(formatLiveActivityMeta(activity, nowMs)).toBeNull();
    expect(formatLiveActivityMeta({ ...activity, progress: 0.42 }, nowMs)).toBeNull();
    expect(liveActivityElapsedMs(activity, nowMs)).toBe(134_000);
    expect(activity.label).toBe("Settings");
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
    // The same activity on a plain tool row carries no tail.
    expect(formatLiveActivityMeta(quietSubagent, nowMs)).toBeNull();
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
