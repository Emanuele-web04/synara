import { describe, expect, it } from "vitest";

import {
  buildGroupThreadActivitySeries,
  resolveGroupThreadWorkInterval,
  type GroupThreadActivityThreadView,
} from "./groupThreadActivity.logic";

const NOW = Date.parse("2026-09-24T12:00:00.000Z");
const MIN = 60 * 1000;

function iso(offsetMinutes: number): string {
  return new Date(NOW - offsetMinutes * MIN).toISOString();
}

function thread(
  overrides: Partial<GroupThreadActivityThreadView> = {},
): GroupThreadActivityThreadView {
  return {
    createdAt: iso(120),
    session: null,
    latestTurn: null,
    ...overrides,
  };
}

describe("resolveGroupThreadWorkInterval", () => {
  it("spans a settled turn from start to completion", () => {
    const interval = resolveGroupThreadWorkInterval(
      thread({
        latestTurn: {
          state: "completed",
          requestedAt: iso(30),
          startedAt: iso(29),
          completedAt: iso(20),
        },
      }),
      NOW,
    );
    expect(interval).toEqual({ startMs: NOW - 29 * MIN, endMs: NOW - 20 * MIN });
  });

  it("keeps a running turn open until now", () => {
    const interval = resolveGroupThreadWorkInterval(
      thread({
        session: { status: "running", orchestrationStatus: "running" },
        latestTurn: { state: "running", requestedAt: iso(10), startedAt: iso(10) },
      }),
      NOW,
    );
    expect(interval).toEqual({ startMs: NOW - 10 * MIN, endMs: NOW });
  });

  it("keeps a completed turn open while the session still runs behind it", () => {
    const interval = resolveGroupThreadWorkInterval(
      thread({
        session: { status: "running", orchestrationStatus: "running", createdAt: iso(60) },
        latestTurn: {
          state: "completed",
          requestedAt: iso(30),
          startedAt: iso(30),
          completedAt: iso(25),
        },
      }),
      NOW,
    );
    expect(interval?.endMs).toBe(NOW);
  });

  it("uses the session start when a thread spins up without a turn", () => {
    const interval = resolveGroupThreadWorkInterval(
      thread({
        session: { status: "starting", orchestrationStatus: "starting", createdAt: iso(5) },
      }),
      NOW,
    );
    expect(interval).toEqual({ startMs: NOW - 5 * MIN, endMs: NOW });
  });

  it("counts live tail work without a session as working from the thread's creation", () => {
    const interval = resolveGroupThreadWorkInterval(
      thread({ hasLiveTailWork: true, createdAt: iso(15) }),
      NOW,
    );
    expect(interval).toEqual({ startMs: NOW - 15 * MIN, endMs: NOW });
  });

  it("returns null for an idle thread that never worked", () => {
    expect(
      resolveGroupThreadWorkInterval(
        thread({ session: { status: "ready", orchestrationStatus: "ready" } }),
        NOW,
      ),
    ).toBeNull();
    expect(resolveGroupThreadWorkInterval(thread(), NOW)).toBeNull();
  });
});

describe("buildGroupThreadActivitySeries", () => {
  it("is empty when the group has no threads", () => {
    expect(buildGroupThreadActivitySeries({ threads: [], nowMs: NOW }).points).toEqual([]);
  });

  it("is empty when threads exist but none ever worked", () => {
    const series = buildGroupThreadActivitySeries({
      threads: [thread(), thread({ createdAt: iso(90) })],
      nowMs: NOW,
    });
    expect(series.points).toEqual([]);
    expect(series.currentCount).toBe(0);
    expect(series.peakCount).toBe(0);
  });

  it("counts overlapping workers per bucket with a ~1 hour window", () => {
    const series = buildGroupThreadActivitySeries({
      nowMs: NOW,
      threads: [
        thread({
          latestTurn: { state: "running", requestedAt: iso(30), startedAt: iso(30) },
        }),
        thread({
          latestTurn: {
            state: "completed",
            requestedAt: iso(20),
            startedAt: iso(20),
            completedAt: iso(10),
          },
        }),
        thread({ createdAt: iso(200) }),
      ],
    });
    // ~60 buckets over the last hour (first thread created 200min ago).
    expect(series.points.length).toBeGreaterThanOrEqual(59);
    expect(series.points.length).toBeLessThanOrEqual(61);
    expect(series.currentCount).toBe(1);
    // Overlap window: both worked between -20min and -10min → peak 2.
    expect(series.peakCount).toBe(2);
    // The tail buckets (-30min → now) hold exactly one worker.
    expect(series.points[series.points.length - 1]).toBe(1);
  });

  it("keeps a full one-hour window for a young group: flat, then rising", () => {
    const series = buildGroupThreadActivitySeries({
      nowMs: NOW,
      threads: [
        thread({
          createdAt: iso(5),
          latestTurn: { state: "running", requestedAt: iso(4), startedAt: iso(4) },
        }),
      ],
    });
    expect(series.windowStartMs).toBe(NOW - 60 * MIN);
    expect(series.points.length).toBe(60);
    // The hour before the thread started is flat at zero; the last four
    // buckets carry the running thread.
    expect(series.points.slice(0, 56).every((count) => count === 0)).toBe(true);
    expect(series.points.slice(56).every((count) => count === 1)).toBe(true);
    expect(series.currentCount).toBe(1);
    expect(series.peakCount).toBe(1);
  });

  it("clips work that finished before the window but still charts the flat tail", () => {
    const series = buildGroupThreadActivitySeries({
      nowMs: NOW,
      threads: [
        thread({
          createdAt: iso(500),
          latestTurn: {
            state: "completed",
            requestedAt: iso(400),
            startedAt: iso(400),
            completedAt: iso(380),
          },
        }),
      ],
    });
    expect(series.points.length).toBeGreaterThan(0);
    expect(series.peakCount).toBe(0);
    expect(series.currentCount).toBe(0);
  });
});
