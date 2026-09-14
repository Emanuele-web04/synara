// Resource mutation logic shared by the RPC boundary and focused regression tests.
import { realpath } from "node:fs/promises";
import path from "node:path";
import { type ResourceKillSessionInput, WsRpcError } from "@synara/contracts";
import { Effect, Exit } from "effect";

import { killResourceProcessTree, readProcessCommand } from "./resourceMonitor";
import { defaultProcessTreeKiller } from "./terminal/processTreeKiller";
import type {
  TerminalActiveSessionDescriptor,
  TerminalManagerShape,
} from "./terminal/Services/Manager";
import type { ProviderServiceShape } from "./provider/Services/ProviderService";
import type { ProviderAdapterRegistryShape } from "./provider/Services/ProviderAdapterRegistry";
import { CurrentWsSessionRole } from "./wsConnectionSessions";

export const requireResourceOwner = Effect.gen(function* () {
  if ((yield* CurrentWsSessionRole) !== "owner") {
    return yield* Effect.fail(
      new WsRpcError({ message: "Owner authorization is required for resource management." }),
    );
  }
});

function terminalOwnsPid(session: TerminalActiveSessionDescriptor, pid: number): boolean {
  if (session.status === "exited" || session.pid === null) return false;
  if (session.pid === pid) return true;
  return defaultProcessTreeKiller
    .capture(session.pid)
    .descendants.some((child) => child.pid === pid);
}

async function verifiedCapturedCommand(
  pid: number,
  capturedCommand: string,
): Promise<string | null> {
  const current = await readProcessCommand(pid);
  // Process-tree captures normalize whitespace; the delayed killer uses the raw command.
  return current !== null && current.trim().split(/\s+/).join(" ") === capturedCommand
    ? current
    : null;
}

/** Authorize from live process trees, never the throttled UI snapshot. */
async function ownedProcessCommand(
  pid: number,
  terminals: readonly TerminalActiveSessionDescriptor[],
): Promise<string | null> {
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) return null;
  const serverDescendant = defaultProcessTreeKiller
    .capture(process.pid)
    .descendants.find((child) => child.pid === pid);
  if (serverDescendant) return verifiedCapturedCommand(pid, serverDescendant.command);
  for (const terminal of terminals) {
    if (terminal.status === "exited" || terminal.pid === null) continue;
    if (terminal.pid === pid) return readProcessCommand(pid);
    const child = defaultProcessTreeKiller
      .capture(terminal.pid)
      .descendants.find((row) => row.pid === pid);
    if (child) return verifiedCapturedCommand(pid, child.command);
  }
  // Provider registry entries are attribution hints, not ownership evidence:
  // their first command baseline may have been learned after the PID was reused.
  // Live provider processes are already covered by the server descendant tree.
  return null;
}

/** Canonical paths prevent ../, sibling-prefix and symlink escapes from managed storage. */
export async function resolveResourceScanPaths(
  paths: readonly string[] | undefined,
  worktreesDir: string,
): Promise<string[]> {
  const root = await realpath(worktreesDir);
  const requested = paths ?? [root];
  if (requested.length > 64) throw new Error("Too many disk scan paths.");
  return [
    ...new Set(
      await Promise.all(
        requested.map(async (requestedPath) => {
          const canonical = await realpath(requestedPath);
          const relative = path.relative(root, canonical);
          if (
            relative === ".." ||
            relative.startsWith(`..${path.sep}`) ||
            path.isAbsolute(relative)
          ) {
            throw new Error("Disk scan paths must stay within managed worktree storage.");
          }
          return canonical;
        }),
      ),
    ),
  ];
}

export const killResourceSession = (
  input: ResourceKillSessionInput,
  terminalManager: Pick<TerminalManagerShape, "listActiveSessions" | "close">,
) =>
  Effect.gen(function* () {
    yield* requireResourceOwner;
    if (!input.terminalId && !input.pid) {
      return yield* Effect.fail(new Error("Provide a terminalId or pid to kill."));
    }
    const terminals = yield* terminalManager.listActiveSessions();
    if (input.terminalId) {
      const matches = terminals.filter(
        (session) =>
          session.terminalId === input.terminalId &&
          (input.threadId === undefined || session.threadId === input.threadId) &&
          (input.pid === undefined || terminalOwnsPid(session, input.pid)),
      );
      if (matches.length > 1) {
        return yield* Effect.fail(new Error("Terminal ID is ambiguous; provide its threadId."));
      }
      const match = matches[0];
      if (!match) {
        return yield* Effect.fail(
          new Error(`Terminal session '${input.terminalId}' was not found.`),
        );
      }
      if (match.status !== "exited" && match.pid !== null) {
        yield* terminalManager.close(
          { threadId: match.threadId, terminalId: match.terminalId },
          match.pid,
        );
        return { pid: match.pid, killed: true as const };
      }
      return yield* Effect.fail(new Error("Terminal session already exited."));
    }
    const pid = input.pid!;
    const command = yield* Effect.promise(() => ownedProcessCommand(pid, terminals));
    if (command === null) {
      return yield* Effect.fail(new Error("Process is not owned by Synara or has already exited."));
    }
    return yield* Effect.promise(() => killResourceProcessTree(pid, command));
  });

export const restartResourceProviders = (
  providerService: Pick<ProviderServiceShape, "listSessions" | "stopSession">,
  registry: ProviderAdapterRegistryShape,
) =>
  Effect.gen(function* () {
    yield* requireResourceOwner;
    const sessions = yield* providerService.listSessions();
    const sessionResults = yield* Effect.forEach(
      sessions,
      (session) => providerService.stopSession({ threadId: session.threadId }).pipe(Effect.exit),
      { concurrency: "unbounded" },
    );
    const providers = yield* registry.listProviders();
    const providerResults = yield* Effect.forEach(
      providers,
      (provider) =>
        registry.getByProvider(provider).pipe(
          Effect.flatMap((adapter) => adapter.stopAll()),
          Effect.exit,
        ),
      { concurrency: "unbounded" },
    );
    if ([...sessionResults, ...providerResults].some(Exit.isFailure)) {
      return yield* Effect.fail(
        new Error("Some provider sessions or runtimes could not be stopped."),
      );
    }
  });
