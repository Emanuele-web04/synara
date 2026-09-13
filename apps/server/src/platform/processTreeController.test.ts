import { describe, expect, it } from "vitest";

import {
  captureProcessTree,
  createProcessTreeKiller,
  inspectProcessTree,
  type ProcessChildrenMap,
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
    let commandLookups = 0;
    const killer = createProcessTreeKiller({
      captureChildrenMap: () => new Map(),
      readCurrentCommands: () => {
        commandLookups += 1;
        return null;
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

    expect(commandLookups).toBe(1);
    expect(signalled).toEqual([]);
  });
});

// A minimal but realistic POSIX table: pid 1 (launchd) parents the whole
// user session; pid 4242 is a provider root with one grandchild.
function sessionSnapshot(): ProcessChildrenMap {
  return new Map([
    [0, [{ pid: 1, command: "/sbin/launchd" }]],
    [
      1,
      [
        { pid: 501, command: "loginwindow" },
        { pid: 4242, command: "provider-child" },
      ],
    ],
    [4242, [{ pid: 4243, command: "provider-grandchild" }]],
  ]);
}

describe("unsafe process-tree root guard", () => {
  it("refuses to collect a tree rooted at pid 1", () => {
    const killer = createProcessTreeKiller({ captureChildrenMap: sessionSnapshot });
    expect(killer.capture(1)).toEqual({ descendants: [], captureComplete: false });
  });

  it("refuses to collect a tree rooted at the current process", () => {
    const killer = createProcessTreeKiller({ captureChildrenMap: sessionSnapshot });
    expect(killer.capture(process.pid)).toEqual({ descendants: [], captureComplete: false });
  });

  it("proves absence when the root pid is missing from a complete snapshot", () => {
    const killer = createProcessTreeKiller({ captureChildrenMap: sessionSnapshot });
    expect(killer.capture(0x7fff_fffe)).toEqual({ descendants: [], captureComplete: true });
  });

  it("still collects descendants for a real root in the same snapshot", () => {
    const killer = createProcessTreeKiller({ captureChildrenMap: sessionSnapshot });
    expect(killer.capture(4242)).toEqual({
      descendants: [{ pid: 4243, command: "provider-grandchild" }],
      captureComplete: true,
    });
  });

  it.each([1, process.pid])(
    "never signals descendants or the root tree for unsafe root pid %s",
    (rootPid) => {
      const signalled: number[] = [];
      const treeKilled: number[] = [];
      const killer = createProcessTreeKiller({
        captureChildrenMap: sessionSnapshot,
        signalPid: (pid) => {
          signalled.push(pid);
          return null;
        },
        signalTree: (pid) => {
          treeKilled.push(pid);
        },
      });

      killer.signal({
        rootPid,
        signal: "SIGTERM",
        // Even a caller-supplied tree claiming launchd's descendants must not
        // be honored; signalTree runs its own live walk for pid 1.
        tree: {
          captureComplete: true,
          descendants: [{ pid: 501, command: "loginwindow" }],
        },
        includeRootTree: true,
        onError: () => undefined,
      });

      expect(signalled).toEqual([]);
      expect(treeKilled).toEqual([]);
    },
  );

  it("refuses unsafe roots through captureProcessTree before any snapshot", async () => {
    let snapshots = 0;
    const killer = createProcessTreeKiller({
      captureChildrenMap: () => {
        snapshots += 1;
        return sessionSnapshot();
      },
    });

    await expect(
      captureProcessTree(1, { platform: "darwin", processTreeKiller: killer }),
    ).resolves.toEqual({ descendants: [], captureComplete: false });
    expect(snapshots).toBe(0);
  });
});
