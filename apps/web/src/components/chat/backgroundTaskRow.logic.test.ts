import { describe, expect, it } from "vitest";

import {
  describeBackgroundTaskStatus,
  summarizeBackgroundTaskGroup,
} from "./backgroundTaskRow.logic";

const task = (
  status: "running" | "finished" | "failed" | "stopped",
  overrides: { completedAt?: string | null; exitCode?: number | null } = {},
) => ({
  status,
  startedAt: "2026-10-10T00:09:57.000Z",
  completedAt:
    overrides.completedAt !== undefined
      ? overrides.completedAt
      : status === "running"
        ? null
        : "2026-10-10T00:10:17.000Z",
  exitCode: overrides.exitCode ?? null,
});

describe("describeBackgroundTaskStatus", () => {
  it("walks one row through its lifecycle", () => {
    expect(describeBackgroundTaskStatus(task("running"), "2026-10-10T00:10:09.000Z")).toEqual({
      status: "running",
      label: "running",
      elapsed: "12s",
    });
    expect(describeBackgroundTaskStatus(task("finished"), "2026-10-10T00:11:00.000Z")).toEqual({
      status: "finished",
      label: "finished",
      elapsed: "20s",
    });
    expect(
      describeBackgroundTaskStatus(task("failed", { exitCode: 1 }), "2026-10-10T00:11:00.000Z")
        .label,
    ).toBe("failed · exit 1");
    expect(describeBackgroundTaskStatus(task("failed"), "2026-10-10T00:11:00.000Z").label).toBe(
      "failed",
    );
    expect(describeBackgroundTaskStatus(task("stopped"), "2026-10-10T00:11:00.000Z").label).toBe(
      "stopped",
    );
  });
});

describe("summarizeBackgroundTaskGroup", () => {
  it("counts tasks by state in lifecycle order", () => {
    expect(
      summarizeBackgroundTaskGroup([
        { status: "stopped" },
        { status: "finished" },
        { status: "finished" },
        { status: "finished" },
      ]),
    ).toBe("4 background tasks · 3 finished, 1 stopped");
    expect(
      summarizeBackgroundTaskGroup([
        { status: "finished" },
        { status: "running" },
        { status: "failed" },
      ]),
    ).toBe("3 background tasks · 1 running, 1 finished, 1 failed");
  });
});
