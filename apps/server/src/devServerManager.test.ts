// FILE: devServerManager.test.ts
// Purpose: Covers project dev-server registry helpers without starting PTYs.
// Layer: Server unit tests for DevServerManager support logic.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import {
  DEFAULT_TERMINAL_ID,
  ProjectId,
  WorktreeWorkspaceId,
  type ProjectDevServer,
  type ServerLocalServerProcess,
  type TerminalEvent,
  type TerminalSessionSnapshot,
} from "@synara/contracts";
import { Effect, Fiber, Layer, Stream } from "effect";

import {
  DevServerManager,
  DevServerManagerLive,
  devServerTerminalCommand,
  findProjectDevServerForLocalServer,
} from "./devServerManager";
import {
  TerminalManager,
  TerminalError,
  type TerminalManagerShape,
} from "./terminal/Services/Manager";

const execFileAsync = promisify(execFile);

function makeDevServer(overrides: Partial<ProjectDevServer> = {}): ProjectDevServer {
  return {
    projectId: ProjectId.makeUnsafe("project-1"),
    workspaceId: WorktreeWorkspaceId.makeUnsafe("workspace-1"),
    command: "pnpm run dev",
    cwd: "/repo/app",
    pid: 100,
    startedAt: "2026-01-01T00:00:00.000Z",
    status: "running",
    ...overrides,
  };
}

type TerminalOpenCall = Parameters<TerminalManagerShape["open"]>[0];
type TerminalWriteCall = Parameters<TerminalManagerShape["write"]>[0];
type TerminalCloseCall = Parameters<TerminalManagerShape["close"]>[0];

function makeTerminalManagerDouble() {
  const openCalls: TerminalOpenCall[] = [];
  const writeCalls: TerminalWriteCall[] = [];
  const closeCalls: TerminalCloseCall[] = [];
  let listener: ((event: TerminalEvent) => void) | null = null;
  let nextPid = 4_000;

  const service: TerminalManagerShape = {
    open: (input) => {
      openCalls.push(input);
      const snapshot: TerminalSessionSnapshot = {
        threadId: input.threadId,
        terminalId: input.terminalId ?? DEFAULT_TERMINAL_ID,
        cwd: input.cwd,
        status: "running",
        pid: nextPid++,
        history: "",
        exitCode: null,
        exitSignal: null,
        updatedAt: "2026-07-16T00:00:00.000Z",
      };
      return Effect.succeed(snapshot);
    },
    write: (input) => {
      writeCalls.push(input);
      return Effect.void;
    },
    close: (input) => {
      closeCalls.push(input);
      return Effect.void;
    },
    subscribe: (nextListener) =>
      Effect.sync(() => {
        listener = nextListener;
        return () => {
          if (listener === nextListener) {
            listener = null;
          }
        };
      }),
    ackOutput: () => Effect.void,
    resize: () => Effect.void,
    clear: () => Effect.void,
    restart: () => Effect.die("restart is not used by dev-server tests"),
    dispose: Effect.void,
  };

  return {
    service,
    openCalls,
    writeCalls,
    closeCalls,
    emitExit(threadId: string) {
      listener?.({
        type: "exited",
        threadId,
        terminalId: DEFAULT_TERMINAL_ID,
        createdAt: "2026-07-16T00:00:01.000Z",
        exitCode: 1,
        exitSignal: null,
      });
    },
    emitError(threadId: string, message: string) {
      listener?.({
        type: "error",
        threadId,
        terminalId: DEFAULT_TERMINAL_ID,
        createdAt: "2026-07-16T00:00:01.000Z",
        message,
      });
    },
  };
}

function workspaceTarget(workspaceId: string) {
  return {
    projectId: ProjectId.makeUnsafe("project-1"),
    workspaceId: WorktreeWorkspaceId.makeUnsafe(workspaceId),
  };
}

function runWithDevServerManager<A>(
  terminal: TerminalManagerShape,
  effect: Effect.Effect<A, TerminalError, DevServerManager>,
): Promise<A> {
  const layer = DevServerManagerLive.pipe(Layer.provide(Layer.succeed(TerminalManager, terminal)));
  return Effect.runPromise(effect.pipe(Effect.provide(layer), Effect.scoped));
}

function makeLocalServer(
  overrides: Partial<ServerLocalServerProcess> = {},
): ServerLocalServerProcess {
  return {
    id: "200:5173",
    pid: 200,
    command: "node",
    displayName: "Vite",
    args: "node ./node_modules/.bin/vite",
    ports: [5173],
    addresses: [{ host: "127.0.0.1", port: 5173, url: "http://127.0.0.1:5173", family: "tcp4" }],
    isStoppable: true,
    ...overrides,
  };
}

describe("findProjectDevServerForLocalServer", () => {
  it("matches a local server owned by the tracked PTY pid", () => {
    const devServer = makeDevServer({ pid: 200 });

    expect(
      findProjectDevServerForLocalServer({
        localServer: makeLocalServer({ pid: 200 }),
        devServers: [devServer],
      }),
    ).toBe(devServer);
  });

  it("uses the shared local-server ownership rule for cwd matches", () => {
    const devServer = makeDevServer({ cwd: "/repo/app", pid: null });

    expect(
      findProjectDevServerForLocalServer({
        localServer: makeLocalServer({ cwd: "/repo/app/packages/web", pid: 200 }),
        devServers: [devServer],
      }),
    ).toBe(devServer);
  });

  it("does not match sibling folders with the same prefix", () => {
    expect(
      findProjectDevServerForLocalServer({
        localServer: makeLocalServer({ cwd: "/repo/app-other" }),
        devServers: [makeDevServer({ cwd: "/repo/app" })],
      }),
    ).toBeNull();
  });

  it("prefers process lineage and then the deepest matching workspace", () => {
    const repositoryRoot = makeDevServer({
      workspaceId: WorktreeWorkspaceId.makeUnsafe("repository-root"),
      cwd: "/repo",
      pid: 100,
    });
    const workspace = makeDevServer({
      workspaceId: WorktreeWorkspaceId.makeUnsafe("workspace-1"),
      cwd: "/repo/worktrees/one",
      pid: 200,
    });

    expect(
      findProjectDevServerForLocalServer({
        localServer: makeLocalServer({ cwd: "/repo/worktrees/one/apps/web", ppid: 200 }),
        devServers: [repositoryRoot, workspace],
      }),
    ).toBe(workspace);
    expect(
      findProjectDevServerForLocalServer({
        localServer: makeLocalServer({ cwd: "/repo/worktrees/one/apps/web" }),
        devServers: [repositoryRoot, workspace],
      }),
    ).toBe(workspace);
  });
});

describe("DevServerManager", () => {
  it("uses PowerShell syntax and preserves native exit codes on Windows", () => {
    expect(devServerTerminalCommand("bun run dev", "win32")).toBe(
      "& { bun run dev }; $__synara_success = $?; $__synara_exit_code = $LASTEXITCODE; if (-not $__synara_success) { if ($null -ne $__synara_exit_code -and $__synara_exit_code -ne 0) { exit $__synara_exit_code }; exit 1 }; exit 0",
    );
  });

  it.skipIf(process.platform === "win32")(
    "exits the synthetic shell with the dev command status",
    async () => {
      await expect(
        execFileAsync("/bin/sh", ["-c", devServerTerminalCommand("exit 23", "darwin")]),
      ).rejects.toMatchObject({ code: 23 });
    },
  );

  it("keeps two workspace runs in the reconnect snapshot and forwards cwd and env", async () => {
    const terminal = makeTerminalManagerDouble();
    const first = workspaceTarget("workspace-1");
    const second = workspaceTarget("workspace-2");

    const snapshot = await runWithDevServerManager(
      terminal.service,
      Effect.gen(function* () {
        const manager = yield* DevServerManager;
        yield* manager.run({
          ...first,
          command: "bun run dev",
          cwd: "/repo/worktrees/one",
          env: {
            SYNARA_PROJECT_ROOT: "/repo",
            SYNARA_WORKTREE_PATH: "/repo/worktrees/one",
          },
        });
        yield* manager.run({
          ...second,
          command: "bun run dev --port 4001",
          cwd: "/repo/worktrees/two",
          env: {
            SYNARA_PROJECT_ROOT: "/repo",
            SYNARA_WORKTREE_PATH: "/repo/worktrees/two",
          },
        });
        return yield* manager.list;
      }),
    );

    expect(snapshot.servers).toHaveLength(2);
    expect(snapshot.servers.map((server) => server.workspaceId)).toEqual([
      "workspace-1",
      "workspace-2",
    ]);
    expect(terminal.openCalls).toMatchObject([
      {
        cwd: "/repo/worktrees/one",
        env: {
          SYNARA_PROJECT_ROOT: "/repo",
          SYNARA_WORKTREE_PATH: "/repo/worktrees/one",
        },
      },
      {
        cwd: "/repo/worktrees/two",
        env: {
          SYNARA_PROJECT_ROOT: "/repo",
          SYNARA_WORKTREE_PATH: "/repo/worktrees/two",
        },
      },
    ]);
    expect(terminal.openCalls[0]?.threadId).not.toBe(terminal.openCalls[1]?.threadId);
    expect(terminal.writeCalls.map((call) => call.data)).toEqual([
      "(bun run dev); __synara_exit_code=$?; exit $__synara_exit_code\r",
      "(bun run dev --port 4001); __synara_exit_code=$?; exit $__synara_exit_code\r",
    ]);
  });

  it("reaps an exact workspace when its command exits during launch", async () => {
    const terminal = makeTerminalManagerDouble();
    const target = workspaceTarget("workspace-fast-exit");
    const service: TerminalManagerShape = {
      ...terminal.service,
      write: (input) =>
        terminal.service
          .write(input)
          .pipe(Effect.tap(() => Effect.sync(() => terminal.emitExit(input.threadId)))),
    };

    const result = await runWithDevServerManager(
      service,
      Effect.gen(function* () {
        const manager = yield* DevServerManager;
        const eventsFiber = yield* Stream.runCollect(Stream.take(manager.stream, 2)).pipe(
          Effect.forkChild,
        );
        yield* Effect.yieldNow;
        yield* manager.run({ ...target, command: "exit 1", cwd: "/repo/fast-exit" });
        const events = Array.from(yield* Fiber.join(eventsFiber));
        const snapshot = yield* manager.list;
        return { events, snapshot };
      }),
    );

    expect(result.snapshot.servers).toEqual([]);
    expect(result.events).toMatchObject([
      { type: "upserted", server: { workspaceId: "workspace-fast-exit" } },
      {
        type: "removed",
        workspaceId: "workspace-fast-exit",
        reason: "exited",
        exitCode: 1,
      },
    ]);
  });

  it("removes a failed launch after its terminal closes successfully", async () => {
    const terminal = makeTerminalManagerDouble();
    const target = workspaceTarget("workspace-write-failed");
    const service: TerminalManagerShape = {
      ...terminal.service,
      write: (input) =>
        terminal.service
          .write(input)
          .pipe(Effect.andThen(Effect.fail(new TerminalError({ message: "PTY write failed" })))),
    };

    const result = await runWithDevServerManager(
      service,
      Effect.gen(function* () {
        const manager = yield* DevServerManager;
        const launched = yield* Effect.exit(
          manager.run({ ...target, command: "dev one", cwd: "/repo/one" }),
        );
        const snapshot = yield* manager.list;
        return { launched, snapshot };
      }),
    );

    expect(result.launched._tag).toBe("Failure");
    expect(result.snapshot.servers).toEqual([]);
    expect(terminal.closeCalls).toHaveLength(1);
  });

  it("keeps a failed launch registered when its terminal cannot be closed", async () => {
    const terminal = makeTerminalManagerDouble();
    const target = workspaceTarget("workspace-write-close-failed");
    const service: TerminalManagerShape = {
      ...terminal.service,
      write: (input) =>
        terminal.service
          .write(input)
          .pipe(Effect.andThen(Effect.fail(new TerminalError({ message: "PTY write failed" })))),
      close: (input) =>
        terminal.service
          .close(input)
          .pipe(Effect.andThen(Effect.fail(new TerminalError({ message: "PTY close failed" })))),
    };

    const result = await runWithDevServerManager(
      service,
      Effect.gen(function* () {
        const manager = yield* DevServerManager;
        const launched = yield* Effect.exit(
          manager.run({ ...target, command: "dev one", cwd: "/repo/one" }),
        );
        const snapshot = yield* manager.list;
        return { launched, snapshot };
      }),
    );

    expect(result.launched._tag).toBe("Failure");
    expect(result.snapshot.servers).toMatchObject([
      { workspaceId: "workspace-write-close-failed", command: "dev one" },
    ]);
    expect(terminal.closeCalls).toHaveLength(1);
  });

  it("stops only the selected workspace run", async () => {
    const terminal = makeTerminalManagerDouble();
    const first = workspaceTarget("workspace-1");
    const second = workspaceTarget("workspace-2");

    const result = await runWithDevServerManager(
      terminal.service,
      Effect.gen(function* () {
        const manager = yield* DevServerManager;
        yield* manager.run({ ...first, command: "dev one", cwd: "/repo/one" });
        yield* manager.run({ ...second, command: "dev two", cwd: "/repo/two" });
        const stopped = yield* manager.stop(first);
        const snapshot = yield* manager.list;
        return { stopped, snapshot };
      }),
    );

    expect(result.stopped).toEqual({ stopped: true });
    expect(result.snapshot.servers).toMatchObject([{ workspaceId: "workspace-2" }]);
    expect(terminal.closeCalls).toHaveLength(1);
    expect(terminal.closeCalls[0]?.threadId).toBe(terminal.openCalls[0]?.threadId);
  });

  it("keeps a run registered and reports failure when terminal close fails", async () => {
    const terminal = makeTerminalManagerDouble();
    const target = workspaceTarget("workspace-1");
    let failClose = false;
    const service: TerminalManagerShape = {
      ...terminal.service,
      close: (input) =>
        failClose
          ? Effect.fail(new TerminalError({ message: "PTY close failed" }))
          : terminal.service.close(input),
    };

    const result = await runWithDevServerManager(
      service,
      Effect.gen(function* () {
        const manager = yield* DevServerManager;
        yield* manager.run({ ...target, command: "dev one", cwd: "/repo/one" });
        failClose = true;
        const stopped = yield* Effect.exit(manager.stop(target));
        const snapshot = yield* manager.list;
        return { stopped, snapshot };
      }),
    );

    expect(result.stopped._tag).toBe("Failure");
    expect(result.snapshot.servers).toMatchObject([
      { workspaceId: "workspace-1", command: "dev one" },
    ]);
  });

  it("does not replace an existing run when closing it fails", async () => {
    const terminal = makeTerminalManagerDouble();
    const target = workspaceTarget("workspace-1");
    let failClose = false;
    const service: TerminalManagerShape = {
      ...terminal.service,
      close: (input) =>
        failClose
          ? Effect.fail(new TerminalError({ message: "PTY close failed" }))
          : terminal.service.close(input),
    };

    const result = await runWithDevServerManager(
      service,
      Effect.gen(function* () {
        const manager = yield* DevServerManager;
        yield* manager.run({ ...target, command: "dev old", cwd: "/repo/one" });
        failClose = true;
        const replacement = yield* Effect.exit(
          manager.run({ ...target, command: "dev replacement", cwd: "/repo/one" }),
        );
        const snapshot = yield* manager.list;
        return { replacement, snapshot };
      }),
    );

    expect(result.replacement._tag).toBe("Failure");
    expect(terminal.openCalls).toHaveLength(1);
    expect(result.snapshot.servers).toMatchObject([
      { workspaceId: "workspace-1", command: "dev old" },
    ]);
  });

  it("serializes concurrent run and stop operations for one target", async () => {
    const terminal = makeTerminalManagerDouble();
    const target = workspaceTarget("workspace-1");
    let signalCloseStarted: () => void = () => {};
    let releaseClose: () => void = () => {};
    const closeStarted = new Promise<void>((resolve) => {
      signalCloseStarted = resolve;
    });
    const closeReleased = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    const service: TerminalManagerShape = {
      ...terminal.service,
      close: (input) =>
        terminal.service.close(input).pipe(
          Effect.tap(() => Effect.sync(signalCloseStarted)),
          Effect.andThen(Effect.promise(() => closeReleased)),
        ),
    };

    const result = await runWithDevServerManager(
      service,
      Effect.gen(function* () {
        const manager = yield* DevServerManager;
        yield* manager.run({ ...target, command: "dev old", cwd: "/repo/one" });
        const replacement = yield* manager
          .run({ ...target, command: "dev replacement", cwd: "/repo/one" })
          .pipe(Effect.forkChild);
        yield* Effect.promise(() => closeStarted);
        const stopped = yield* manager.stop(target).pipe(Effect.forkChild);
        yield* Effect.sleep("10 millis");
        const countsWhileBlocked = {
          close: terminal.closeCalls.length,
          open: terminal.openCalls.length,
        };
        releaseClose();
        yield* Fiber.join(replacement);
        const stopResult = yield* Fiber.join(stopped);
        const snapshot = yield* manager.list;
        return { countsWhileBlocked, stopResult, snapshot };
      }),
    );

    expect(result.countsWhileBlocked).toEqual({ close: 1, open: 1 });
    expect(result.stopResult).toEqual({ stopped: true });
    expect(terminal.closeCalls).toHaveLength(2);
    expect(result.snapshot.servers).toEqual([]);
  });

  it("reaps only the workspace whose synthetic terminal exits and preserves exit detail", async () => {
    const terminal = makeTerminalManagerDouble();
    const first = workspaceTarget("workspace-1");
    const second = workspaceTarget("workspace-2");

    const result = await runWithDevServerManager(
      terminal.service,
      Effect.gen(function* () {
        const manager = yield* DevServerManager;
        yield* manager.run({ ...first, command: "dev one", cwd: "/repo/one" });
        yield* manager.run({ ...second, command: "dev two", cwd: "/repo/two" });
        const eventFiber = yield* Stream.runCollect(Stream.take(manager.stream, 1)).pipe(
          Effect.forkChild,
        );
        yield* Effect.yieldNow;
        terminal.emitExit(terminal.openCalls[0]?.threadId ?? "");
        const events = Array.from(yield* Fiber.join(eventFiber));
        const snapshot = yield* manager.list;
        return { events, snapshot };
      }),
    );

    expect(result.snapshot.servers).toMatchObject([{ workspaceId: "workspace-2" }]);
    expect(result.events).toEqual([
      {
        type: "removed",
        projectId: "project-1",
        workspaceId: "workspace-1",
        reason: "exited",
        exitCode: 1,
        exitSignal: null,
      },
    ]);
  });

  it("preserves terminal error detail on the removed event", async () => {
    const terminal = makeTerminalManagerDouble();
    const target = workspaceTarget("workspace-1");

    const events = await runWithDevServerManager(
      terminal.service,
      Effect.gen(function* () {
        const manager = yield* DevServerManager;
        yield* manager.run({ ...target, command: "dev one", cwd: "/repo/one" });
        const eventFiber = yield* Stream.runCollect(Stream.take(manager.stream, 1)).pipe(
          Effect.forkChild,
        );
        yield* Effect.yieldNow;
        terminal.emitError(
          terminal.openCalls[0]?.threadId ?? "",
          "listen EADDRINUSE: address already in use",
        );
        return Array.from(yield* Fiber.join(eventFiber));
      }),
    );

    expect(events).toEqual([
      {
        type: "removed",
        projectId: "project-1",
        workspaceId: "workspace-1",
        reason: "exited",
        message: "listen EADDRINUSE: address already in use",
      },
    ]);
  });

  it("ignores a delayed exit from a run that has already been replaced", async () => {
    const terminal = makeTerminalManagerDouble();
    const target = workspaceTarget("workspace-1");

    const snapshot = await runWithDevServerManager(
      terminal.service,
      Effect.gen(function* () {
        const manager = yield* DevServerManager;
        yield* manager.run({ ...target, command: "dev old", cwd: "/repo/one" });
        const staleThreadId = terminal.openCalls[0]?.threadId ?? "";
        yield* manager.run({ ...target, command: "dev replacement", cwd: "/repo/one" });

        expect(terminal.openCalls[1]?.threadId).not.toBe(staleThreadId);
        terminal.emitExit(staleThreadId);
        yield* Effect.sleep("10 millis");
        return yield* manager.list;
      }),
    );

    expect(snapshot.servers).toMatchObject([
      {
        workspaceId: "workspace-1",
        command: "dev replacement",
        pid: 4_001,
      },
    ]);
  });
});
