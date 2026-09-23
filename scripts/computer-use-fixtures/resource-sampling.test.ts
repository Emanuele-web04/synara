import { describe, expect, it } from "vitest";
import {
  makeResourceTracker,
  parseLifetimeCpuSeconds,
  parseResourceSnapshot,
  resourceIdentity,
  resourceSamplingOptions,
  type ResourceProcess,
} from "./resource-sampling.ts";

const START = "Sun Sep 20 10:00:00 2026";
const LATER = "Sun Sep 20 10:00:02 2026";
const APP = "/Applications/Synara Cua.app/Contents/MacOS/Synara Cua";

function processRow(pid: number, parentPid: number, startedAt = START): ResourceProcess {
  return {
    pid,
    parentPid,
    startedAt,
    executable: pid === 10 ? APP : "/usr/local/bin/node",
    rssKiB: 1_024,
    cpuPercent: 12.5,
    lifetimeCpuSeconds: 3,
  };
}

describe("packaged resource snapshot parser", () => {
  it("parses macOS centiseconds, spaces in executable paths and normalized start identity", () => {
    const [row] = parseResourceSnapshot(
      `  10  1 Sun Sep  20 10:00:00 2026 123456 120.5 2:03.45 ${APP}\n`,
    );
    expect(row).toEqual({
      pid: 10,
      parentPid: 1,
      startedAt: START,
      executable: APP,
      rssKiB: 123_456,
      cpuPercent: 120.5,
      lifetimeCpuSeconds: 123.45,
    });
  });

  it.each([
    ["0:00.00", 0],
    ["123:45.67", 7_425.67],
    ["01:02:03", 3_723],
    ["2-01:02:03.50", 176_523.5],
  ])("parses lifetime CPU %s in seconds", (input, expected) => {
    expect(parseLifetimeCpuSeconds(String(input))).toBe(expected);
  });

  it.each(["1:60.0", "2:61:00", "2-01:02", "1-24:00:00", "nan", "-1:00", "00:00:00 secret"])(
    "rejects malformed CPU time %s",
    (input) => {
      expect(() => parseLifetimeCpuSeconds(input)).toThrow("Invalid ps CPU time");
    },
  );

  it("fails closed on malformed/truncated snapshots and duplicate PIDs without echoing data", () => {
    const row = `10 1 ${START} 1024 0.0 0:00.01 ${APP}`;
    expect(() => parseResourceSnapshot(`${row}\n${row}`)).toThrow("duplicate process identity");
    expect(() => parseResourceSnapshot("private-unrelated-command")).toThrow(
      "Malformed resource snapshot; no raw process data was retained.",
    );
    expect(() => parseResourceSnapshot(`10 1 ${START} 1024`)).toThrow(
      "Malformed resource snapshot",
    );
  });
});

describe("packaged process ownership", () => {
  it("finds nested descendants regardless of row order and excludes unrelated same-bundle processes", () => {
    const root = processRow(10, 1);
    const unrelated = { ...processRow(99, 1), executable: APP };
    const select = makeResourceTracker(root);
    const result = select([processRow(12, 11), unrelated, processRow(11, 10), root]);
    expect(result.rootState).toBe("running");
    expect(result.processes.map((row) => row.pid)).toEqual([10, 11, 12]);
  });

  it("retains observed reparented children and new descendants after the root exits", () => {
    const root = processRow(10, 1);
    const select = makeResourceTracker(root);
    select([root, processRow(11, 10)]);
    const result = select([processRow(11, 1), processRow(12, 11, LATER), processRow(50, 1)]);
    expect(result.rootState).toBe("missing");
    expect(result.processes.map((row) => row.pid)).toEqual([11, 12]);
  });

  it("does not adopt an unseen orphan whose parent ended between observations", () => {
    const root = processRow(10, 1);
    const select = makeResourceTracker(root);
    select([root]);
    expect(select([processRow(12, 1)]).processes).toEqual([]);
  });

  it("does not follow a reused root PID or its new descendants", () => {
    const root = processRow(10, 1);
    const select = makeResourceTracker(root);
    select([root, processRow(11, 10)]);
    const replacement = processRow(10, 1, LATER);
    const result = select([replacement, processRow(20, 10, LATER), processRow(11, 1)]);
    expect(result.rootState).toBe("replaced");
    expect(result.processes.map((row) => row.pid)).toEqual([11]);
  });

  it("drops a reused child PID and treats a later owned child with that PID as a new identity", () => {
    const root = processRow(10, 1);
    const oldChild = processRow(11, 10);
    const select = makeResourceTracker(root);
    select([root, oldChild]);
    const replacement = processRow(11, 1, LATER);
    expect(select([root, replacement, processRow(12, 11, LATER)]).processes).toEqual([root]);
    const newChild = { ...replacement, parentPid: root.pid };
    expect(select([root, newChild]).processes).toEqual([root, newChild]);
    expect(resourceIdentity(oldChild)).not.toBe(resourceIdentity(newChild));
  });

  it("drops an original root that execs a different executable under the same PID/start", () => {
    const root = processRow(10, 1);
    const select = makeResourceTracker(root);
    const result = select([{ ...root, executable: "/usr/bin/unrelated" }]);
    expect(result.rootState).toBe("replaced");
    expect(result.processes).toEqual([]);
  });

  it("bounds a corrupt parent cycle rather than looping", () => {
    const root = processRow(10, 11);
    expect(makeResourceTracker(root)([root, processRow(11, 10)]).processes).toHaveLength(2);
  });
});

describe("resource sampler bounds", () => {
  it("requires one explicit root and has bounded defaults", () => {
    expect(resourceSamplingOptions({ pid: "10" })).toEqual({
      rootPid: 10,
      durationMs: 120_000,
      intervalMs: 1_000,
    });
  });

  it.each([
    {},
    { pid: "1" },
    { pid: "2; echo secret" },
    { pid: "2147483648" },
    { pid: "10", seconds: "0" },
    { pid: "10", seconds: "601" },
    { pid: "10", intervalMs: "1" },
    { pid: "10", intervalMs: "5001" },
  ])("rejects unbounded or invalid arguments %j", (input) => {
    expect(() => resourceSamplingOptions(input)).toThrow();
  });
});
