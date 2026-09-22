import { spawn } from "node:child_process";
import { once } from "node:events";

import { describe, expect, it, vi } from "vitest";

import {
  captureProcessTree,
  createProcessTreeKiller,
  inspectProcessTree,
  parseProcessChildrenMap,
  signalOwnedChildProcess,
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
      readCurrentProcesses: () => {
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
      readCurrentProcesses: () => {
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



describe("signal target and captured identity safeguards", () => {
  it.each([0, 1, -1, -42, 1.5, NaN, Infinity, 2 ** 32 + 1])(
    "does not inspect or signal unsafe root %s",
    async (rootPid) => {
      const captureChildrenMap = vi.fn(() => new Map());
      const signalPid = vi.fn(() => null);
      const signalTree = vi.fn();
      const captureWindowsChildren = vi.fn(async () => new Map());
      const killer = createProcessTreeKiller({ captureChildrenMap, signalPid, signalTree });
      expect(killer.capture(rootPid).captureComplete).toBe(false);
      await captureProcessTree(rootPid, { platform: "win32", captureWindowsChildren });
      killer.signal({
        rootPid,
        signal: "SIGTERM",
        tree: { descendants: [{ pid: 20, command: "child" }] },
        onError: vi.fn(),
      });
      expect(captureChildrenMap).not.toHaveBeenCalled();
      expect(captureWindowsChildren).not.toHaveBeenCalled();
      expect(signalPid).not.toHaveBeenCalled();
      expect(signalTree).not.toHaveBeenCalled();
    },
  );

  it("rejects unsafe descendant targets even with preverified identities", () => {
    const signalPid = vi.fn(() => null);
    createProcessTreeKiller({ signalPid }).signal({
      rootPid: 100,
      signal: "SIGKILL",
      includeRootTree: false,
      verifiedDescendants: true,
      tree: {
        descendants: [0, 1, -1, 1.5, NaN, Infinity, 2 ** 32 + 1].map((pid) => ({
          pid,
          command: "invalid",
        })),
      },
      onError: vi.fn(),
    });
    expect(signalPid).not.toHaveBeenCalled();
  });

  it("rejects same-command recycled descendants using one batched identity lookup", () => {
    const original = { pid: 101, command: "worker", startedAt: "Fri Sep 18 10:00:00 2026" };
    const unchanged = { pid: 102, command: "worker", startedAt: "Fri Sep 18 10:00:01 2026" };
    const readCurrentProcesses = vi.fn(
      () =>
        new Map([
          [101, { ...original, startedAt: "Fri Sep 18 11:00:00 2026" }],
          [102, { ...unchanged }],
        ]),
    );
    const signalPid = vi.fn(() => null);
    const killer = createProcessTreeKiller({ readCurrentProcesses, signalPid });
    const tree = { descendants: [original, unchanged] };
    killer.signal({
      rootPid: 100,
      signal: "SIGKILL",
      tree,
      includeRootTree: false,
      onError: vi.fn(),
    });
    expect(readCurrentProcesses).toHaveBeenCalledExactlyOnceWith([101, 102]);
    expect(signalPid).toHaveBeenCalledExactlyOnceWith(102, "SIGKILL");
    expect(killer.inspect?.(tree)).toEqual({ verified: true, survivors: [unchanged] });
  });

  it("does not downgrade a captured start time when the new snapshot lacks it", () => {
    const signalPid = vi.fn(() => null);
    createProcessTreeKiller({
      signalPid,
      readCurrentProcesses: () => new Map([[101, { pid: 101, command: "worker" }]]),
    }).signal({
      rootPid: 100,
      signal: "SIGKILL",
      tree: { descendants: [{ pid: 101, command: "worker", startedAt: "old" }] },
      includeRootTree: false,
      onError: vi.fn(),
    });
    expect(signalPid).not.toHaveBeenCalled();
  });
});

describe("owned child signals", () => {
  it.each([undefined, 0, 1, -1, NaN, Infinity, 1.5, 2 ** 32 + 1])(
    "rejects unsafe child PID %s",
    (pid) => {
      const kill = vi.fn();
      signalOwnedChildProcess({ pid, kill }, "SIGTERM", "darwin");
      signalOwnedChildProcess({ pid, kill }, "SIGTERM", "win32");
      expect(kill).not.toHaveBeenCalled();
    },
  );

  it("uses the owned POSIX handle without depending on external process probes", () => {
    const kill = vi.fn();
    signalOwnedChildProcess({ pid: 12345, kill }, "SIGKILL", "darwin");
    expect(kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
  });

  it("parses start times without changing the terminal activity snapshot format", () => {
    expect(
      parseProcessChildrenMap("101 100 Fri Sep 18 10:00:00 2026 /bin/sh worker", true),
    ).toEqual(
      new Map([
        [100, [{ pid: 101, startedAt: "Fri Sep 18 10:00:00 2026", command: "/bin/sh worker" }]],
      ]),
    );
    expect(parseProcessChildrenMap("101 100 /bin/sh worker")).toEqual(
      new Map([[100, [{ pid: 101, command: "/bin/sh worker" }]]]),
    );
  });
});

it("rejects a different command even when second-resolution start times match", () => {
  const captured = { pid: 101, command: "owned worker", startedAt: "Fri Sep 18 10:00:00 2026" };
  const signalPid = vi.fn(() => null);
  const killer = createProcessTreeKiller({
    signalPid,
    readCurrentProcesses: () => new Map([[101, { ...captured, command: "unrelated worker" }]]),
  });
  const tree = { descendants: [captured] };
  killer.signal({
    rootPid: 100,
    signal: "SIGKILL",
    tree,
    includeRootTree: false,
    onError: vi.fn(),
  });
  expect(signalPid).not.toHaveBeenCalled();
  expect(killer.inspect?.(tree)).toEqual({ verified: true, survivors: [] });
});

it.skipIf(process.platform !== "darwin")(
  "captures and verifies native start times independently of the parent locale",
  async () => {
    const previousLocale = process.env.LC_ALL;
    const child = spawn("/bin/sleep", ["1"], { stdio: "ignore" });
    const exited = once(child, "exit");
    try {
      await once(child, "spawn");
      process.env.LC_ALL = "ja_JP.UTF-8";
      const killer = createProcessTreeKiller();
      const captured = killer.capture(process.pid).descendants.find((row) => row.pid === child.pid);
      expect(captured).toBeDefined();
      expect(captured?.command).toBe("/bin/sleep 1");
      expect(captured?.startedAt).toMatch(/^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) [A-Z][a-z]{2} /);
      if (!captured) throw new Error("Owned test child was not captured");
      // Both probes must use the same stable locale, even if the parent changes it.
      process.env.LC_ALL = "fr_FR.UTF-8";
      expect(killer.inspect?.({ descendants: [captured] })).toEqual({
        verified: true,
        survivors: [captured],
      });
      expect(process.env.LC_ALL).toBe("fr_FR.UTF-8");
    } finally {
      if (previousLocale === undefined) delete process.env.LC_ALL;
      else process.env.LC_ALL = previousLocale;
      await exited;
    }
  },
);

