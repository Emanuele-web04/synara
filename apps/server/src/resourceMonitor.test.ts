import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./processRunner", () => ({ runProcess: vi.fn() }));

import { runProcess } from "./processRunner";
import { defaultProcessTreeKiller } from "./terminal/processTreeKiller";

import {
  buildResourceSnapshot,
  cancelResourceDiskScan,
  computeCpuDeltas,
  killResourceProcessTree,
  parseCpuTimeSeconds,
  parseResourceSampleOutput,
  resetResourceSamplerForTesting,
  scanResourceDiskUsage,
  verifyProviderProcessRoots,
  type ResourceSample,
} from "./resourceMonitor";

const runProcessMock = vi.mocked(runProcess);
const successfulProcessResult = (stdout: string) => ({
  stdout,
  stderr: "",
  code: 0,
  signal: null,
  timedOut: false,
});

afterEach(() => {
  cancelResourceDiskScan();
  runProcessMock.mockReset();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("parseCpuTimeSeconds", () => {
  it("parses mm:ss and fractional seconds", () => {
    expect(parseCpuTimeSeconds("0:01.50")).toBe(1.5);
    expect(parseCpuTimeSeconds("10:00")).toBe(600);
  });

  it("parses hh:mm:ss and dd-hh:mm:ss", () => {
    expect(parseCpuTimeSeconds("1:02:03")).toBe(3_723);
    expect(parseCpuTimeSeconds("1-02:03:04")).toBe(93_784);
  });

  it("rejects malformed input", () => {
    expect(parseCpuTimeSeconds("")).toBeNull();
    expect(parseCpuTimeSeconds("soon")).toBeNull();
    expect(parseCpuTimeSeconds("1:2:3:4")).toBeNull();
  });
});

describe("parseResourceSampleOutput", () => {
  it("parses pid/ppid/rss/time/comm/args rows", () => {
    const sample = parseResourceSampleOutput(
      "123 1 1024 0:01.50 /bin/zsh -l\n124 123 2048 0:00.25 node server.js --port 3000\n",
      1_000,
    );
    expect(sample.at).toBe(1_000);
    expect(sample.processes).toHaveLength(2);
    expect(sample.processes[0]).toMatchObject({
      pid: 123,
      ppid: 1,
      rssBytes: 1024 * 1024,
      cpuSeconds: 1.5,
      command: "/bin/zsh",
    });
    expect(sample.processes[1]?.args).toBe("server.js --port 3000");
  });

  it("prefers the full argv token over the truncated comm", () => {
    const sample = parseResourceSampleOutput(
      "321 1 8416 1:10.07 /System/Library/ /System/Library/PrivateFrameworks/MediaRemote.framework/Support/mediaremoted\n",
      0,
    );
    expect(sample.processes[0]?.command).toBe(
      "/System/Library/PrivateFrameworks/MediaRemote.framework/Support/mediaremoted",
    );
  });

  it("skips malformed rows", () => {
    const sample = parseResourceSampleOutput("garbage\n999 1 10 not-a-time 5 x\n", 0);
    expect(sample.processes).toHaveLength(0);
  });
});

describe("computeCpuDeltas", () => {
  it("returns empty deltas without a previous sample", () => {
    const current: ResourceSample = {
      at: 2_000,
      processes: [{ pid: 1, ppid: 0, rssBytes: 1, cpuSeconds: 2, command: "x", args: "" }],
    };
    expect(computeCpuDeltas(null, current).size).toBe(0);
  });

  it("computes delta/wall percentages per pid", () => {
    const previous: ResourceSample = {
      at: 0,
      processes: [{ pid: 7, ppid: 1, rssBytes: 1, cpuSeconds: 1, command: "x", args: "" }],
    };
    const current: ResourceSample = {
      at: 2_000,
      processes: [{ pid: 7, ppid: 1, rssBytes: 1, cpuSeconds: 2, command: "x", args: "" }],
    };
    expect(computeCpuDeltas(previous, current).get(7)).toBe(50);
  });
});

describe("buildResourceSnapshot", () => {
  const histories = new Map<string, number[]>();

  it("attributes terminal trees to project > worktree nodes", () => {
    const sample: ResourceSample = {
      at: 1_000,
      processes: [
        { pid: 10, ppid: 1, rssBytes: 100, cpuSeconds: 1, command: "zsh", args: "" },
        { pid: 11, ppid: 10, rssBytes: 200, cpuSeconds: 1, command: "node", args: "app" },
        { pid: 99, ppid: 1, rssBytes: 50, cpuSeconds: 1, command: "codex", args: "" },
      ],
    };
    const snapshot = buildResourceSnapshot({
      sample,
      cpuDeltas: new Map([
        [10, 5],
        [11, 10],
      ]),
      attribution: {
        terminals: [
          {
            threadId: "thread-1",
            terminalId: "main",
            cwd: "/repo/.synara/worktrees/abc",
            status: "running",
            pid: 10,
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
        worktrees: [{ path: "/repo/.synara/worktrees/abc", workspaceRoot: "/repo" }],
      },
      histories,
      serverPid: 1,
    });

    expect(snapshot.sessionCount).toBe(1);
    expect(snapshot.projects).toHaveLength(1);
    expect(snapshot.projects[0]?.name).toBe("repo");
    expect(snapshot.projects[0]?.worktrees).toHaveLength(1);
    expect(snapshot.projects[0]?.worktrees[0]?.processes).toHaveLength(2);
    expect(snapshot.totalCpuPct).toBe(15);
    expect(snapshot.totalRssBytes).toBe(350);
    // Non-terminal server child surfaces as orphan/unattributed.
    expect(snapshot.orphanCount).toBe(1);
    expect(snapshot.unattributed[0]?.pid).toBe(99);
    resetResourceSamplerForTesting();
  });

  it("buckets terminals outside managed worktrees as external", () => {
    const sample: ResourceSample = {
      at: 1_000,
      processes: [{ pid: 10, ppid: 1, rssBytes: 100, cpuSeconds: 1, command: "zsh", args: "" }],
    };
    const snapshot = buildResourceSnapshot({
      sample,
      cpuDeltas: new Map(),
      attribution: {
        terminals: [
          {
            threadId: "thread-1",
            terminalId: "main",
            cwd: "/tmp/scratch",
            status: "running",
            pid: 10,
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
        worktrees: [],
      },
      histories: new Map(),
      serverPid: 1,
    });
    expect(snapshot.projects[0]?.id).toBe("external");
    resetResourceSamplerForTesting();
  });

  it("counts the same terminal id in different threads as distinct sessions", () => {
    const worktreePath = "/repo/.synara/worktrees/abc";
    const sample: ResourceSample = {
      at: 1_000,
      processes: [
        { pid: 10, ppid: 1, rssBytes: 100, cpuSeconds: 1, command: "zsh", args: "" },
        { pid: 11, ppid: 10, rssBytes: 100, cpuSeconds: 1, command: "node", args: "app" },
        { pid: 20, ppid: 1, rssBytes: 100, cpuSeconds: 1, command: "zsh", args: "" },
      ],
    };
    const snapshot = buildResourceSnapshot({
      sample,
      cpuDeltas: new Map(),
      attribution: {
        terminals: [
          {
            threadId: "thread-1",
            terminalId: "main",
            cwd: worktreePath,
            status: "running",
            pid: 10,
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
          {
            threadId: "thread-2",
            terminalId: "main",
            cwd: worktreePath,
            status: "running",
            pid: 20,
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
        worktrees: [{ path: worktreePath, workspaceRoot: "/repo" }],
      },
      histories: new Map(),
      serverPid: 1,
    });

    expect(snapshot.sessionCount).toBe(2);
    expect(snapshot.projects[0]?.sessionCount).toBe(2);
    expect(snapshot.projects[0]?.worktrees[0]?.sessionCount).toBe(2);
  });
});

describe("buildResourceSnapshot provider attribution", () => {
  const worktrees = [{ path: "/repo/.synara/worktrees/abc", workspaceRoot: "/repo" }];

  it("places single-owner provider runtimes in the thread worktree", () => {
    const sample: ResourceSample = {
      at: 1_000,
      processes: [
        {
          pid: 50,
          ppid: 1,
          rssBytes: 300,
          cpuSeconds: 1,
          command: "codex",
          args: "codex app-server",
        },
        { pid: 51, ppid: 50, rssBytes: 100, cpuSeconds: 1, command: "node", args: "worker" },
      ],
    };
    const snapshot = buildResourceSnapshot({
      sample,
      cpuDeltas: new Map(),
      attribution: {
        terminals: [],
        worktrees,
        providers: [
          {
            pid: 50,
            provider: "codex",
            threadIds: ["thread-9"],
            commandBaseline: "codex app-server",
          },
        ],
        threadWorktrees: new Map([["thread-9", "/repo/.synara/worktrees/abc"]]),
      },
      histories: new Map(),
      serverPid: 1,
    });
    expect(snapshot.projects).toHaveLength(1);
    expect(snapshot.projects[0]?.name).toBe("repo");
    const rows = snapshot.projects[0]?.worktrees[0]?.processes ?? [];
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ provider: "codex", threadId: "thread-9" });
    expect(snapshot.orphanCount).toBe(0);
    resetResourceSamplerForTesting();
  });

  it("buckets shared provider servers under Providers/Shared", () => {
    const sample: ResourceSample = {
      at: 1_000,
      processes: [
        {
          pid: 60,
          ppid: 1,
          rssBytes: 400,
          cpuSeconds: 1,
          command: "opencode",
          args: "opencode serve --port 1",
        },
      ],
    };
    const snapshot = buildResourceSnapshot({
      sample,
      cpuDeltas: new Map(),
      attribution: {
        terminals: [],
        worktrees,
        providers: [{ pid: 60, provider: "OpenCode", threadIds: [], commandBaseline: null }],
        threadWorktrees: new Map(),
      },
      histories: new Map(),
      serverPid: 1,
    });
    expect(snapshot.projects).toHaveLength(1);
    expect(snapshot.projects[0]?.id).toBe("providers");
    expect(snapshot.projects[0]?.worktrees[0]?.name).toBe("Shared");
    expect(snapshot.projects[0]?.worktrees[0]?.processes[0]).toMatchObject({
      provider: "OpenCode",
    });
    resetResourceSamplerForTesting();
  });
});

describe("verifyProviderProcessRoots", () => {
  it("returns the first verified command as the provider baseline", async () => {
    runProcessMock.mockResolvedValue(successfulProcessResult("codex  app-server\n"));
    vi.spyOn(defaultProcessTreeKiller, "capture").mockReturnValue({
      descendants: [{ pid: 50, command: "codex app-server" }],
      captureComplete: true,
    });

    await expect(
      verifyProviderProcessRoots([
        {
          pid: 50,
          provider: "codex",
          threadIds: ["thread-9"],
          commandBaseline: null,
        },
      ]),
    ).resolves.toEqual([
      {
        pid: 50,
        provider: "codex",
        threadIds: ["thread-9"],
        commandBaseline: "codex  app-server",
      },
    ]);
  });

  it("drops an unbaselined provider outside the current server tree", async () => {
    runProcessMock.mockResolvedValue(successfulProcessResult("unrelated process\n"));
    const captureSpy = vi.spyOn(defaultProcessTreeKiller, "capture").mockReturnValue({
      descendants: [{ pid: 51, command: "codex app-server" }],
      captureComplete: true,
    });

    await expect(
      verifyProviderProcessRoots([
        {
          pid: 50,
          provider: "codex",
          threadIds: ["thread-9"],
          commandBaseline: null,
        },
      ]),
    ).resolves.toEqual([]);
    expect(captureSpy).toHaveBeenCalledOnce();
    expect(captureSpy).toHaveBeenCalledWith(process.pid);
  });
});

describe("killResourceProcessTree", () => {
  it("rejects a root whose command no longer matches the authorized identity", async () => {
    vi.useFakeTimers();
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    runProcessMock
      .mockResolvedValueOnce(successfulProcessResult("new-command\n"))
      .mockResolvedValueOnce({ ...successfulProcessResult(""), code: 1 });
    const captureSpy = vi
      .spyOn(defaultProcessTreeKiller, "capture")
      .mockReturnValue({ descendants: [], captureComplete: true });
    vi.spyOn(defaultProcessTreeKiller, "inspect").mockReturnValue({
      verified: true,
      survivors: [],
    });
    const signalSpy = vi
      .spyOn(defaultProcessTreeKiller, "signal")
      .mockImplementation(() => undefined);

    const resultPromise = killResourceProcessTree(42, "authorized-command");
    await vi.runAllTimersAsync();

    await expect(resultPromise).resolves.toEqual({
      pid: 42,
      killed: false,
      message: "Process identity changed.",
    });
    expect(captureSpy).not.toHaveBeenCalled();
    expect(signalSpy).not.toHaveBeenCalled();
  });

  it("uses the original captured identities when escalating reparented survivors", async () => {
    vi.useFakeTimers();
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    runProcessMock
      .mockResolvedValueOnce(successfulProcessResult("root-command\n"))
      .mockResolvedValueOnce({ ...successfulProcessResult(""), code: 1 })
      .mockResolvedValueOnce({ ...successfulProcessResult(""), code: 1 });
    const originalTree = {
      descendants: [{ pid: 43, command: "worker-command" }],
      captureComplete: true,
    };
    const captureSpy = vi
      .spyOn(defaultProcessTreeKiller, "capture")
      .mockReturnValueOnce(originalTree)
      .mockReturnValueOnce({ descendants: [], captureComplete: true });
    vi.spyOn(defaultProcessTreeKiller, "inspect")
      .mockReturnValueOnce({ verified: true, survivors: [...originalTree.descendants] })
      .mockReturnValueOnce({ verified: true, survivors: [] });
    const signalSpy = vi
      .spyOn(defaultProcessTreeKiller, "signal")
      .mockImplementation(() => undefined);

    const resultPromise = killResourceProcessTree(42);
    await vi.runAllTimersAsync();

    await expect(resultPromise).resolves.toEqual({ pid: 42, killed: true });
    expect(captureSpy).toHaveBeenCalledTimes(1);
    expect(signalSpy).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        rootPid: 42,
        signal: "SIGKILL",
        tree: originalTree,
        includeRootTree: false,
      }),
    );
    expect(signalSpy.mock.calls[1]?.[0].verifiedDescendants).not.toBe(true);
  });
});

describe("resource disk scans", () => {
  it("cancels scans only for the requested owner", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    const requests: Array<{
      signal: AbortSignal;
      resolve: (result: ReturnType<typeof successfulProcessResult>) => void;
    }> = [];
    runProcessMock.mockImplementation(
      (_command, _args, options) =>
        new Promise((resolve) => {
          if (!options?.signal) throw new Error("Expected a cancellable disk scan.");
          requests.push({ signal: options.signal, resolve });
        }),
    );
    const ownerA = {};
    const ownerB = {};

    const scanA = scanResourceDiskUsage(["/a"], ownerA);
    const scanB = scanResourceDiskUsage(["/b"], ownerB);
    expect(requests).toHaveLength(2);

    expect(cancelResourceDiskScan(ownerA)).toEqual({ cancelled: true });
    expect(requests[0]?.signal.aborted).toBe(true);
    expect(requests[1]?.signal.aborted).toBe(false);

    requests[0]?.resolve(successfulProcessResult("1 /a\n"));
    requests[1]?.resolve(successfulProcessResult("1 /b\n"));
    await Promise.all([scanA, scanB]);
  });

  it("keeps latest-call-wins behavior for the default owner", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    const requests: Array<{
      signal: AbortSignal;
      resolve: (result: ReturnType<typeof successfulProcessResult>) => void;
    }> = [];
    runProcessMock.mockImplementation(
      (_command, _args, options) =>
        new Promise((resolve) => {
          if (!options?.signal) throw new Error("Expected a cancellable disk scan.");
          requests.push({ signal: options.signal, resolve });
        }),
    );

    const firstScan = scanResourceDiskUsage(["/first"]);
    const secondScan = scanResourceDiskUsage(["/second"]);
    expect(requests[0]?.signal.aborted).toBe(true);
    expect(requests[1]?.signal.aborted).toBe(false);

    requests[0]?.resolve(successfulProcessResult("1 /first\n"));
    requests[1]?.resolve(successfulProcessResult("1 /second\n"));
    await Promise.all([firstScan, secondScan]);
  });
});
