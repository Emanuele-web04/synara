import { describe, expect, it, vi } from "vitest";

import {
  captureProcessTree,
  createProcessTreeKiller,
  inspectProcessTree,
  type ProcessChildrenMap,
  type ProcessTreeKiller,
  type ProcessTreeKillerDependencies,
} from "./processTreeController";

function windowsTree(): ProcessChildrenMap {
  return new Map([
    [
      100,
      [{ pid: 101, command: "provider-child.exe --serve", startedAt: "20260901100000.000000+000" }],
    ],
    [
      101,
      [{ pid: 102, command: "provider-grandchild.exe", startedAt: "20260901100001.000000+000" }],
    ],
  ]);
}

describe("Windows process-tree controller", () => {
  it("captures child and grandchild identities from one platform snapshot", async () => {
    await expect(
      captureProcessTree(100, {
        platform: "win32",
        captureWindowsChildren: async () => windowsTree(),
      }),
    ).resolves.toEqual({
      captureComplete: true,
      descendants: [
        { pid: 101, command: "provider-child.exe --serve", startedAt: "20260901100000.000000+000" },
        { pid: 102, command: "provider-grandchild.exe", startedAt: "20260901100001.000000+000" },
      ],
    });
  });

  it("captures process trees larger than the former traversal cap", async () => {
    const childrenByParentPid: ProcessChildrenMap = new Map();
    for (let pid = 100; pid < 400; pid += 1) {
      childrenByParentPid.set(pid, [{ pid: pid + 1, command: `worker-${pid + 1}` }]);
    }

    const captured = await captureProcessTree(100, {
      platform: "win32",
      captureWindowsChildren: async () => childrenByParentPid,
    });

    expect(captured.captureComplete).toBe(true);
    expect(captured.descendants).toHaveLength(300);
    expect(captured.descendants.at(-1)).toEqual({ pid: 400, command: "worker-400" });
  });

  it("treats a failed Windows snapshot as unknown, never an empty proven tree", async () => {
    const captured = await captureProcessTree(100, {
      platform: "win32",
      captureWindowsChildren: async () => null,
    });

    expect(captured).toEqual({ descendants: [], captureComplete: false });
    await expect(
      inspectProcessTree(captured, {
        platform: "win32",
        captureWindowsChildren: async () => new Map(),
      }),
    ).resolves.toEqual({ verified: false, survivors: [] });
  });

  it("rejects a reused Windows PID when the creation identity changed", async () => {
    const tree = await captureProcessTree(100, {
      platform: "win32",
      captureWindowsChildren: async () => windowsTree(),
    });
    const reused: ProcessChildrenMap = new Map([
      [
        900,
        [
          {
            pid: 101,
            command: "provider-child.exe --serve",
            startedAt: "20260901110000.000000+000",
          },
        ],
      ],
    ]);

    await expect(
      inspectProcessTree(tree, {
        platform: "win32",
        captureWindowsChildren: async () => reused,
      }),
    ).resolves.toEqual({ verified: true, survivors: [] });
  });

  it("reports only descendants whose command and creation identity still match", async () => {
    const tree = await captureProcessTree(100, {
      platform: "win32",
      captureWindowsChildren: async () => windowsTree(),
    });
    const current: ProcessChildrenMap = new Map([
      [
        900,
        [{ pid: 102, command: "provider-grandchild.exe", startedAt: "20260901100001.000000+000" }],
      ],
    ]);

    await expect(
      inspectProcessTree(tree, {
        platform: "win32",
        captureWindowsChildren: async () => current,
      }),
    ).resolves.toEqual({
      verified: true,
      survivors: [
        { pid: 102, command: "provider-grandchild.exe", startedAt: "20260901100001.000000+000" },
      ],
    });
  });

  it("force-signals identity-verified descendants without a POSIX command lookup", () => {
    const signalled: Array<{ pid: number; signal: "SIGTERM" | "SIGKILL" }> = [];
    let commandLookups = 0;
    const killer = createProcessTreeKiller({
      captureChildrenMap: () => new Map(),
      readCurrentCommands: () => {
        commandLookups += 1;
        return null;
      },
      signalPid: (pid, signal) => {
        signalled.push({ pid, signal });
        return null;
      },
      signalTree: (_rootPid, _signal, callback) => callback(),
    });

    killer.signal({
      rootPid: 100,
      signal: "SIGKILL",
      tree: {
        captureComplete: true,
        descendants: [
          { pid: 101, command: "provider-child.exe", startedAt: "20260901100000.000000+000" },
          { pid: 102, command: "provider-grandchild.exe", startedAt: "20260901100001.000000+000" },
        ],
      },
      verifiedDescendants: true,
      includeRootTree: false,
      onError: () => undefined,
    });

    expect(commandLookups).toBe(0);
    expect(signalled).toEqual([
      { pid: 102, signal: "SIGKILL" },
      { pid: 101, signal: "SIGKILL" },
    ]);
  });

  it("does not force unverified descendants when identity lookup is unavailable", () => {
    const signalled: number[] = [];
    let rowLookups = 0;
    const killer = createProcessTreeKiller({
      captureChildrenMap: () => new Map(),
      readLiveProcessRow: () => {
        rowLookups += 1;
        return undefined;
      },
      signalPid: (pid) => {
        signalled.push(pid);
        return null;
      },
      signalTree: (_rootPid, _signal, callback) => callback(),
    });

    killer.signal({
      rootPid: 100,
      signal: "SIGKILL",
      tree: {
        captureComplete: true,
        descendants: [{ pid: 101, command: "provider-child.exe" }],
      },
      includeRootTree: false,
      onError: () => undefined,
    });

    expect(rowLookups).toBe(1);
    expect(signalled).toEqual([]);
  });
});

describe("signal target guards", () => {
  const itPosix = process.platform === "win32" ? it.skip : it;
  const run = (
    deps: Partial<ProcessTreeKillerDependencies>,
    input: Omit<Parameters<ProcessTreeKiller["signal"]>[0], "onError">,
  ) => {
    const signalPid = vi.fn(() => null);
    const signalTree = vi.fn();
    createProcessTreeKiller({ signalPid, signalTree, ...deps }).signal({
      ...input,
      onError: () => undefined,
    });
    return { signalPid, signalTree };
  };

  // The module self-installs the process.kill guard at import; unsafe targets
  // throw before any real signal can leave the process.
  it("refuses broadcast signal targets", () => {
    expect(() => process.kill(-1, "SIGTERM")).toThrow();
    expect(() => process.kill(0, "SIGTERM")).toThrow();
    expect(() => process.kill(1, "SIGTERM")).toThrow();
  });

  it("refuses to signal a stale root", () => {
    const { signalPid, signalTree } = run(
      { readLiveProcessRow: () => ({ ppid: process.pid, command: "x", startedAt: "new" }) },
      {
        rootPid: 424242,
        signal: "SIGTERM",
        tree: {
          root: { pid: 424242, ppid: process.pid, command: "x", startedAt: "old" },
          descendants: [],
        },
      },
    );
    expect(signalPid).not.toHaveBeenCalled();
    expect(signalTree).not.toHaveBeenCalled();
  });

  itPosix("signals a verified root and verified descendants", () => {
    const rows = new Map([
      [424242, { ppid: process.pid, command: "x", startedAt: "s1" }],
      [424243, { ppid: 424242, command: "x", startedAt: "s2" }],
    ]);
    const { signalPid, signalTree } = run(
      { readLiveProcessRow: (pid) => rows.get(pid) },
      {
        rootPid: 424242,
        signal: "SIGTERM",
        tree: {
          root: { pid: 424242, ppid: process.pid, command: "x", startedAt: "s1" },
          descendants: [{ pid: 424243, ppid: 424242, command: "x", startedAt: "s2" }],
        },
      },
    );
    expect(signalPid.mock.calls).toEqual([
      [424243, "SIGTERM"],
      [424242, "SIGTERM"],
    ]);
    expect(signalTree).not.toHaveBeenCalled();
  });

  itPosix("signals verified descendants when the root already exited", () => {
    const { signalPid, signalTree } = run(
      {
        readLiveProcessRow: (pid) =>
          pid === 424243 ? { ppid: 1, command: "x", startedAt: "s2" } : null,
        readSpawnIdentity: () => ({ ppid: process.pid, startedAt: "s1" }),
      },
      {
        rootPid: 424242,
        signal: "SIGTERM",
        tree: {
          root: { pid: 424242, ppid: process.pid, command: "x", startedAt: "s1" },
          descendants: [{ pid: 424243, ppid: 424242, command: "x", startedAt: "s2" }],
        },
      },
    );
    expect(signalPid.mock.calls).toEqual([[424243, "SIGTERM"]]);
    expect(signalTree).not.toHaveBeenCalled();
  });

  it("refuses a captured tree rooted at a recycled sibling", () => {
    const { signalPid, signalTree } = run(
      {
        readLiveProcessRow: (pid) =>
          pid === 424243
            ? { ppid: 424242, command: "sib", startedAt: "s2" }
            : { ppid: process.pid, command: "sib", startedAt: "s2" },
        readSpawnIdentity: () => ({ ppid: process.pid, startedAt: "a" }),
      },
      {
        rootPid: 424242,
        signal: "SIGTERM",
        tree: {
          root: { pid: 424242, ppid: process.pid, command: "sib", startedAt: "s2" },
          descendants: [{ pid: 424243, ppid: 424242, command: "sib", startedAt: "s2" }],
        },
      },
    );
    expect(signalPid).not.toHaveBeenCalled();
    expect(signalTree).not.toHaveBeenCalled();
  });
});
