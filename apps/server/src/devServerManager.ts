/**
 * DevServerManager - Server-owned dev-server process orchestration.
 *
 * Dev servers are first-class background processes keyed by project/workspace
 * target, fully decoupled from chat threads. Each runs in a managed PTY (via
 * TerminalManager) under a synthetic thread so its lifetime survives WebSocket
 * reconnects and never clutters the thread list. The manager keeps an in-memory
 * registry, broadcasts changes over a PubSub for the `project.devServerEvent`
 * push channel, and reaps entries when their exact PTY exits.
 *
 * @module DevServerManager
 */
import {
  DEFAULT_TERMINAL_ID,
  type ProjectDevServer,
  type ProjectDevServerEvent,
  type ProjectListDevServersResult,
  type ProjectRunDevServerInput,
  type ProjectRunDevServerResult,
  type ProjectStopDevServerInput,
  type ProjectStopDevServerResult,
  type ServerLocalServerProcess,
} from "@synara/contracts";
import { localServerMatchesRun } from "@synara/shared/localServers";
import {
  projectDevServerTargetKey,
  type ProjectDevServerTargetKey,
} from "@synara/shared/projectDevServers";
import { Effect, Layer, PubSub, Ref, Semaphore, ServiceMap, Stream } from "effect";

import { TerminalManager, type TerminalError } from "./terminal/Services/Manager";

// Dev servers reuse the terminal infrastructure under a reserved synthetic
// thread namespace so their PTYs never collide with real chat-thread terminals.
const DEV_SERVER_THREAD_PREFIX = "dev-server:";
const DEV_SERVER_TERMINAL_COLS = 120;
const DEV_SERVER_TERMINAL_ROWS = 30;

const devServerThreadId = (): string => `${DEV_SERVER_THREAD_PREFIX}${crypto.randomUUID()}`;

export function devServerTerminalCommand(
  command: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === "win32") {
    return `& { ${command} }; $__synara_success = $?; $__synara_exit_code = $LASTEXITCODE; if (-not $__synara_success) { if ($null -ne $__synara_exit_code -and $__synara_exit_code -ne 0) { exit $__synara_exit_code }; exit 1 }; exit 0`;
  }
  return `(${command}); __synara_exit_code=$?; exit $__synara_exit_code`;
}

interface TrackedProjectDevServer {
  readonly server: ProjectDevServer;
  readonly threadId: string;
}

interface ProjectDevServerExitDetail {
  readonly exitCode?: number | null;
  readonly exitSignal?: number | null;
  readonly message?: string;
}

export function findProjectDevServerForLocalServer(input: {
  localServer: ServerLocalServerProcess;
  devServers: readonly ProjectDevServer[];
}): ProjectDevServer | null {
  // Process lineage is authoritative when available, regardless of registry
  // insertion order or overlapping workspace roots.
  for (const devServer of input.devServers) {
    if (
      devServer.pid !== null &&
      (input.localServer.pid === devServer.pid || input.localServer.ppid === devServer.pid)
    ) {
      return devServer;
    }
  }

  // Child processes can obscure the original PTY pid. In that case choose the
  // deepest matching cwd so a repository-root run cannot steal a listener from
  // a more specific workspace run.
  let bestMatch: ProjectDevServer | null = null;
  for (const devServer of input.devServers) {
    if (
      localServerMatchesRun(input.localServer, devServer) &&
      (bestMatch === null || devServer.cwd.length > bestMatch.cwd.length)
    ) {
      bestMatch = devServer;
    }
  }
  return bestMatch;
}

export interface DevServerManagerShape {
  /** Start (or restart) the dev server for one project/workspace target. */
  readonly run: (
    input: ProjectRunDevServerInput,
  ) => Effect.Effect<ProjectRunDevServerResult, TerminalError>;
  /** Stop one exact project/workspace target. Resolves with whether it was running. */
  readonly stop: (
    input: ProjectStopDevServerInput,
  ) => Effect.Effect<ProjectStopDevServerResult, TerminalError>;
  /** Snapshot of all currently tracked dev servers. */
  readonly list: Effect.Effect<ProjectListDevServersResult>;
  /** Live stream of dev-server lifecycle events (excludes the initial snapshot). */
  readonly stream: Stream.Stream<ProjectDevServerEvent>;
}

export class DevServerManager extends ServiceMap.Service<DevServerManager, DevServerManagerShape>()(
  "synara/devServerManager",
) {}

export const DevServerManagerLive = Layer.effect(
  DevServerManager,
  Effect.gen(function* () {
    const terminalManager = yield* TerminalManager;
    const pubsub = yield* Effect.acquireRelease(
      PubSub.unbounded<ProjectDevServerEvent>(),
      PubSub.shutdown,
    );
    const registry = yield* Ref.make<Record<ProjectDevServerTargetKey, TrackedProjectDevServer>>(
      {},
    );
    const targetLocks = new Map<ProjectDevServerTargetKey, Semaphore.Semaphore>();

    const withTargetLock = <A, E, R>(
      targetKey: ProjectDevServerTargetKey,
      effect: Effect.Effect<A, E, R>,
    ) => {
      let lock = targetLocks.get(targetKey);
      if (!lock) {
        lock = Semaphore.makeUnsafe(1);
        targetLocks.set(targetKey, lock);
      }
      return lock.withPermits(1)(effect);
    };

    const publish = (event: ProjectDevServerEvent) => PubSub.publish(pubsub, event);

    // Reap a tracked dev server whose PTY exited or errored. The target lock and
    // thread identity guard keep deliberate stops and replacements from
    // double-publishing or removing a newer run.
    const reapExited = (threadId: string, detail: ProjectDevServerExitDetail) =>
      Effect.gen(function* () {
        const matchedEntry = Object.entries(yield* Ref.get(registry)).find(
          ([, tracked]) => tracked.threadId === threadId,
        );
        if (!matchedEntry) {
          return;
        }
        const targetKey = matchedEntry[0] as ProjectDevServerTargetKey;
        yield* withTargetLock(
          targetKey,
          Ref.modify(registry, (current) => {
            const tracked = current[targetKey];
            if (!tracked || tracked.threadId !== threadId) {
              return [null, current] as const;
            }
            const next = { ...current };
            delete next[targetKey];
            return [tracked.server, next] as const;
          }).pipe(
            Effect.flatMap((removed) =>
              removed
                ? publish({
                    type: "removed",
                    projectId: removed.projectId,
                    workspaceId: removed.workspaceId,
                    reason: "exited",
                    ...detail,
                  })
                : Effect.void,
            ),
          ),
        );
      });

    const unsubscribe = yield* terminalManager.subscribe((event) => {
      if (event.type !== "exited" && event.type !== "error") {
        return;
      }
      const detail: ProjectDevServerExitDetail =
        event.type === "exited"
          ? { exitCode: event.exitCode, exitSignal: event.exitSignal }
          : { message: event.message };
      Effect.runFork(reapExited(event.threadId, detail));
    });
    yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));

    const run: DevServerManagerShape["run"] = (input) => {
      const targetKey = projectDevServerTargetKey(input);
      return withTargetLock(
        targetKey,
        Effect.gen(function* () {
          // If a dev server is already tracked for this exact target, tear its PTY
          // down first so the command always lands in a fresh shell. Other
          // workspaces in the project remain independent.
          const existing = (yield* Ref.get(registry))[targetKey];
          if (existing) {
            yield* terminalManager.close({ threadId: existing.threadId, deleteHistory: true });
            const removed = yield* Ref.modify(registry, (current) => {
              if (current[targetKey]?.threadId !== existing.threadId) {
                return [false, current] as const;
              }
              const next = { ...current };
              delete next[targetKey];
              return [true, next] as const;
            });
            if (removed) {
              yield* publish({
                type: "removed",
                projectId: input.projectId,
                workspaceId: input.workspaceId,
                reason: "stopped",
              });
            }
          }

          // Every launch receives a fresh terminal identity. A delayed exit from
          // the previous PTY therefore cannot reap the replacement run.
          const threadId = devServerThreadId();

          const snapshot = yield* terminalManager.open({
            threadId,
            terminalId: DEFAULT_TERMINAL_ID,
            cwd: input.cwd,
            cols: DEV_SERVER_TERMINAL_COLS,
            rows: DEV_SERVER_TERMINAL_ROWS,
            // Dev servers are headless: drain + retain history, but never broadcast
            // their continuous output to clients that have no terminal UI for them.
            streamOutput: false,
            ...(input.env ? { env: input.env } : {}),
          });

          const server: ProjectDevServer = {
            projectId: input.projectId,
            workspaceId: input.workspaceId,
            command: input.command,
            cwd: input.cwd,
            pid: snapshot.pid,
            startedAt: new Date().toISOString(),
            status: "running",
          };
          yield* Ref.update(registry, (current) => ({
            ...current,
            [targetKey]: { server, threadId },
          }));

          // Register before sending input so an immediately failing command cannot emit its PTY
          // exit before the reaper knows which workspace owns it. The single shell line exits the
          // synthetic shell with the command's status instead of returning to an idle prompt.
          yield* terminalManager
            .write({
              threadId,
              terminalId: DEFAULT_TERMINAL_ID,
              data: `${devServerTerminalCommand(input.command)}\r`,
            })
            .pipe(
              Effect.catch((error) =>
                terminalManager.close({ threadId, deleteHistory: true }).pipe(
                  Effect.andThen(
                    Ref.update(registry, (current) => {
                      if (current[targetKey]?.threadId !== threadId) return current;
                      const next = { ...current };
                      delete next[targetKey];
                      return next;
                    }),
                  ),
                  Effect.andThen(Effect.fail(error)),
                ),
              ),
            );
          yield* publish({ type: "upserted", server });
          return { server };
        }),
      );
    };

    const stop: DevServerManagerShape["stop"] = (input) => {
      const targetKey = projectDevServerTargetKey(input);
      return withTargetLock(
        targetKey,
        Effect.gen(function* () {
          const tracked = (yield* Ref.get(registry))[targetKey];
          if (!tracked) {
            return { stopped: false };
          }

          // Keep the registry entry visible until PTY teardown succeeds. A close
          // failure means the process may still be running and must remain
          // discoverable and retryable.
          yield* terminalManager.close({ threadId: tracked.threadId, deleteHistory: true });
          const removed = yield* Ref.modify(registry, (current) => {
            if (current[targetKey]?.threadId !== tracked.threadId) {
              return [false, current] as const;
            }
            const next = { ...current };
            delete next[targetKey];
            return [true, next] as const;
          });
          if (removed) {
            yield* publish({
              type: "removed",
              projectId: input.projectId,
              workspaceId: input.workspaceId,
              reason: "stopped",
            });
          }
          return { stopped: true };
        }),
      );
    };

    const list: DevServerManagerShape["list"] = Ref.get(registry).pipe(
      Effect.map((current) => ({
        servers: Object.values(current).map((tracked) => tracked.server),
      })),
    );

    return {
      run,
      stop,
      list,
      get stream() {
        return Stream.fromPubSub(pubsub);
      },
    } satisfies DevServerManagerShape;
  }),
);
