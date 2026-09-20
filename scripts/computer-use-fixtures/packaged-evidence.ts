import {
  analyzeFocusSamples,
  type FocusProbeExpect,
  type FocusProbeRunResult,
} from "../../apps/desktop/src/cuaFixtures/focusProbe.ts";
import type { ComputerStatusResult } from "@synara/contracts";

/** A fresh host deliberately leaves its physical-input listener idle. The
 * passive probe must be available; real task/oracle checks prove execution. */
export function assertPassiveComputerReady(
  status: Pick<ComputerStatusResult, "availability" | "health">,
): void {
  if (status.availability.kind !== "available")
    throw new Error("Computer passive availability is not ready.");
}

export interface FixtureState {
  pid: number;
  windowId: number;
  title: string;
  label: "A" | "B";
  clicks: number;
  edits: number;
  text: string;
}

export function parseFixtureState(value: unknown): FixtureState | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (
    row.event !== "state" ||
    !["A", "B"].includes(String(row.label)) ||
    ![row.pid, row.windowId, row.clicks, row.edits].every(
      (number) => typeof number === "number" && Number.isSafeInteger(number) && number >= 0,
    ) ||
    typeof row.text !== "string" ||
    typeof row.title !== "string" ||
    !row.title.startsWith(`Synara Native Fixture ${row.pid} `)
  ) {
    return null;
  }
  return {
    pid: Number(row.pid),
    windowId: Number(row.windowId),
    label: row.label as "A" | "B",
    title: row.title,
    clicks: Number(row.clicks),
    edits: Number(row.edits),
    text: row.text,
  };
}

export function verifyFixtureClick(before: FixtureState, after: FixtureState) {
  return {
    passed:
      before.pid === after.pid &&
      before.windowId === after.windowId &&
      after.clicks === before.clicks + 1 &&
      after.text === before.text &&
      after.edits === before.edits,
    clickDelta: after.clicks - before.clicks,
    textUnchanged: after.text === before.text && after.edits === before.edits,
  };
}

export function fixtureUnchanged(before: FixtureState, after: FixtureState): boolean {
  return (
    before.pid === after.pid &&
    before.windowId === after.windowId &&
    before.clicks === after.clicks &&
    before.edits === after.edits &&
    before.text === after.text
  );
}

/** Receipt clocks include IPC and runner scheduling; terminal observation also
 * includes owner RPC polling. These are upper bounds, not OS input timestamps. */
export function fixtureReceiptTiming(input: {
  dispatchStartedMs: number;
  beforeClicks: number;
  changes: readonly { clicks: number; receivedAtMs: number }[];
  lastObservedMs: number | null;
  stopRequestedMs: number | null;
  terminalObservedMs: number;
}) {
  const changes = input.changes.filter(
    (change) =>
      change.receivedAtMs >= input.dispatchStartedMs && change.clicks > input.beforeClicks,
  );
  const delta = (end: number | null | undefined, start: number) =>
    end !== null && end !== undefined && Number.isFinite(end) && end >= start ? end - start : null;
  return {
    basis: "monotonic-runner-receipt-includes-IPC-and-polling",
    dispatchToFirstCounterChangeReceiptMs: delta(changes[0]?.receivedAtMs, input.dispatchStartedMs),
    dispatchToLastCounterChangeReceiptMs: delta(
      changes.at(-1)?.receivedAtMs,
      input.dispatchStartedMs,
    ),
    dispatchToFinalCounterObservationMs: delta(input.lastObservedMs, input.dispatchStartedMs),
    dispatchToTerminalObservationMs: delta(input.terminalObservedMs, input.dispatchStartedMs),
    stopRequestToTerminalObservationMs:
      input.stopRequestedMs === null
        ? null
        : delta(input.terminalObservedMs, input.stopRequestedMs),
  };
}

/** Required fields and cadence are gates, not warnings. No activity span is
 * excluded and a brief focus change still fails. Titles/text stay in memory. */
export function assessContinuousFocus(
  result: FocusProbeRunResult,
  expected: FocusProbeExpect,
  interval: { startEpochMs: number; endEpochMs: number },
) {
  const issues: string[] = [];
  const startedAt = (result.meta?.startedAt ?? NaN) * 1_000;
  const start = interval.startEpochMs - startedAt;
  const end = interval.endEpochMs - startedAt;
  const samples = result.samples.filter((sample) => sample.t >= start && sample.t <= end);
  if (!result.meta?.axTrusted || !result.meta.axWindowSymbol || !result.meta.slsSpace)
    issues.push("focus-observation-permissions-or-symbols-missing");
  if (
    result.exitCode !== 0 ||
    !result.done ||
    result.done.stoppedBy !== "stdin" ||
    result.done.samples !== result.samples.length
  ) {
    issues.push("focus-probe-incomplete");
  }
  if (!(end > start) || samples.length < 10) issues.push("focus-interval-coverage-missing");
  const dense = ["pid", "keyWin", "space", "focusedPid", "focused"] as const;
  if (samples.some((sample) => dense.some((field) => sample[field] === null)))
    issues.push("focus-required-field-unobserved");
  const maxGap = (times: number[]) =>
    Math.max(...[...times, end].map((time, index) => time - (times[index - 1] ?? start)));
  // At 50 Hz these allow bounded scheduler variation. The top-window read is
  // deliberately every fifth tick; all other focus fields are read each tick.
  const sampleGapMs = maxGap(samples.map((sample) => sample.t));
  const topWindowGapMs = maxGap(
    samples.filter((sample) => sample.topWin !== null).map((sample) => sample.t),
  );
  if (sampleGapMs > 120 || topWindowGapMs > 250) issues.push("focus-sampling-gap");
  const report = analyzeFocusSamples(samples, {
    expect: expected,
    strictFocus: true,
    settleMs: 0,
    minSamples: 10,
  });
  if (!report.ok || !report.baseline) issues.push("focus-baseline-missing");
  if (!report.theftFree) issues.push("focus-changed");
  if (report.baseline?.topWin === null) issues.push("top-window-unobserved");
  return {
    passed: issues.length === 0,
    issues,
    sampleCount: samples.length,
    sampleGapMs,
    topWindowGapMs,
    observedMs: end - start,
    offBaselineSamples: report.offBaselineSamples,
    violations: report.offBaseline.map(({ tMs, durationMs, changedFields, sampleCount }) => ({
      tMs,
      durationMs,
      changedFields,
      sampleCount,
    })),
    // Continuous evidence contains numerical ownership only, never the user's
    // window titles or focused text if they take over during a benchmark.
    samples: samples.map(({ t, pid, keyWin, topWin, space, focusedPid }) => ({
      t,
      pid,
      keyWin,
      topWin,
      space,
      focusedPid,
    })),
  };
}
