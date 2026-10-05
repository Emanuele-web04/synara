import { createHistogram } from "node:perf_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeEventLoopMonitor, startEventLoopMonitor } from "./eventLoopMonitor";

const monitors: ReturnType<typeof makeEventLoopMonitor>[] = [];
function makeMonitor(input: Parameters<typeof makeEventLoopMonitor>[0]) {
  const monitor = makeEventLoopMonitor(input);
  monitors.push(monitor);
  return monitor;
}

function fixture() {
  let now = 0;
  const histogram = Object.assign(createHistogram(), { enable: () => true, disable: vi.fn() });
  const summaryHistogram = Object.assign(createHistogram(), {
    enable: () => true,
    disable: vi.fn(),
  });
  const warn = vi.fn();
  const info = vi.fn();
  const monitor = makeMonitor({
    histogram,
    summaryHistogram,
    now: () => now,
    logger: { warn, info },
    readLoop: () => ({ activeMs: 1_000_000, utilization: 0.9 }),
  });
  monitor.sample(); // Discard startup, as the production service does.
  return {
    monitor,
    histogram,
    warn,
    info,
    sample(ms: number, elapsed = 1000) {
      now += elapsed;
      histogram.record(Math.round((ms + 20) * 1e6));
      summaryHistogram.record(Math.round((ms + 20) * 1e6));
      monitor.sample();
    },
  };
}

afterEach(() => {
  for (const monitor of monitors.splice(0)) monitor.stop();
  vi.useRealTimers();
});

describe("event loop monitor", () => {
  it("warns at two seconds and retains finite summary stats", () => {
    const f = fixture();
    f.monitor.sample();
    expect(f.monitor.getSnapshot()).toMatchObject({
      available: true,
      sampleCount: 0,
      delayMaxMs: 0,
    });
    f.sample(1999);
    expect(f.warn).not.toHaveBeenCalled();
    f.sample(2000);
    expect(f.warn).toHaveBeenCalledOnce();
    expect(f.warn.mock.calls[0]?.[1]).toMatchObject({
      stallDurationMs: expect.any(Number),
      utilization: expect.any(Number),
      loadAverage: expect.any(Array),
    });
    expect(f.monitor.getSnapshot()).toMatchObject({
      stallWindowCount: 1,
      lastStall: { ageMs: 0, durationMs: expect.any(Number) },
    });
  });

  it("rate limits warnings while retaining suppressed windows and their worst delay", () => {
    const f = fixture();
    f.sample(2100);
    f.sample(5000);
    f.sample(3100);
    expect(f.warn).toHaveBeenCalledOnce();
    expect(f.monitor.getSnapshot().stallWindowCount).toBe(3);
    f.sample(2100, 30_000);
    expect(f.warn).toHaveBeenCalledTimes(2);
    expect(f.warn.mock.calls[1]?.[1]).toMatchObject({
      suppressedStallWindows: 2,
      suppressedMaxMs: expect.any(Number),
    });
    expect(f.warn.mock.calls[1]?.[1].suppressedMaxMs).toBeGreaterThanOrEqual(5000);
  });

  it("detects delayed sampling even before the native histogram records recovery", () => {
    const f = fixture();
    f.sample(20, 61_000);
    expect(f.monitor.getSnapshot().lastStall?.durationMs).toBe(60_000);
    expect(f.warn).toHaveBeenCalledOnce();
  });

  it("publishes thirty-second summaries and preserves the completed window", () => {
    const f = fixture();
    for (let i = 0; i < 30; i++) f.sample(i === 12 ? 2500 : 20);
    expect(f.info).toHaveBeenCalledOnce();
    expect(f.monitor.getSnapshot()).toMatchObject({ sampleCount: 30, sampleWindowMs: 30_000 });
    expect(f.monitor.getSnapshot().delayMaxMs).toBeGreaterThanOrEqual(2500);
    f.sample(20);
    expect(f.monitor.getSnapshot().lastStall?.ageMs).toBe(18_000);
  });

  it("stops timers and disables the native histogram on cleanup", () => {
    vi.useFakeTimers();
    const f = fixture();
    const stop = startEventLoopMonitor(f.monitor);
    expect(vi.getTimerCount()).toBe(1);
    stop();
    stop();
    expect(vi.getTimerCount()).toBe(0);
    expect(f.histogram.disable).toHaveBeenCalledOnce();
  });
});

it("does not report system sleep as a stall", () => {
  let now = 0;
  const histogram = Object.assign(createHistogram(), { enable: () => true, disable: () => true });
  const warn = vi.fn();
  const monitor = makeMonitor({
    histogram,
    now: () => now,
    readLoop: () => ({ activeMs: 10, utilization: 0.001 }),
    logger: { warn, info: vi.fn() },
  });
  monitor.sample();
  now = 61_000;
  histogram.record(60_020_000_000);
  monitor.sample();
  expect(monitor.getSnapshot()).toMatchObject({ stallWindowCount: 0, lastStall: null });
  expect(warn).not.toHaveBeenCalled();
});

it("disables an enabled histogram if summary monitoring cannot start", () => {
  const histogram = Object.assign(createHistogram(), { enable: () => true, disable: vi.fn() });
  const summaryHistogram = Object.assign(createHistogram(), {
    enable: () => {
      throw new Error("unsupported runtime");
    },
    disable: vi.fn(),
  });
  expect(() => makeEventLoopMonitor({ histogram, summaryHistogram })).toThrow(
    "unsupported runtime",
  );
  expect(histogram.disable).toHaveBeenCalledOnce();
});

it("discards startup work before counting runtime stalls", () => {
  let now = 0;
  const histogram = Object.assign(createHistogram(), { enable: () => true, disable: () => true });
  const warn = vi.fn();
  const monitor = makeMonitor({
    histogram,
    now: () => now,
    readLoop: () => ({ activeMs: 10000, utilization: 1 }),
    logger: { warn, info: vi.fn() },
  });
  now = 10000;
  histogram.record(10_020_000_000);
  monitor.sample();
  expect(monitor.getSnapshot().stallWindowCount).toBe(0);
  expect(warn).not.toHaveBeenCalled();
});

it("records a real native stall across a sampling boundary", async () => {
  const warn = vi.fn();
  const monitor = makeMonitor({ logger: { warn, info: vi.fn() } });
  const stop = startEventLoopMonitor(monitor);
  try {
    await new Promise((resolve) => setTimeout(resolve, 1150));
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2100);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(monitor.getSnapshot().stallWindowCount).toBeGreaterThanOrEqual(1);
    expect(monitor.getSnapshot().lastStall?.durationMs).toBeGreaterThanOrEqual(2000);
  } finally {
    stop();
  }
}, 10000);

it("does not discard a long active stall due to native histogram quantization", () => {
  let now = 0;
  const histogram = Object.assign(createHistogram(), { enable: () => true, disable: () => true });
  const monitor = makeMonitor({
    histogram,
    summaryHistogram: Object.assign(createHistogram(), { enable: () => true, disable: () => true }),
    now: () => now,
    readLoop: () => ({ activeMs: 40011, utilization: 0.98 }),
    logger: { warn: vi.fn(), info: vi.fn() },
  });
  monitor.sample();
  now = 41011;
  histogram.record(40_031_000_000);
  monitor.sample();
  expect(monitor.getSnapshot().lastStall?.durationMs).toBeGreaterThanOrEqual(40011);
});

it("handles delayed native sampling without counting the same stall twice", () => {
  let now = 0;
  let activeMs = 0;
  const histogram = Object.assign(createHistogram(), { enable: () => true, disable: () => true });
  const monitor = makeMonitor({
    histogram,
    summaryHistogram: Object.assign(createHistogram(), { enable: () => true, disable: () => true }),
    now: () => now,
    readLoop: () => ({ activeMs, utilization: 0.9 }),
    logger: { warn: vi.fn(), info: vi.fn() },
  });
  monitor.sample();
  now = 2300;
  activeMs = 2200;
  monitor.sample();
  now = 3300;
  activeMs = 10;
  histogram.record(2_220_000_000);
  monitor.sample();
  expect(monitor.getSnapshot().stallWindowCount).toBe(1);
  expect(monitor.getSnapshot().lastStall?.durationMs).toBeGreaterThanOrEqual(2000);
  now = 6500;
  activeMs = 3100;
  monitor.sample();
  now = 7500;
  activeMs = 10;
  histogram.record(3_120_000_000);
  monitor.sample();
  expect(monitor.getSnapshot().stallWindowCount).toBe(2);
});
