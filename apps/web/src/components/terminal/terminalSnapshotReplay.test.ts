import type { TerminalSessionSnapshot } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  applyReplayOnce,
  createRecoveredGridOutputBuffer,
  RecoveredGridFinalizationError,
  type ReplayIdentityState,
  replaySnapshotAtBackendOpenGrid,
  replaySnapshotAtDestinationGrid,
  replaySnapshotAtRecoveredGrid,
  shouldReplayColdSnapshot,
  snapshotReplayIdentity,
} from "./terminalSnapshotReplay";

function dimensionedSnapshot(
  cols = 80,
  rows = 24,
): TerminalSessionSnapshot & { recoveredCols: number; recoveredRows: number } {
  return {
    threadId: "thread",
    terminalId: "default",
    cwd: "/tmp",
    status: "running",
    pid: 1,
    history: "history",
    recoveredCols: cols,
    recoveredRows: rows,
    historyRecordIdentity: "a".repeat(64),
    exitCode: null,
    exitSignal: null,
    updatedAt: new Date(0).toISOString(),
  };
}

function legacySnapshot(): TerminalSessionSnapshot {
  return {
    threadId: "thread",
    terminalId: "default",
    cwd: "/tmp",
    status: "running",
    pid: 1,
    history: "history",
    exitCode: null,
    exitSignal: null,
    updatedAt: new Date(0).toISOString(),
  };
}

describe("replaySnapshotAtRecoveredGrid", () => {
  it.each([
    [60, 15],
    [120, 40],
    [100, 30],
  ])("barriers clear and replay at a %sx%s source grid", async (cols, rows) => {
    const calls: string[] = [];
    const terminal = {
      cols: 100,
      rows: 30,
      resize(nextCols: number, nextRows: number) {
        this.cols = nextCols;
        this.rows = nextRows;
        calls.push(`resize:${nextCols}x${nextRows}`);
      },
      write(data: string, callback?: () => void) {
        calls.push(`write:${data}`);
        queueMicrotask(() => {
          calls.push("parsed");
          callback?.();
        });
      },
    };

    await replaySnapshotAtRecoveredGrid({
      terminal,
      snapshot: dimensionedSnapshot(cols, rows),
      backendOpenDimensions: { cols: 100, rows: 30 },
      measureFinalGrid: () => {
        calls.push("fit");
        return { cols: 100, rows: 30 };
      },
      resizeBackend: async () => {
        calls.push("backend");
      },
    });

    expect(calls).toEqual([
      "write:\u001b[2J\u001b[H",
      "parsed",
      `resize:${cols}x${rows}`,
      "write:history",
      "parsed",
      "fit",
      ...(cols === 100 && rows === 30 ? [] : ["resize:100x30"]),
    ]);
    expect(calls.join("|")).not.toContain("\u001b[3J");
  });

  it("sends exactly one final backend resize when final differs from open", async () => {
    const resizes: Array<{ cols: number; rows: number }> = [];
    const terminal = {
      cols: 100,
      rows: 30,
      resize(cols: number, rows: number) {
        this.cols = cols;
        this.rows = rows;
      },
      write(_data: string, callback?: () => void) {
        callback?.();
      },
    };

    await replaySnapshotAtRecoveredGrid({
      terminal,
      snapshot: dimensionedSnapshot(),
      backendOpenDimensions: { cols: 100, rows: 30 },
      measureFinalGrid: () => ({ cols: 110, rows: 35 }),
      resizeBackend: async (value) => {
        resizes.push(value);
      },
    });

    expect(resizes).toEqual([{ cols: 110, rows: 35 }]);
  });

  it("aborts after the clear barrier without staging or fitting", async () => {
    const calls: string[] = [];
    const terminal = {
      cols: 100,
      rows: 30,
      resize() {
        calls.push("resize");
      },
      write(_data: string, callback?: () => void) {
        calls.push("write");
        callback?.();
      },
    };

    await expect(
      replaySnapshotAtRecoveredGrid({
        terminal,
        snapshot: dimensionedSnapshot(),
        backendOpenDimensions: { cols: 100, rows: 30 },
        measureFinalGrid: () => {
          calls.push("fit");
          return { cols: 100, rows: 30 };
        },
        resizeBackend: async () => {
          calls.push("backend");
        },
        isActive: () => false,
      }),
    ).rejects.toThrow("aborted");
    expect(calls).toEqual(["write"]);
  });

  it.each(["throws", "is unavailable"])(
    "restores the backend-open grid before live output drains when fit measurement %s",
    async (measurementFailure) => {
      const calls: string[] = [];
      const outputBuffer = createRecoveredGridOutputBuffer();
      let active = true;
      const terminal = {
        cols: 100,
        rows: 30,
        resize(cols: number, rows: number) {
          this.cols = cols;
          this.rows = rows;
          calls.push(`resize:${cols}x${rows}`);
        },
        write(data: string, callback?: () => void) {
          calls.push(`write:${data}@${this.cols}x${this.rows}`);
          if (data === "history") {
            outputBuffer.enqueue({ data: "LIVE-A", byteLength: 6 });
            outputBuffer.enqueue({ data: "LIVE-β", byteLength: 7 });
            active = false;
          }
          callback?.();
        },
      };

      try {
        await expect(
          replaySnapshotAtRecoveredGrid({
            terminal,
            snapshot: dimensionedSnapshot(40, 8),
            backendOpenDimensions: { cols: 100, rows: 30 },
            measureFinalGrid: () => {
              calls.push("measure");
              if (measurementFailure === "throws") throw new Error("fit failed");
              return undefined;
            },
            resizeBackend: async () => {
              calls.push("backend");
            },
            isActive: () => active,
          }),
        ).rejects.toThrow("aborted");
      } finally {
        for (const output of outputBuffer.drain()) terminal.write(output.data);
      }

      expect(terminal).toMatchObject({ cols: 100, rows: 30 });
      expect(calls).toContain("write:history@40x8");
      expect(calls).toContain("write:LIVE-A@100x30");
      expect(calls).toContain("write:LIVE-β@100x30");
      expect(calls.indexOf("resize:100x30")).toBeLessThan(calls.indexOf("write:LIVE-A@100x30"));
      expect(calls).not.toContain("backend");
    },
  );

  it("detects a no-op measured resize and restores the backend-open grid", async () => {
    const calls: string[] = [];
    let ignoreMeasuredResize = true;
    const terminal = {
      cols: 100,
      rows: 30,
      resize(cols: number, rows: number) {
        if (cols === 110 && rows === 35 && ignoreMeasuredResize) {
          ignoreMeasuredResize = false;
          calls.push("measured-no-op");
          return;
        }
        this.cols = cols;
        this.rows = rows;
        calls.push(`resize:${cols}x${rows}`);
      },
      write(_data: string, callback?: () => void) {
        callback?.();
      },
    };

    await replaySnapshotAtRecoveredGrid({
      terminal,
      snapshot: dimensionedSnapshot(40, 8),
      backendOpenDimensions: { cols: 100, rows: 30 },
      measureFinalGrid: () => ({ cols: 110, rows: 35 }),
      resizeBackend: async () => {
        calls.push("backend");
      },
    });

    expect(terminal).toMatchObject({ cols: 100, rows: 30 });
    expect(calls).toEqual(["resize:40x8", "measured-no-op", "resize:100x30"]);
  });

  it.each(["throws", "partially applies"])(
    "restores the backend-open grid when staging resize %s",
    async (stagingFailure) => {
      const calls: string[] = [];
      let staging = true;
      const terminal = {
        cols: 100,
        rows: 30,
        resize(cols: number, rows: number) {
          if (staging) {
            staging = false;
            if (stagingFailure === "partially applies") this.cols = cols;
            calls.push(`staging-failed:${this.cols}x${this.rows}`);
            throw new Error("staging failed");
          }
          this.cols = cols;
          this.rows = rows;
          calls.push(`resize:${cols}x${rows}`);
        },
        write(data: string, callback?: () => void) {
          calls.push(`write:${data}`);
          callback?.();
        },
      };

      await expect(
        replaySnapshotAtRecoveredGrid({
          terminal,
          snapshot: dimensionedSnapshot(40, 8),
          backendOpenDimensions: { cols: 100, rows: 30 },
          measureFinalGrid: () => {
            calls.push("measure");
            return { cols: 110, rows: 35 };
          },
          resizeBackend: async () => {
            calls.push("backend");
          },
        }),
      ).rejects.toThrow("staging failed");

      expect(terminal).toMatchObject({ cols: 100, rows: 30 });
      expect(calls).not.toContain("measure");
      expect(calls).not.toContain("write:history");
      expect(calls).not.toContain("backend");
    },
  );

  it.each(["no-op", "partially applies"] as const)(
    "rejects when staging silently %s, restores the backend grid, and permits retry",
    async (stagingFailure) => {
      const snapshot = dimensionedSnapshot(40, 8);
      const state: ReplayIdentityState = {
        appliedHistoryRecordIdentity: null,
        pendingHistoryRecordIdentity: null,
        pendingHistoryReplayPromise: null,
      };
      const calls: string[] = [];
      let failStaging = true;
      const terminal = {
        cols: 100,
        rows: 30,
        resize(cols: number, rows: number) {
          calls.push(`resize:${cols}x${rows}`);
          if (failStaging && cols === 40 && rows === 8) {
            if (stagingFailure === "partially applies") this.cols = cols;
            return;
          }
          this.cols = cols;
          this.rows = rows;
        },
        write(data: string, callback?: () => void) {
          calls.push(`write:${data}`);
          callback?.();
        },
      };
      const replay = () =>
        replaySnapshotAtRecoveredGrid({
          terminal,
          snapshot,
          backendOpenDimensions: { cols: 100, rows: 30 },
          measureFinalGrid: () => ({ cols: 110, rows: 35 }),
          resizeBackend: async () => {
            calls.push("backend");
          },
        });

      await expect(applyReplayOnce(state, snapshot.historyRecordIdentity, replay)).rejects.toThrow(
        "staging resize did not reach",
      );
      expect(terminal).toMatchObject({ cols: 100, rows: 30 });
      expect(calls).not.toContain("write:history");
      expect(calls).not.toContain("backend");
      expect(state.appliedHistoryRecordIdentity).toBeNull();

      failStaging = false;
      expect(await applyReplayOnce(state, snapshot.historyRecordIdentity, replay)).toBe(true);
      expect(state.appliedHistoryRecordIdentity).toBe(snapshot.historyRecordIdentity);
      expect(calls.filter((call) => call === "write:history")).toHaveLength(1);
    },
  );

  it("marks output unsafe when a partial staging resize cannot restore the fallback", async () => {
    let resizeCalls = 0;
    const terminal = {
      cols: 100,
      rows: 30,
      resize(cols: number) {
        resizeCalls += 1;
        if (resizeCalls === 1) this.cols = cols;
        throw new Error("resize unavailable");
      },
      write(_data: string, callback?: () => void) {
        callback?.();
      },
    };

    await expect(
      replaySnapshotAtRecoveredGrid({
        terminal,
        snapshot: dimensionedSnapshot(40, 8),
        backendOpenDimensions: { cols: 100, rows: 30 },
        measureFinalGrid: () => undefined,
        resizeBackend: async () => undefined,
      }),
    ).rejects.toBeInstanceOf(RecoveredGridFinalizationError);
    expect(terminal).toMatchObject({ cols: 40, rows: 30 });
    expect(resizeCalls).toBe(3);
  });

  it("restores the backend-open grid after the only backend resize rejects", async () => {
    let backendResizeCalls = 0;
    const terminal = {
      cols: 100,
      rows: 30,
      resize(cols: number, rows: number) {
        this.cols = cols;
        this.rows = rows;
      },
      write(_data: string, callback?: () => void) {
        callback?.();
      },
    };

    await expect(
      replaySnapshotAtRecoveredGrid({
        terminal,
        snapshot: dimensionedSnapshot(40, 8),
        backendOpenDimensions: { cols: 100, rows: 30 },
        measureFinalGrid: () => ({ cols: 110, rows: 35 }),
        resizeBackend: async () => {
          backendResizeCalls += 1;
          throw new Error("backend resize failed");
        },
      }),
    ).rejects.toThrow("backend resize failed");

    expect(backendResizeCalls).toBe(1);
    expect(terminal).toMatchObject({ cols: 100, rows: 30 });
  });

  it("finalizes an invalidated staged replay before releasing every live byte and permits retry", async () => {
    const snapshot = dimensionedSnapshot(40, 8);
    const state: ReplayIdentityState = {
      appliedHistoryRecordIdentity: null,
      pendingHistoryRecordIdentity: null,
      pendingHistoryReplayPromise: null,
    };
    const calls: string[] = [];
    const releasedOutputs: Array<{ data: string; byteLength: number }> = [];
    const backendResizes: Array<{ cols: number; rows: number }> = [];
    let backendDimensions = { cols: 100, rows: 30 };
    let active = true;
    let attempt = 0;
    let activeOutputBuffer: ReturnType<typeof createRecoveredGridOutputBuffer> | null = null;
    const terminal = {
      cols: 100,
      rows: 30,
      resize(cols: number, rows: number) {
        this.cols = cols;
        this.rows = rows;
        calls.push(`local:${cols}x${rows}`);
      },
      write(data: string, callback?: () => void) {
        calls.push(`write:${data}@${this.cols}x${this.rows}`);
        if (data === snapshot.history && attempt === 1) {
          queueMicrotask(() => {
            activeOutputBuffer?.enqueue({ data: "LIVE-A", byteLength: 6 });
            activeOutputBuffer?.enqueue({ data: "LIVE-β", byteLength: 7 });
            active = false;
            calls.push("history-parsed-and-invalidated");
            callback?.();
          });
          return;
        }
        queueMicrotask(() => callback?.());
      },
    };

    const replay = async () => {
      attempt += 1;
      const outputBuffer = createRecoveredGridOutputBuffer();
      activeOutputBuffer = outputBuffer;
      try {
        await replaySnapshotAtRecoveredGrid({
          terminal,
          snapshot,
          backendOpenDimensions: backendDimensions,
          measureFinalGrid: () => {
            calls.push("fit");
            return { cols: 110, rows: 35 };
          },
          resizeBackend: async (dimensions) => {
            backendResizes.push(dimensions);
            backendDimensions = dimensions;
            calls.push(`backend:${dimensions.cols}x${dimensions.rows}`);
          },
          isActive: () => active,
        });
      } finally {
        activeOutputBuffer = null;
        for (const output of outputBuffer.drain()) {
          releasedOutputs.push(output);
          terminal.write(output.data);
        }
      }
    };

    await expect(applyReplayOnce(state, snapshot.historyRecordIdentity, replay)).rejects.toThrow(
      "aborted",
    );
    expect(terminal).toMatchObject({ cols: 110, rows: 35 });
    expect(backendResizes).toEqual([{ cols: 110, rows: 35 }]);
    expect(releasedOutputs).toEqual([
      { data: "LIVE-A", byteLength: 6 },
      { data: "LIVE-β", byteLength: 7 },
    ]);
    expect(calls.indexOf("backend:110x35")).toBeLessThan(calls.indexOf("write:LIVE-A@110x35"));
    expect(calls).toContain("write:history@40x8");
    expect(state).toEqual({
      appliedHistoryRecordIdentity: null,
      pendingHistoryRecordIdentity: null,
      pendingHistoryReplayPromise: null,
    });

    active = true;
    expect(await applyReplayOnce(state, snapshot.historyRecordIdentity, replay)).toBe(true);
    expect(await applyReplayOnce(state, snapshot.historyRecordIdentity, replay)).toBe(false);
    expect(backendResizes).toEqual([{ cols: 110, rows: 35 }]);
    expect(state.appliedHistoryRecordIdentity).toBe(snapshot.historyRecordIdentity);
  });
});

describe("destination and warm replay compatibility", () => {
  it("keeps legacy history on the destination grid", () => {
    const writes: string[] = [];
    const terminal = {
      cols: 100,
      rows: 30,
      resize() {
        throw new Error("legacy replay must not stage a recovered grid");
      },
      write(data: string, callback?: () => void) {
        writes.push(data);
        callback?.();
      },
    };

    replaySnapshotAtDestinationGrid(terminal, legacySnapshot());

    expect(terminal.cols).toBe(100);
    expect(terminal.rows).toBe(30);
    expect(writes).toEqual(["\u001bc", "history"]);
  });

  it("does not select cold replay after live output advances", () => {
    const snapshot = dimensionedSnapshot();
    expect(shouldReplayColdSnapshot(snapshot, 0, 0)).toBe(true);
    expect(shouldReplayColdSnapshot(snapshot, 4, 4)).toBe(false);
    expect(shouldReplayColdSnapshot(snapshot, 4, 5)).toBe(false);
    expect(shouldReplayColdSnapshot(snapshot, 4, 5, true)).toBe(true);
    expect(shouldReplayColdSnapshot({ ...snapshot, history: "" }, 4, 5, true)).toBe(true);
    expect(shouldReplayColdSnapshot(legacySnapshot(), 4, 5, true)).toBe(true);
  });

  it("replays authoritative dimensionless history only after restoring the backend-open grid", async () => {
    const calls: string[] = [];
    const terminal = {
      cols: 40,
      rows: 8,
      resize(cols: number, rows: number) {
        this.cols = cols;
        this.rows = rows;
        calls.push(`resize:${cols}x${rows}`);
      },
      write(data: string, callback?: () => void) {
        calls.push(`write:${data}@${this.cols}x${this.rows}`);
        callback?.();
      },
    };

    await replaySnapshotAtBackendOpenGrid({
      terminal,
      snapshot: legacySnapshot(),
      backendOpenDimensions: { cols: 100, rows: 30 },
    });

    expect(terminal).toMatchObject({ cols: 100, rows: 30 });
    expect(calls).toEqual(["resize:100x30", "write:\u001bc@100x30", "write:history@100x30"]);
  });

  it("uses stable content identities for legacy replay and separates changed content or grids", async () => {
    const first = legacySnapshot();
    const samePayload = { ...legacySnapshot(), updatedAt: new Date(1).toISOString() };
    const changedPayload = { ...legacySnapshot(), history: "history changed" };
    const firstGrid = { ...dimensionedSnapshot(80, 24), historyRecordIdentity: undefined };
    const changedGrid = { ...firstGrid, recoveredCols: 81 };

    expect(await snapshotReplayIdentity(first)).toBe(await snapshotReplayIdentity(samePayload));
    expect(await snapshotReplayIdentity(changedPayload)).not.toBe(
      await snapshotReplayIdentity(first),
    );
    expect(await snapshotReplayIdentity(changedGrid)).not.toBe(
      await snapshotReplayIdentity(firstGrid),
    );
  });
});

describe("applyReplayOnce", () => {
  it("deduplicates concurrent RPC/push delivery and retries failures", async () => {
    const state: ReplayIdentityState = {
      appliedHistoryRecordIdentity: null,
      pendingHistoryRecordIdentity: null,
      pendingHistoryReplayPromise: null,
    };
    let releaseFirst: (() => void) | undefined;
    let calls = 0;
    const first = applyReplayOnce(state, "same", async () => {
      calls += 1;
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
    });
    const duplicate = applyReplayOnce(state, "same", async () => {
      calls += 1;
    });
    await Promise.resolve();
    expect(calls).toBe(1);
    releaseFirst?.();
    expect(await first).toBe(true);
    expect(await duplicate).toBe(false);
    expect(calls).toBe(1);

    expect(
      await applyReplayOnce(state, "same-text-new-grid", async () => {
        calls += 1;
      }),
    ).toBe(true);
    await expect(
      applyReplayOnce(state, "retry", async () => {
        throw new Error("parse failed");
      }),
    ).rejects.toThrow("parse failed");
    expect(
      await applyReplayOnce(state, "retry", async () => {
        calls += 1;
      }),
    ).toBe(true);
    expect(calls).toBe(3);
  });

  it("keeps unsafe buffered output ordered and the record retryable until recovery", async () => {
    const state: ReplayIdentityState = {
      appliedHistoryRecordIdentity: null,
      pendingHistoryRecordIdentity: null,
      pendingHistoryReplayPromise: null,
    };
    const outputBuffer = createRecoveredGridOutputBuffer();
    const released: string[] = [];
    let finalizationIsSafe = false;
    const replay = async () => {
      if (!finalizationIsSafe) {
        throw new RecoveredGridFinalizationError("unsafe grid", new Error("resize failed"));
      }
      released.push(...outputBuffer.drain().map((output) => output.data));
    };

    outputBuffer.enqueue({ data: "LIVE-BEFORE-FAILURE", byteLength: 19 });
    await expect(applyReplayOnce(state, "retained", replay)).rejects.toBeInstanceOf(
      RecoveredGridFinalizationError,
    );
    outputBuffer.enqueue({ data: "LIVE-AFTER-FAILURE", byteLength: 18 });

    expect(released).toEqual([]);
    expect(state).toEqual({
      appliedHistoryRecordIdentity: null,
      pendingHistoryRecordIdentity: null,
      pendingHistoryReplayPromise: null,
    });

    finalizationIsSafe = true;
    expect(await applyReplayOnce(state, "retained", replay)).toBe(true);
    expect(await applyReplayOnce(state, "retained", replay)).toBe(false);
    expect(released).toEqual(["LIVE-BEFORE-FAILURE", "LIVE-AFTER-FAILURE"]);
    expect(state.appliedHistoryRecordIdentity).toBe("retained");
  });
});
