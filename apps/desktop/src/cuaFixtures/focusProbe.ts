/**
 * Focus-theft probe: runner-side half of scripts/computer-use-fixtures/
 * focus_probe.m. The binary streams one NDJSON focus sample per tick
 * ({t, pid, app, keyWin, keyTitle, topWin, topTitle, space, focused});
 * this module parses that stream, picks the baseline, and reports every
 * post-baseline deviation so a fixture or cert run can assert "no theft"
 * instead of eyeballing a log.
 *
 * Theft fields are frontmost pid, key window id, top window id and active
 * Space id: the user's frontmost app and key window must not move because of
 * us. The AX focused element changes legitimately when the user tabs inside
 * their own app, so it is reported as `drift` unless strictFocus is set.
 * Null sample fields are observation gaps, not theft.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";

export interface FocusProbeSample {
  /** Milliseconds since the sampler started. */
  t: number;
  /** Frontmost process id (NSWorkspace.frontmostApplication, SLPS fallback). */
  pid: number | null;
  /** Frontmost application's display name. */
  app: string | null;
  /** AX focused window of the frontmost app as a CGWindowID (needs AX trust). */
  keyWin: number | null;
  keyTitle: string | null;
  /** Topmost normal-layer onscreen window owned by the frontmost process. */
  topWin: number | null;
  topTitle: string | null;
  /** SLSGetActiveSpace for the main display (private SkyLight read). */
  space: number | null;
  /** Owner pid of the system-wide AX focused element. Typing focus can move
   * to another process while frontmostApplication still reads the human's
   * app, so this is a first-class theft field, not just drift. */
  focusedPid: number | null;
  /** "pid:role:title" identity of the system-wide AX focused element. */
  focused: string | null;
}

export interface FocusProbeMeta {
  pid: number;
  hz: number;
  axTrusted: boolean;
  axWindowSymbol: boolean;
  slsSpace: boolean;
  stdinWatch: boolean;
  label: string | null;
  startedAt: number;
}

export interface FocusProbeDone {
  samples: number;
  elapsedMs: number;
  overruns: number;
  stoppedBy: string;
}

export type FocusProbeLine =
  | { kind: "meta"; meta: FocusProbeMeta }
  | { kind: "sample"; sample: FocusProbeSample }
  | { kind: "done"; done: FocusProbeDone };

/** Theft-compared fields. A null baseline or null sample value skips the
 * field, so missing grants narrow coverage instead of fabricating theft. */
export const THEFT_FIELDS = ["pid", "keyWin", "topWin", "space", "focusedPid"] as const;
export type TheftField = (typeof THEFT_FIELDS)[number];
export type ComparedField = TheftField | "focused";

export interface FocusProbeExpect {
  /** Pin the baseline instead of deriving it from the settle window. */
  pid?: number;
  keyWin?: number;
  topWin?: number;
  space?: number;
  focusedPid?: number;
  focused?: string;
}

export interface FocusProbeAnalyzeOptions {
  /** Samples with t < settleMs are warm-up: they seed the baseline and are
   * never counted as violations. */
  settleMs?: number | undefined;
  expect?: FocusProbeExpect | undefined;
  /** Count AX-focused-element changes as theft too. Off by default because a
   * user tabbing inside their own app is indistinguishable from an agent one. */
  strictFocus?: boolean | undefined;
  /** Minimum post-settle samples for `ok`. */
  minSamples?: number | undefined;
}

export interface FocusBaseline {
  pid: number | null;
  keyWin: number | null;
  topWin: number | null;
  space: number | null;
  focusedPid: number | null;
  focused: string | null;
}

export interface FocusObservedState {
  pid: number | null;
  app: string | null;
  keyWin: number | null;
  topWin: number | null;
  space: number | null;
  focusedPid: number | null;
  focused: string | null;
}

export interface FocusViolation {
  /** Index of the first offending sample in the full samples array. */
  index: number;
  tMs: number;
  /** Milliseconds between the first and last offending sample. */
  durationMs: number;
  sampleCount: number;
  /** Fields whose value differed from baseline somewhere in the interval. */
  changedFields: ComparedField[];
  /** Distinct observed states, first-seen order, capped at 8. */
  observed: FocusObservedState[];
}

export interface FocusDrift {
  /** Index of the sample whose focused element differed from the previous. */
  index: number;
  tMs: number;
  from: string;
  to: string;
}

export interface FocusProbeReport {
  /** Enough post-baseline coverage to make the theftFree claim meaningful. */
  ok: boolean;
  /** Zero off-baseline samples on theft fields (plus focused when strict). */
  theftFree: boolean;
  baseline: FocusBaseline | null;
  sampleCount: number;
  warmupCount: number;
  measuredMs: number;
  settleMs: number;
  strictFocus: boolean;
  offBaseline: FocusViolation[];
  offBaselineSamples: number;
  drift: FocusDrift[];
  driftSamples: number;
  /** Post-settle samples where a compared field read null (observation gap). */
  uncertainSamples: number;
  /** Non-null fraction per field across all samples. */
  coverage: Record<ComparedField, number>;
  issues: string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const optionalNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const optionalString = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

/** One NDJSON line from focus_probe.m. Returns null for blank/foreign lines
 * so the parser tolerates a shared stdout. */
export function parseFocusProbeLine(line: string): FocusProbeLine | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  if (value.kind === "meta") {
    return {
      kind: "meta",
      meta: {
        pid: optionalNumber(value.pid) ?? -1,
        hz: optionalNumber(value.hz) ?? 0,
        axTrusted: value.axTrusted === true,
        axWindowSymbol: value.axWindowSymbol === true,
        slsSpace: value.slsSpace === true,
        stdinWatch: value.stdinWatch === true,
        label: optionalString(value.label),
        startedAt: optionalNumber(value.startedAt) ?? 0,
      },
    };
  }
  if (value.kind === "done") {
    return {
      kind: "done",
      done: {
        samples: optionalNumber(value.samples) ?? 0,
        elapsedMs: optionalNumber(value.elapsedMs) ?? 0,
        overruns: optionalNumber(value.overruns) ?? 0,
        stoppedBy: optionalString(value.stoppedBy) ?? "unknown",
      },
    };
  }
  if (typeof value.t === "number") {
    return {
      kind: "sample",
      sample: {
        t: value.t,
        pid: optionalNumber(value.pid),
        app: optionalString(value.app),
        keyWin: optionalNumber(value.keyWin),
        keyTitle: optionalString(value.keyTitle),
        topWin: optionalNumber(value.topWin),
        topTitle: optionalString(value.topTitle),
        space: optionalNumber(value.space),
        focusedPid: optionalNumber(value.focusedPid),
        focused: optionalString(value.focused),
      },
    };
  }
  return null;
}

type Field = keyof FocusBaseline;

const COMPARED_FIELDS: Field[] = [...THEFT_FIELDS, "focused"];

/** Modal (most frequent; ties broken by latest index) non-null value per
 * compared field across the baseline-source samples. */
function deriveBaseline(samples: FocusProbeSample[], expect?: FocusProbeExpect): FocusBaseline {
  const baseline: FocusBaseline = {
    pid: null,
    keyWin: null,
    topWin: null,
    space: null,
    focusedPid: null,
    focused: null,
  };
  for (const field of COMPARED_FIELDS) {
    const expected = expect?.[field];
    if (expected !== undefined) {
      baseline[field] = expected as never;
      continue;
    }
    const counts = new Map<string | number, { count: number; lastIndex: number }>();
    samples.forEach((sample, index) => {
      const value = sample[field];
      if (value === null) return;
      const entry = counts.get(value);
      if (entry) {
        entry.count += 1;
        entry.lastIndex = index;
      } else counts.set(value, { count: 1, lastIndex: index });
    });
    let best: string | number | null = null;
    let bestCount = 0;
    let bestLast = -1;
    for (const [value, entry] of counts) {
      if (entry.count > bestCount || (entry.count === bestCount && entry.lastIndex > bestLast)) {
        best = value;
        bestCount = entry.count;
        bestLast = entry.lastIndex;
      }
    }
    baseline[field] = best as never;
  }
  return baseline;
}

const sameObserved = (a: FocusObservedState, b: FocusObservedState): boolean =>
  a.pid === b.pid &&
  a.keyWin === b.keyWin &&
  a.topWin === b.topWin &&
  a.space === b.space &&
  a.focusedPid === b.focusedPid &&
  a.focused === b.focused;

const observedOf = (sample: FocusProbeSample): FocusObservedState => ({
  pid: sample.pid,
  app: sample.app,
  keyWin: sample.keyWin,
  topWin: sample.topWin,
  space: sample.space,
  focusedPid: sample.focusedPid,
  focused: sample.focused,
});

export function analyzeFocusSamples(
  allSamples: FocusProbeSample[],
  options: FocusProbeAnalyzeOptions = {},
): FocusProbeReport {
  const settleMs = options.settleMs ?? 0;
  const strictFocus = options.strictFocus === true;
  const minSamples = options.minSamples ?? 10;
  const issues: string[] = [];

  const warmup = allSamples.filter((sample) => sample.t < settleMs);
  const measured = allSamples.filter((sample) => sample.t >= settleMs);

  // Baseline comes from the warm-up window, or the first sample when there
  // was no settle phase at all.
  const baselineSource = warmup.length > 0 ? warmup : allSamples.slice(0, 1);
  const baseline =
    baselineSource.length > 0 ? deriveBaseline(baselineSource, options.expect) : null;

  const compared: Field[] = strictFocus ? COMPARED_FIELDS : [...THEFT_FIELDS];
  const coverage = { pid: 0, keyWin: 0, topWin: 0, space: 0, focusedPid: 0, focused: 0 };
  for (const field of COMPARED_FIELDS) {
    const present = allSamples.filter((sample) => sample[field] !== null).length;
    coverage[field] = allSamples.length === 0 ? 0 : present / allSamples.length;
  }
  // A field read on a tick divisor (topWin) or routinely absent is "sparse":
  // its nulls are unsampled ticks, not observation gaps. Only reliably-measured
  // fields (>=50% non-null) make a sample uncertain when they drop out.
  const reliable = (field: Field) => coverage[field] >= 0.5;
  if (
    baseline &&
    baseline.keyWin === null &&
    baseline.topWin === null &&
    baseline.focusedPid === null
  )
    issues.push(
      "key/top window and focused element unmeasured (accessibility grant missing or no windows)",
    );
  if (baseline && baseline.space === null) issues.push("active space unmeasured (SkyLight symbol)");
  if (measured.length === 0) issues.push("no post-settle samples");
  if (measured.length < minSamples)
    issues.push(`thin coverage: ${measured.length} post-settle samples (< ${minSamples})`);

  const offBaseline: FocusViolation[] = [];
  const drift: FocusDrift[] = [];
  let offBaselineSamples = 0;
  let uncertainSamples = 0;
  let openViolation: FocusViolation | null = null;
  let previousFocused: string | null | undefined;
  let driftSamples = 0;

  measured.forEach((sample, measuredIndex) => {
    const index = warmup.length + measuredIndex;
    const changed = new Set<ComparedField>();
    let uncertain = false;
    if (baseline) {
      for (const field of compared) {
        const expected = baseline[field];
        const actual = sample[field];
        if (expected === null) continue;
        if (actual === null) {
          if (reliable(field)) uncertain = true;
          continue;
        }
        if (actual !== expected) changed.add(field);
      }
    }

    if (changed.size === 0) {
      openViolation = null;
      if (uncertain) uncertainSamples += 1;
      // Drift is a transition record, not a presence record: one entry per
      // focused-element change while the theft fields hold.
      if (!strictFocus && sample.focused !== null) {
        if (
          previousFocused !== undefined &&
          previousFocused !== null &&
          sample.focused !== previousFocused
        ) {
          drift.push({ index, tMs: sample.t, from: previousFocused, to: sample.focused });
          driftSamples += 1;
        }
        previousFocused = sample.focused;
      }
      return;
    }

    offBaselineSamples += 1;
    const observed = observedOf(sample);
    if (openViolation) {
      openViolation.durationMs = sample.t - openViolation.tMs;
      openViolation.sampleCount += 1;
      for (const field of changed)
        if (!openViolation.changedFields.includes(field)) openViolation.changedFields.push(field);
      if (
        openViolation.observed.length < 8 &&
        !openViolation.observed.some((state) => sameObserved(state, observed))
      )
        openViolation.observed.push(observed);
    } else {
      openViolation = {
        index,
        tMs: sample.t,
        durationMs: 0,
        sampleCount: 1,
        changedFields: [...changed],
        observed: [observed],
      };
      offBaseline.push(openViolation);
    }
  });

  const measuredMs = measured.length > 1 ? measured[measured.length - 1]!.t - measured[0]!.t : 0;

  return {
    ok: baseline !== null && measured.length >= minSamples,
    theftFree: offBaseline.length === 0,
    baseline,
    sampleCount: allSamples.length,
    warmupCount: warmup.length,
    measuredMs,
    settleMs,
    strictFocus,
    offBaseline,
    offBaselineSamples,
    drift,
    driftSamples,
    uncertainSamples,
    coverage,
    issues,
  };
}

export interface FocusProbeSessionOptions {
  binaryPath: string;
  hz?: number | undefined;
  settleMs?: number | undefined;
  expect?: FocusProbeExpect | undefined;
  strictFocus?: boolean | undefined;
  label?: string | undefined;
  minSamples?: number | undefined;
  /** Hard cap for the session; the caller should normally finish it first. */
  maxDurationSeconds?: number | undefined;
}

export interface FocusProbeSession {
  /** Stop sampling and produce the analyzed report. */
  finish: () => Promise<FocusProbeRunResult>;
  /** Live view of samples received so far. */
  samples: FocusProbeSample[];
}

export interface FocusProbeRunResult {
  report: FocusProbeReport;
  meta: FocusProbeMeta | null;
  done: FocusProbeDone | null;
  samples: FocusProbeSample[];
  stderr: string;
  exitCode: number | null;
}

/**
 * Spawn focus-probe in --stdin mode. Returns null (and the fixture records
 * {skipped}) when the binary is absent, so local runs without a built probe
 * keep their existing in-process assertions.
 */
export async function startFocusProbe(
  options: FocusProbeSessionOptions,
): Promise<FocusProbeSession | null> {
  if (!existsSync(options.binaryPath)) return null;
  const args = ["--stdin", "--hz", String(options.hz ?? 50), "--label", options.label ?? "fixture"];
  if (options.maxDurationSeconds) args.push("--duration", String(options.maxDurationSeconds));
  const child: ChildProcessWithoutNullStreams = spawn(options.binaryPath, args, {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const samples: FocusProbeSample[] = [];
  let meta: FocusProbeMeta | null = null;
  let done: FocusProbeDone | null = null;
  let stderr = "";
  let buffer = "";
  const consume = (line: string) => {
    const parsed = parseFocusProbeLine(line);
    if (!parsed) return;
    if (parsed.kind === "meta") meta = parsed.meta;
    else if (parsed.kind === "done") done = parsed.done;
    else samples.push(parsed.sample);
  };
  child.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    for (;;) {
      const end = buffer.indexOf("\n");
      if (end < 0) break;
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      consume(line);
    }
  });
  child.stderr.on("data", (chunk: Buffer) => {
    if (stderr.length < 16_384) stderr += chunk.toString("utf8");
  });
  const exited = new Promise<number | null>((resolve) => {
    child.once("error", () => resolve(null));
    child.once("exit", (code) => resolve(code));
  });
  return {
    samples,
    finish: async () => {
      child.stdin.end();
      const killTimer = setTimeout(() => child.kill("SIGTERM"), 5_000);
      const exitCode = await exited;
      clearTimeout(killTimer);
      if (buffer.trim()) consume(buffer);
      return {
        report: analyzeFocusSamples(samples, {
          settleMs: options.settleMs,
          expect: options.expect,
          strictFocus: options.strictFocus,
          minSamples: options.minSamples,
        }),
        meta,
        done,
        samples,
        stderr,
        exitCode,
      };
    },
  };
}
