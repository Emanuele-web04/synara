import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ComputerWindowId,
  type ComputerStatusResult,
  type ServerProviderStatus,
} from "@synara/contracts";
import {
  analyzeFocusSamples,
  type FocusProbeRunResult,
  type FocusProbeSample,
} from "../../apps/desktop/src/cuaFixtures/focusProbe.ts";
import { assertLoopbackUrl, waitForSelectedProvider } from "./packaged-client.ts";
import {
  assertPackagedAppInstallation,
  PackagedAppInstallationError,
} from "./packaged-artifact.ts";
import {
  assessContinuousFocus,
  assessFixtureReportCoverage,
  assertPassiveComputerReady,
  fixtureReceiptTiming,
  parseFixtureState,
  resolveFixtureComputerWindow,
  verifyFixtureClick,
} from "./packaged-evidence.ts";

const expected = { pid: 10, keyWin: 20, focusedPid: 10 };
const interval = { startEpochMs: 1_000_000, endEpochMs: 1_001_000 };
function run(): FocusProbeRunResult {
  const samples: FocusProbeSample[] = Array.from({ length: 51 }, (_, index) => ({
    t: index * 20,
    pid: 10,
    app: "private-app",
    keyWin: 20,
    keyTitle: "private-title",
    topWin: index % 5 === 0 ? 20 : null,
    topTitle: null,
    space: 1,
    focusedPid: 10,
    focused: "private-focused-text",
  }));
  return {
    samples,
    report: analyzeFocusSamples(samples),
    meta: {
      pid: 2,
      hz: 50,
      axTrusted: true,
      axWindowSymbol: true,
      slsSpace: true,
      stdinWatch: true,
      label: null,
      startedAt: 1000,
    },
    done: { samples: samples.length, elapsedMs: 1000, overruns: 0, stoppedBy: "stdin" },
    exitCode: 0,
    stderr: "",
  };
}

describe("packaged fixture evidence", () => {
  it.each(["/private/tmp", "/var/folders"])(
    "refuses an app under temporary root %s even if registration resolves to it",
    (root) => {
      const bundle = `${root}/isolated/Synara Cua.app`;
      expect(() => assertPackagedAppInstallation(bundle, bundle)).toThrow(
        "selected Cua app is in temporary storage",
      );
    },
  );

  it("requires LaunchServices to resolve the exact installed copy and gives actionable setup guidance", () => {
    const bundle = "/Users/operator/Applications/Synara Cua.app";
    for (const registered of [null, "/Applications/Synara Cua.app"]) {
      expect(() => assertPackagedAppInstallation(bundle, registered)).toThrow(
        PackagedAppInstallationError,
      );
      expect(() => assertPackagedAppInstallation(bundle, registered)).toThrow(
        '--bundle "$HOME/Applications/Synara Cua.app" and a new isolated --home',
      );
    }
    expect(() => assertPackagedAppInstallation(bundle, bundle)).not.toThrow();
  });

  it("does not mistake a stable directory sharing a temporary root prefix for temporary storage", () => {
    const bundle = "/tmp-fixtures/Synara Cua.app";
    expect(() => assertPackagedAppInstallation(bundle, bundle)).not.toThrow();
  });

  it("requires every expected completed trial, including recovery, instead of passing empty or partial coverage", () => {
    const passed = { kind: "click" as const, taskPassed: true, measurement: { valid: true } };
    expect(assessFixtureReportCoverage([], 3)).toMatchObject({
      taskRunsPassed: false,
      measurementsValid: false,
      observedCompletedRuns: 0,
    });
    expect(assessFixtureReportCoverage([passed, passed], 3).taskRunsPassed).toBe(false);
    expect(assessFixtureReportCoverage([passed, passed, passed], 3)).toMatchObject({
      taskRunsPassed: true,
      measurementsValid: true,
    });
    expect(
      assessFixtureReportCoverage([passed, { ...passed, taskPassed: false, measurement: null }], 2),
    ).toMatchObject({ taskRunsPassed: false, measurementsValid: false });
  });

  it("binds only the returned opaque ID and observed app name for the exact fixture PID and native window", () => {
    const fixture = {
      pid: 10,
      windowId: 20,
      title: "Synara Native Fixture 10 A",
      label: "A" as const,
      clicks: 0,
      edits: 0,
      text: "fixture",
    };
    const window = {
      id: ComputerWindowId.makeUnsafe("cua:10:20"),
      pid: 10,
      title: fixture.title,
      appName: "Native Fixture Host",
      focused: false,
      minimized: false,
      visible: true,
    };
    expect(resolveFixtureComputerWindow([window], fixture)).toEqual(window);
    for (const candidates of [
      [],
      [window, window],
      [{ ...window, pid: 11 }],
      [{ ...window, id: ComputerWindowId.makeUnsafe("cua:10:21") }],
      [{ ...window, id: ComputerWindowId.makeUnsafe("20") }],
      [{ ...window, title: "A different window" }],
      [{ ...window, appName: "" }],
      [{ ...window, visible: false }],
    ]) {
      expect(() => resolveFixtureComputerWindow(candidates, fixture)).toThrow(
        "not uniquely available",
      );
    }
  });

  it("accepts an available fresh host with an intentionally idle listener, while refusing blocked passive probes", () => {
    const status: Pick<ComputerStatusResult, "availability" | "health"> = {
      availability: { kind: "available", backend: "cua" },
      health: {
        status: "unavailable",
        consecutiveFailures: 0,
        reconnects: 0,
        captureAvailable: false,
      },
    };
    expect(() => assertPassiveComputerReady(status)).not.toThrow();
    expect(() =>
      assertPassiveComputerReady({
        ...status,
        availability: { kind: "backend-unavailable", message: "Host missing" },
      }),
    ).toThrow();
    expect(() =>
      assertPassiveComputerReady({
        ...status,
        availability: {
          kind: "permission-required",
          buildSignature: "unknown",
          missing: ["accessibility"],
          message: "Grant required",
        },
      }),
    ).toThrow();
  });
  it("reports monotonic receipt intervals without presenting them as input timestamps", () => {
    expect(
      fixtureReceiptTiming({
        dispatchStartedMs: 1000,
        beforeClicks: 2,
        changes: [
          { clicks: 2, receivedAtMs: 950 },
          { clicks: 3, receivedAtMs: 1010 },
          { clicks: 4, receivedAtMs: 1020 },
        ],
        lastObservedMs: 1300,
        stopRequestedMs: 1050,
        terminalObservedMs: 1100,
      }),
    ).toEqual({
      basis: "monotonic-runner-receipt-includes-IPC-and-polling",
      dispatchToFirstCounterChangeReceiptMs: 10,
      dispatchToLastCounterChangeReceiptMs: 20,
      dispatchToFinalCounterObservationMs: 300,
      dispatchToTerminalObservationMs: 100,
      stopRequestToTerminalObservationMs: 50,
    });
    expect(
      fixtureReceiptTiming({
        dispatchStartedMs: 1000,
        beforeClicks: 0,
        changes: [],
        lastObservedMs: null,
        stopRequestedMs: null,
        terminalObservedMs: 1100,
      }),
    ).toMatchObject({
      dispatchToFirstCounterChangeReceiptMs: null,
      dispatchToLastCounterChangeReceiptMs: null,
      stopRequestToTerminalObservationMs: null,
    });
  });

  it("accepts complete 50 Hz coverage with intentional sparse top-window reads", () => {
    const result = assessContinuousFocus(run(), expected, interval);
    expect(result.passed).toBe(true);
    expect(result.samples).toHaveLength(51);
    expect(JSON.stringify(result)).not.toContain("private");
  });

  it("refuses missing native permissions, no samples and observation gaps", () => {
    const missing = run();
    missing.meta!.axTrusted = false;
    missing.samples.forEach((sample) => {
      sample.keyWin = null;
    });
    expect(assessContinuousFocus(missing, expected, interval)).toMatchObject({ passed: false });
    const empty = run();
    empty.samples = [];
    expect(assessContinuousFocus(empty, expected, interval)).toMatchObject({ passed: false });
    const gapped = run();
    gapped.samples = gapped.samples.filter((sample) => sample.t < 100 || sample.t > 600);
    gapped.done!.samples = gapped.samples.length;
    expect(assessContinuousFocus(gapped, expected, interval).issues).toContain(
      "focus-sampling-gap",
    );
  });

  it("fails even one focus or Space change and a prematurely stopped probe", () => {
    const shifted = run();
    shifted.samples[20]!.space = 2;
    expect(assessContinuousFocus(shifted, expected, interval).issues).toContain("focus-changed");
    const incomplete = run();
    incomplete.done!.stoppedBy = "duration";
    expect(assessContinuousFocus(incomplete, expected, interval).issues).toContain(
      "focus-probe-incomplete",
    );
  });

  it("pins the pre-action baseline even when a change precedes the first measured sample", () => {
    const shifted = run();
    shifted.samples.forEach((sample) => {
      sample.space = 2;
      sample.focused = "changed";
    });
    const result = assessContinuousFocus(
      shifted,
      {
        ...expected,
        space: 1,
        focused: "private-focused-text",
        topWin: 20,
      },
      interval,
    );
    expect(result.passed).toBe(false);
    expect(result.issues).toContain("focus-changed");
  });

  it("proves actual exact target state, refusing duplicate clicks and identity changes", () => {
    const state = parseFixtureState({
      event: "state",
      pid: 10,
      windowId: 20,
      label: "A",
      title: "Synara Native Fixture 10 A",
      clicks: 0,
      edits: 0,
      text: "abc",
    });
    expect(state).not.toBeNull();
    expect(verifyFixtureClick(state!, { ...state!, clicks: 1 }).passed).toBe(true);
    expect(verifyFixtureClick(state!, { ...state!, clicks: 2 }).passed).toBe(false);
    expect(verifyFixtureClick(state!, { ...state!, clicks: 1, windowId: 21 }).passed).toBe(false);
    expect(parseFixtureState({ ...state, event: "state", clicks: -1 })).toBeNull();
  });

  it("refuses remote endpoints, credentials in authority and wrong protocols", () => {
    expect(assertLoopbackUrl("ws://127.0.0.1:42000/?token=test", "ws:").port).toBe("42000");
    for (const url of ["ws://example.com/", "ws://user:pass@127.0.0.1/", "http://127.0.0.1/"])
      expect(() => assertLoopbackUrl(url, "ws:")).toThrow();
  });
});

describe("selected provider discovery", () => {
  afterEach(() => vi.useRealTimers());
  const ready: ServerProviderStatus = {
    provider: "codex",
    status: "ready",
    available: true,
    authStatus: "authenticated",
    checkedAt: "2026-09-20T10:00:00.000Z",
  };
  it("waits through an empty fresh cache for the explicit provider", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "performance"] });
    const read = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([ready]);
    const result = waitForSelectedProvider({ provider: "codex", initial: [], read });
    await vi.advanceTimersByTimeAsync(500);
    expect(await result).toEqual(ready);
    expect(read).toHaveBeenCalledTimes(2);
  });
  it("does not retry a known unavailable or unauthenticated provider", async () => {
    const blocked: ServerProviderStatus = {
      ...ready,
      available: false,
      authStatus: "unauthenticated",
      status: "error",
    };
    const read = vi.fn();
    expect(await waitForSelectedProvider({ provider: "codex", initial: [blocked], read })).toEqual(
      blocked,
    );
    expect(read).not.toHaveBeenCalled();
  });
  it("times out without substituting another available provider", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "performance"] });
    const others: ServerProviderStatus[] = [{ ...ready, provider: "pi" }];
    const result = expect(
      waitForSelectedProvider({
        provider: "codex",
        initial: others,
        read: async () => others,
        timeoutMs: 500,
      }),
    ).rejects.toThrow("Requested provider discovery");
    await vi.advanceTimersByTimeAsync(500);
    await result;
  });
});
