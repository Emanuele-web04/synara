import { mkdtemp, mkdir, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ThreadId } from "@synara/contracts";
import { Effect } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  killResourceSession,
  requireResourceOwner,
  resolveResourceScanPaths,
  restartResourceProviders,
} from "./resourceActions";
import { CurrentWsSessionRole } from "./wsConnectionSessions";
import {
  killResourceProcessTree,
  readProcessCommand,
  verifyProviderProcessRoots,
} from "./resourceMonitor";
import { listRegisteredProviderProcesses } from "./providerProcessRegistry";
import { defaultProcessTreeKiller } from "./terminal/processTreeKiller";
import type { TerminalActiveSessionDescriptor } from "./terminal/Services/Manager";
import type { ProviderAdapterRegistryShape } from "./provider/Services/ProviderAdapterRegistry";

vi.mock("./resourceMonitor", () => ({
  killResourceProcessTree: vi.fn(async (pid: number) => ({ pid, killed: true })),
  readProcessCommand: vi.fn(async () => "owned command"),
  verifyProviderProcessRoots: vi.fn(async (roots) => roots),
}));
vi.mock("./providerProcessRegistry", () => ({ listRegisteredProviderProcesses: vi.fn(() => []) }));
vi.mock("./terminal/processTreeKiller", () => ({
  defaultProcessTreeKiller: { capture: vi.fn(() => ({ descendants: [], captureComplete: true })) },
}));

const terminal = (threadId: string, pid: number | null): TerminalActiveSessionDescriptor => ({
  threadId,
  terminalId: "default",
  pid,
  cwd: "/repo",
  status: pid === null ? "exited" : "running",
  updatedAt: "2026-09-14T00:00:00.000Z",
});
const manager = (sessions: TerminalActiveSessionDescriptor[]) => ({
  listActiveSessions: vi.fn(() => Effect.succeed(sessions)),
  close: vi.fn(() => Effect.void),
});
const runAsOwner = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.runPromise(effect.pipe(Effect.provideService(CurrentWsSessionRole, "owner")));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(defaultProcessTreeKiller.capture).mockReturnValue({
    descendants: [],
    captureComplete: true,
  });
  vi.mocked(readProcessCommand).mockResolvedValue("owned command");
  vi.mocked(listRegisteredProviderProcesses).mockReturnValue([]);
  vi.mocked(verifyProviderProcessRoots).mockImplementation(async (roots) => [...roots]);
});

describe("resource session ownership", () => {
  it("rejects an arbitrary host PID before calling the process killer", async () => {
    await expect(runAsOwner(killResourceSession({ pid: 4242 }, manager([])))).rejects.toThrow();
    expect(killResourceProcessTree).not.toHaveBeenCalled();
  });

  it("selects the terminal by thread as well as terminal ID", async () => {
    const terminals = manager([terminal("a", 110), terminal("b", 220)]);
    await runAsOwner(
      killResourceSession(
        { terminalId: "default", threadId: ThreadId.makeUnsafe("b"), pid: 220 },
        terminals,
      ),
    );
    expect(terminals.close).toHaveBeenCalledExactlyOnceWith(
      { threadId: "b", terminalId: "default" },
      220,
    );
  });

  it("rejects an ambiguous legacy terminal ID", async () => {
    const terminals = manager([terminal("a", 110), terminal("b", 220)]);
    await expect(
      runAsOwner(killResourceSession({ terminalId: "default" }, terminals)),
    ).rejects.toThrow();
    expect(terminals.close).not.toHaveBeenCalled();
  });

  it("rejects a PID that does not belong to the requested terminal", async () => {
    const terminals = manager([terminal("a", 110), terminal("b", 220)]);
    await expect(
      runAsOwner(
        killResourceSession(
          { terminalId: "default", threadId: ThreadId.makeUnsafe("a"), pid: 220 },
          terminals,
        ),
      ),
    ).rejects.toThrow();
    expect(terminals.close).not.toHaveBeenCalled();
  });

  it("accepts a child process row belonging to the selected terminal", async () => {
    const terminals = manager([terminal("a", 110)]);
    vi.mocked(defaultProcessTreeKiller.capture).mockImplementation((pid) => ({
      descendants: pid === 110 ? [{ pid: 111, command: "owned command" }] : [],
      captureComplete: true,
    }));
    await runAsOwner(
      killResourceSession(
        { terminalId: "default", threadId: ThreadId.makeUnsafe("a"), pid: 111 },
        terminals,
      ),
    );
    expect(terminals.close).toHaveBeenCalledExactlyOnceWith(
      { threadId: "a", terminalId: "default" },
      110,
    );
  });

  it("does not fall back to a caller's PID after a terminal exits", async () => {
    const terminals = manager([terminal("a", null)]);
    await expect(
      runAsOwner(killResourceSession({ terminalId: "default", pid: 4242 }, terminals)),
    ).rejects.toThrow();
    expect(killResourceProcessTree).not.toHaveBeenCalled();
  });

  it("passes a freshly captured server descendant identity to the killer", async () => {
    vi.mocked(defaultProcessTreeKiller.capture).mockImplementation((pid) => ({
      descendants: pid === process.pid ? [{ pid: 4242, command: "owned command" }] : [],
      captureComplete: true,
    }));
    await runAsOwner(killResourceSession({ pid: 4242 }, manager([])));
    expect(killResourceProcessTree).toHaveBeenCalledExactlyOnceWith(4242, "owned command");
  });

  it("preserves raw command whitespace after validating captured ancestry", async () => {
    vi.mocked(defaultProcessTreeKiller.capture).mockImplementation((pid) => ({
      descendants: pid === process.pid ? [{ pid: 4242, command: "owned command" }] : [],
      captureComplete: true,
    }));
    vi.mocked(readProcessCommand).mockResolvedValue("owned  command");
    await runAsOwner(killResourceSession({ pid: 4242 }, manager([])));
    expect(killResourceProcessTree).toHaveBeenCalledExactlyOnceWith(4242, "owned  command");
  });

  it("rejects a changed command between ancestry capture and authorization", async () => {
    vi.mocked(defaultProcessTreeKiller.capture).mockImplementation((pid) => ({
      descendants: pid === process.pid ? [{ pid: 4242, command: "owned command" }] : [],
      captureComplete: true,
    }));
    vi.mocked(readProcessCommand).mockResolvedValue("unrelated command");
    await expect(runAsOwner(killResourceSession({ pid: 4242 }, manager([])))).rejects.toThrow();
    expect(killResourceProcessTree).not.toHaveBeenCalled();
  });

  it("refuses to target the server itself", async () => {
    await expect(
      runAsOwner(killResourceSession({ pid: process.pid }, manager([]))),
    ).rejects.toThrow();
    expect(killResourceProcessTree).not.toHaveBeenCalled();
  });

  it("allows a unique legacy terminal selected by PID", async () => {
    const terminals = manager([terminal("a", 110), terminal("b", 220)]);
    await runAsOwner(killResourceSession({ terminalId: "default", pid: 220 }, terminals));
    expect(terminals.close).toHaveBeenCalledExactlyOnceWith(
      { threadId: "b", terminalId: "default" },
      220,
    );
  });

  it("rejects registry-only ownership even with a matching learned command baseline", async () => {
    vi.mocked(listRegisteredProviderProcesses).mockReturnValue([
      {
        pid: 4242,
        provider: "opencode",
        threadIds: [],
        commandBaseline: "opencode serve",
        registeredAt: 0,
      },
    ]);
    await expect(runAsOwner(killResourceSession({ pid: 4242 }, manager([])))).rejects.toThrow();
    expect(killResourceProcessTree).not.toHaveBeenCalled();
  });

  it("rejects a stale provider registration that fails live verification", async () => {
    vi.mocked(listRegisteredProviderProcesses).mockReturnValue([
      {
        pid: 4242,
        provider: "opencode",
        threadIds: [],
        commandBaseline: "old command",
        registeredAt: 0,
      },
    ]);
    vi.mocked(verifyProviderProcessRoots).mockResolvedValue([]);
    await expect(runAsOwner(killResourceSession({ pid: 4242 }, manager([])))).rejects.toThrow();
    expect(killResourceProcessTree).not.toHaveBeenCalled();
  });

  it("rejects client-role requests before inspecting or closing terminals", async () => {
    const terminals = manager([terminal("a", 110)]);
    await expect(
      Effect.runPromise(killResourceSession({ terminalId: "default" }, terminals)),
    ).rejects.toThrow("Owner authorization");
    expect(terminals.listActiveSessions).not.toHaveBeenCalled();
    expect(terminals.close).not.toHaveBeenCalled();
  });
});

describe("resource provider restart", () => {
  it("stops registered idle providers even with no active sessions", async () => {
    const stopAll = vi.fn(() => Effect.void);
    const registry = {
      listProviders: vi.fn(() => Effect.succeed(["opencode"])),
      getByProvider: vi.fn(() => Effect.succeed({ stopAll })),
    } as unknown as ProviderAdapterRegistryShape;
    await runAsOwner(
      restartResourceProviders(
        { listSessions: () => Effect.succeed([]), stopSession: () => Effect.void },
        registry,
      ),
    );
    expect(stopAll).toHaveBeenCalledOnce();
  });

  it("attempts every provider but reports failure if one runtime cannot stop", async () => {
    const stopFailed = vi.fn(() => Effect.fail(new Error("runtime busy")));
    const stopHealthy = vi.fn(() => Effect.void);
    const registry = {
      listProviders: () => Effect.succeed(["opencode", "codex"]),
      getByProvider: (provider: string) =>
        Effect.succeed({ stopAll: provider === "opencode" ? stopFailed : stopHealthy }),
    } as unknown as ProviderAdapterRegistryShape;
    await expect(
      runAsOwner(
        restartResourceProviders(
          { listSessions: () => Effect.succeed([]), stopSession: () => Effect.void },
          registry,
        ),
      ),
    ).rejects.toThrow("could not be stopped");
    expect(stopFailed).toHaveBeenCalledOnce();
    expect(stopHealthy).toHaveBeenCalledOnce();
  });
});

describe("resource disk scan scope", () => {
  let fixtureRoot: string;
  let storage: string;
  let workspace: string;
  let outside: string;

  beforeAll(async () => {
    fixtureRoot = await mkdtemp(path.join(tmpdir(), "synara-resource-actions-"));
    storage = path.join(fixtureRoot, "worktrees");
    workspace = path.join(storage, "workspace");
    outside = path.join(fixtureRoot, "worktrees-other");
    await mkdir(workspace, { recursive: true });
    await mkdir(outside);
    await symlink(
      outside,
      path.join(storage, "escape"),
      process.platform === "win32" ? "junction" : "dir",
    );
  });
  afterAll(async () => {
    if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true });
  });

  it("defaults to managed storage and accepts its workspaces", async () => {
    await expect(resolveResourceScanPaths(undefined, storage)).resolves.toEqual([
      await realpath(storage),
    ]);
    await expect(resolveResourceScanPaths([workspace, workspace], storage)).resolves.toEqual([
      await realpath(workspace),
    ]);
  });
  it("rejects sibling paths and traversal", async () => {
    await expect(resolveResourceScanPaths([outside], storage)).rejects.toThrow(
      "managed worktree storage",
    );
    await expect(resolveResourceScanPaths([path.join(storage, "..")], storage)).rejects.toThrow(
      "managed worktree storage",
    );
  });
  it("rejects symlinks escaping managed storage", async () => {
    await expect(resolveResourceScanPaths([path.join(storage, "escape")], storage)).rejects.toThrow(
      "managed worktree storage",
    );
  });
  it("requires the owner role for resource management", async () => {
    await expect(Effect.runPromise(requireResourceOwner)).rejects.toThrow("Owner authorization");
    await expect(runAsOwner(requireResourceOwner)).resolves.toBeUndefined();
  });
});
