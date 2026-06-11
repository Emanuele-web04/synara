/**
 * ProviderHealthLive - Cache-backed provider health service.
 *
 * Seeds provider status from disk cache when available, then refreshes from
 * CLI probes without blocking the rest of server startup.
 *
 * Uses effect's ChildProcessSpawner to run CLI probes natively.
 *
 * @module ProviderHealthLive
 */
import type {
  ProviderKind,
  ServerSettings,
  ServerProviderStatus,
  ServerProviderUpdateState,
} from "@t3tools/contracts";
import { ServerProviderUpdateError } from "@t3tools/contracts";
import {
  Cache,
  DateTime,
  Duration,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Path,
  PubSub,
  Ref,
  Result,
  Scope,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { ServerConfig } from "../../config";
import { ServerSettingsService } from "../../serverSettings";
import { resolveCursorAgentBinaryPath } from "../acp/CursorAcpCommand";
import { ProviderHealth, type ProviderHealthShape } from "../Services/ProviderHealth";
import {
  orderProviderStatuses,
  readProviderStatusCache,
  resolveProviderStatusCachePath,
  writeProviderStatusCache,
} from "../providerStatusCache";
import { makeProviderMaintenanceCommandCoordinator } from "../providerMaintenanceCommandCoordinator";
import {
  enrichProviderStatusWithVersionAdvisory,
  makeProviderMaintenanceCapabilities,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "../providerMaintenance";
import { collectUint8StreamText } from "../../stream/collectUint8StreamText";
import {
  PACKAGE_MANAGED_PROVIDER_UPDATES,
  PROVIDER_COMMAND_TIMEOUT_DETAIL,
  PROVIDERS,
  type ProviderStatuses,
  UPDATE_OUTPUT_MAX_BYTES,
  UPDATE_TIMEOUT_MS,
} from "./ProviderHealth.config";
import { probeClaudeSubscription } from "./ProviderHealth.commands";
import {
  checkPiProviderStatus,
  makeCheckClaudeProviderStatus,
  makeCheckCodexProviderStatus,
  makeCheckCursorProviderStatus,
  makeCheckGeminiProviderStatus,
  makeCheckGrokProviderStatus,
  makeCheckKiloProviderStatus,
  makeCheckOpenCodeProviderStatus,
} from "./ProviderHealth.checks";

export type { CommandResult } from "./ProviderHealth.parsing";
export { hasCustomModelProvider, readCodexConfigModelProvider } from "./ProviderHealth.commands";
export {
  parseAuthStatusFromOutput,
  parseClaudeAuthStatusFromOutput,
} from "./ProviderHealth.parsing";
export {
  checkClaudeProviderStatus,
  checkCodexProviderStatus,
  checkCursorProviderStatus,
  checkGeminiProviderStatus,
  checkGrokProviderStatus,
  checkKiloProviderStatus,
  checkOpenCodeProviderStatus,
  checkPiProviderStatus,
  makeCheckClaudeProviderStatus,
  makeCheckCodexProviderStatus,
  makeCheckCursorProviderStatus,
  makeCheckGeminiProviderStatus,
  makeCheckGrokProviderStatus,
  makeCheckKiloProviderStatus,
  makeCheckOpenCodeProviderStatus,
} from "./ProviderHealth.checks";

// ── Snapshot helpers ────────────────────────────────────────────────

function comparableProviderVersionAdvisory(
  advisory: ServerProviderStatus["versionAdvisory"] | undefined,
): Omit<NonNullable<ServerProviderStatus["versionAdvisory"]>, "checkedAt"> | null {
  if (!advisory) {
    return null;
  }
  const { checkedAt: _checkedAt, ...comparableAdvisory } = advisory;
  return comparableAdvisory;
}

export function providerStatusesEqual(left: ProviderStatuses, right: ProviderStatuses): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((status, index) => {
    const next = right[index];
    return (
      next !== undefined &&
      status.provider === next.provider &&
      status.status === next.status &&
      status.available === next.available &&
      status.authStatus === next.authStatus &&
      (status.authType ?? null) === (next.authType ?? null) &&
      (status.authLabel ?? null) === (next.authLabel ?? null) &&
      status.voiceTranscriptionAvailable === next.voiceTranscriptionAvailable &&
      (status.version ?? null) === (next.version ?? null) &&
      (status.message ?? null) === (next.message ?? null) &&
      JSON.stringify(comparableProviderVersionAdvisory(status.versionAdvisory)) ===
        JSON.stringify(comparableProviderVersionAdvisory(next.versionAdvisory)) &&
      JSON.stringify(status.updateState ?? null) === JSON.stringify(next.updateState ?? null)
    );
  });
}

function isTransientProviderCommandTimeout(status: ServerProviderStatus): boolean {
  return (
    status.status !== "ready" &&
    status.authStatus === "unknown" &&
    (status.message ?? "").includes(PROVIDER_COMMAND_TIMEOUT_DETAIL)
  );
}

function wasPreviouslyUsableProviderStatus(status: ServerProviderStatus): boolean {
  return status.available && status.status === "ready";
}

export function stabilizeProviderStatusesAgainstTransientTimeouts(
  previousStatuses: ProviderStatuses,
  nextStatuses: ProviderStatuses,
): ProviderStatuses {
  if (previousStatuses.length === 0) {
    return nextStatuses;
  }

  const previousByProvider = new Map(
    previousStatuses.map((status) => [status.provider, status] as const),
  );

  return nextStatuses.map((status) => {
    const previous = previousByProvider.get(status.provider);
    if (
      !previous ||
      !wasPreviouslyUsableProviderStatus(previous) ||
      !isTransientProviderCommandTimeout(status)
    ) {
      return status;
    }

    return {
      ...previous,
      checkedAt: status.checkedAt,
      ...(status.updateState !== undefined ? { updateState: status.updateState } : {}),
    };
  });
}

// ── Layer ───────────────────────────────────────────────────────────

export const ProviderHealthLive = Layer.effect(
  ProviderHealth,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const serverConfig = yield* ServerConfig;
    const serverSettings = yield* ServerSettingsService;
    const changesPubSub = yield* Effect.acquireRelease(
      PubSub.unbounded<ReadonlyArray<ServerProviderStatus>>(),
      PubSub.shutdown,
    );
    const refreshScope = yield* Scope.make("sequential");
    yield* Effect.addFinalizer(() => Scope.close(refreshScope, Exit.void));

    const cachePathByProvider = new Map(
      PROVIDERS.map(
        (provider) =>
          [
            provider,
            resolveProviderStatusCachePath({
              stateDir: serverConfig.stateDir,
              provider,
            }),
          ] as const,
      ),
    );

    const cachedStatuses: ProviderStatuses = yield* Effect.forEach(
      PROVIDERS,
      (provider) =>
        readProviderStatusCache(cachePathByProvider.get(provider)!).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
        ),
      { concurrency: "unbounded" },
    ).pipe(
      Effect.map((statuses) =>
        orderProviderStatuses(
          statuses.filter((status): status is ServerProviderStatus => status !== undefined),
        ),
      ),
    );

    const statusesRef = yield* Ref.make<ProviderStatuses>(cachedStatuses);
    const updateStatesRef = yield* Ref.make<ReadonlyMap<ProviderKind, ServerProviderUpdateState>>(
      new Map(),
    );
    const refreshFiberRef = yield* Ref.make<Fiber.Fiber<ProviderStatuses, never> | null>(null);
    const commandCoordinator = yield* makeProviderMaintenanceCommandCoordinator({
      makeAlreadyRunningError: (provider) =>
        new ServerProviderUpdateError({
          provider: provider as ProviderKind,
          reason: "An update is already running for this provider.",
        }),
    });

    // 5-minute TTL cache for the Claude SDK subscription probe. The probe
    // spawns a short-lived `claude` subprocess to read account metadata
    // from the local init handshake; capacity=1 because the probe has no
    // parameters.
    const claudeSubscriptionCache = yield* Cache.make({
      capacity: 1,
      timeToLive: Duration.minutes(5),
      lookup: (_: "claude") => probeClaudeSubscription(),
    });
    const resolveClaudeSubscription = Cache.get(claudeSubscriptionCache, "claude").pipe(
      Effect.map((probe) => probe?.subscriptionType),
    );

    const getProviderBinaryPath = (provider: ProviderKind, settings: ServerSettings) => {
      switch (provider) {
        case "codex":
          return settings.providers.codex.binaryPath;
        case "claudeAgent":
          return settings.providers.claudeAgent.binaryPath;
        case "cursor":
          return settings.providers.cursor.binaryPath;
        case "gemini":
          return settings.providers.gemini.binaryPath;
        case "grok":
          return settings.providers.grok.binaryPath;
        case "kilo":
          return settings.providers.kilo.binaryPath;
        case "opencode":
          return settings.providers.opencode.binaryPath;
        case "pi":
          return settings.providers.pi.binaryPath;
      }
    };

    const getProviderMaintenanceCapabilities = Effect.fn("getProviderMaintenanceCapabilities")(
      function* (provider: ProviderKind) {
        const settings = yield* serverSettings.getSettings;
        if (provider === "cursor") {
          return makeProviderMaintenanceCapabilities({
            provider,
            packageName: null,
            updateExecutable: resolveCursorAgentBinaryPath(
              getProviderBinaryPath(provider, settings),
            ),
            updateArgs: ["update"],
            updateLockKey: "cursor-agent",
          });
        }
        const definition = PACKAGE_MANAGED_PROVIDER_UPDATES[provider];
        if (!definition) {
          return makeProviderMaintenanceCapabilities({
            provider,
            packageName: null,
            updateExecutable: null,
            updateArgs: [],
            updateLockKey: null,
          });
        }
        return yield* resolveProviderMaintenanceCapabilitiesEffect(definition, {
          binaryPath: getProviderBinaryPath(provider, settings),
          env: process.env,
          platform: process.platform,
        }).pipe(Effect.provideService(FileSystem.FileSystem, fileSystem));
      },
    );

    const applyVolatileProviderState = Effect.fn("applyVolatileProviderState")(function* (
      status: ServerProviderStatus,
    ) {
      const updateStates = yield* Ref.get(updateStatesRef);
      const updateState = updateStates.get(status.provider);
      if (!updateState) {
        const { updateState: _updateState, ...statusWithoutUpdateState } = status;
        return statusWithoutUpdateState;
      }
      return {
        ...status,
        updateState,
      };
    });

    const setProviderUpdateState = Effect.fn("setProviderUpdateState")(function* (
      provider: ProviderKind,
      state: ServerProviderUpdateState | null,
    ) {
      yield* Ref.update(updateStatesRef, (previous) => {
        const next = new Map(previous);
        if (!state || state.status === "idle") {
          next.delete(provider);
        } else {
          next.set(provider, state);
        }
        return next;
      });

      const current = yield* Ref.get(statusesRef);
      const next = yield* Effect.forEach(current, applyVolatileProviderState, {
        concurrency: "unbounded",
      });
      yield* Ref.set(statusesRef, next);
      yield* PubSub.publish(changesPubSub, next);
      return next;
    });

    const enrichStatuses = Effect.fn("enrichProviderStatuses")(function* (
      statuses: ReadonlyArray<ServerProviderStatus>,
    ) {
      const enriched = yield* Effect.forEach(
        statuses,
        (status) =>
          getProviderMaintenanceCapabilities(status.provider).pipe(
            Effect.flatMap((capabilities) =>
              enrichProviderStatusWithVersionAdvisory(status, capabilities),
            ),
            Effect.catch(() =>
              Effect.succeed({
                ...status,
                versionAdvisory: {
                  status: "unknown" as const,
                  currentVersion: status.version ?? null,
                  latestVersion: null,
                  updateCommand: null,
                  canUpdate: false,
                  checkedAt: status.checkedAt,
                  message: null,
                },
              }),
            ),
          ),
        { concurrency: "unbounded" },
      );
      return yield* Effect.forEach(enriched, applyVolatileProviderState, {
        concurrency: "unbounded",
      });
    });

    const loadProviderStatuses = serverSettings.getSettings
      .pipe(
        Effect.flatMap((settings) =>
          Effect.all(
            [
              makeCheckCodexProviderStatus(
                settings.providers.codex.binaryPath,
                settings.providers.codex.homePath,
              ),
              makeCheckClaudeProviderStatus(
                resolveClaudeSubscription,
                settings.providers.claudeAgent.binaryPath,
              ),
              makeCheckCursorProviderStatus(settings.providers.cursor.binaryPath),
              makeCheckGeminiProviderStatus(settings.providers.gemini.binaryPath),
              makeCheckGrokProviderStatus(settings.providers.grok.binaryPath),
              makeCheckKiloProviderStatus(settings.providers.kilo.binaryPath),
              makeCheckOpenCodeProviderStatus(settings.providers.opencode.binaryPath),
              checkPiProviderStatus(
                settings.providers.pi.agentDir,
                settings.providers.pi.binaryPath,
              ),
            ],
            {
              concurrency: "unbounded",
            },
          ),
        ),
      )
      .pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.map(orderProviderStatuses),
        Effect.flatMap(enrichStatuses),
      );

    const persistStatuses = (statuses: ProviderStatuses) =>
      Effect.forEach(
        statuses,
        (status) => {
          const { updateState: _updateState, ...statusToPersist } = status;
          return writeProviderStatusCache({
            filePath: cachePathByProvider.get(status.provider)!,
            provider: statusToPersist,
          }).pipe(
            Effect.provideService(FileSystem.FileSystem, fileSystem),
            Effect.provideService(Path.Path, path),
            Effect.tapError(Effect.logError),
            Effect.ignore,
          );
        },
        { concurrency: "unbounded", discard: true },
      );

    const refreshNow = Effect.gen(function* () {
      yield* Cache.invalidate(claudeSubscriptionCache, "claude");
      const loadedStatuses = yield* loadProviderStatuses;
      const previousStatuses = yield* Ref.get(statusesRef);
      const nextStatuses = stabilizeProviderStatusesAgainstTransientTimeouts(
        previousStatuses,
        loadedStatuses,
      );
      if (providerStatusesEqual(previousStatuses, nextStatuses)) {
        yield* Ref.set(statusesRef, nextStatuses);
        return nextStatuses;
      }
      yield* Ref.set(statusesRef, nextStatuses);
      yield* persistStatuses(nextStatuses);
      yield* PubSub.publish(changesPubSub, nextStatuses);
      return nextStatuses;
    });

    // Keep a single refresh in flight so repeated config reads do not spawn
    // overlapping CLI probes while the cache already gives us a usable answer.
    const ensureRefreshFiber: Effect.Effect<Fiber.Fiber<ProviderStatuses, never>> = Effect.gen(
      function* () {
        const inFlight = yield* Ref.get(refreshFiberRef);
        if (inFlight) {
          return inFlight;
        }
        const refreshFiber = yield* Effect.gen(function* () {
          const refreshExit = yield* Effect.exit(refreshNow);
          if (Exit.isSuccess(refreshExit)) {
            return refreshExit.value;
          }
          // Keep the current in-memory snapshot as the source of truth if a
          // foreground refresh fails after startup.
          return yield* Ref.get(statusesRef);
        }).pipe(Effect.ensuring(Ref.set(refreshFiberRef, null)), Effect.forkIn(refreshScope));
        yield* Ref.set(refreshFiberRef, refreshFiber);
        return refreshFiber;
      },
    );

    yield* ensureRefreshFiber;

    const refresh: Effect.Effect<ProviderStatuses> = ensureRefreshFiber.pipe(
      Effect.flatMap(Fiber.join),
    );

    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

    const makeUpdateState = (input: {
      readonly status: ServerProviderUpdateState["status"];
      readonly startedAt: string | null;
      readonly finishedAt: string | null;
      readonly message: string | null;
      readonly output?: string | null;
    }): ServerProviderUpdateState => ({
      status: input.status,
      startedAt: input.startedAt,
      finishedAt: input.finishedAt,
      message: input.message,
      output: input.output ?? null,
    });

    const describeUpdateCommandError = (error: unknown): string => {
      if (error instanceof Error && error.message.trim().length > 0) {
        if (error.message.includes("initial is not a function")) {
          return "Update command failed before producing output. Try running the provider update command from a terminal.";
        }
        return error.message;
      }
      if (typeof error === "string" && error.trim().length > 0) {
        return error;
      }
      return "Update command could not be started.";
    };

    const runUpdateCommand = Effect.fn("runProviderUpdateCommand")(function* (input: {
      readonly command: string;
      readonly args: ReadonlyArray<string>;
    }) {
      const child = yield* spawner.spawn(
        ChildProcess.make(input.command, [...input.args], {
          shell: process.platform === "win32",
          env: process.env,
        }),
      );
      yield* Effect.addFinalizer(() => child.kill().pipe(Effect.ignore));
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          collectUint8StreamText({
            stream: child.stdout,
            maxBytes: UPDATE_OUTPUT_MAX_BYTES,
          }),
          collectUint8StreamText({
            stream: child.stderr,
            maxBytes: UPDATE_OUTPUT_MAX_BYTES,
          }),
          child.exitCode.pipe(Effect.map(Number)),
        ],
        { concurrency: "unbounded" },
      );
      return {
        stdout: stdout.text,
        stderr: stderr.text,
        exitCode,
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
      };
    });

    const updateProvider: ProviderHealthShape["updateProvider"] = Effect.fn(
      "ProviderHealth.updateProvider",
    )(function* (input) {
      const provider = input.provider;
      const toUpdateError = (reason: unknown) =>
        new ServerProviderUpdateError({
          provider,
          reason: reason instanceof Error ? reason.message : String(reason),
        });
      const capabilities = yield* getProviderMaintenanceCapabilities(provider).pipe(
        Effect.mapError(toUpdateError),
      );
      const update = capabilities.update;
      if (!update) {
        return yield* new ServerProviderUpdateError({
          provider,
          reason: "This provider does not support one-click updates.",
        });
      }

      const run = Effect.gen(function* () {
        const startedAt = yield* nowIso;
        yield* setProviderUpdateState(
          provider,
          makeUpdateState({
            status: "running",
            startedAt,
            finishedAt: null,
            message: "Updating provider.",
          }),
        );

        const commandResult = yield* runUpdateCommand({
          command: update.executable,
          args: update.args,
        }).pipe(
          Effect.scoped,
          Effect.timeoutOption(Duration.millis(UPDATE_TIMEOUT_MS)),
          Effect.result,
        );
        const finishedAt = yield* nowIso;
        if (Result.isFailure(commandResult)) {
          const providers = yield* setProviderUpdateState(
            provider,
            makeUpdateState({
              status: "failed",
              startedAt,
              finishedAt,
              message: describeUpdateCommandError(commandResult.failure),
            }),
          );
          return { providers };
        }
        const result = commandResult.success;
        const output = Option.isSome(result)
          ? [result.value.stderr, result.value.stdout].filter(Boolean).join("\n\n").trim() || null
          : null;
        const failed = Option.isNone(result) || result.value.exitCode !== 0;
        if (failed) {
          const message = Option.isNone(result)
            ? "Update timed out."
            : `Update command exited with code ${result.value.exitCode}.`;
          const providers = yield* setProviderUpdateState(
            provider,
            makeUpdateState({
              status: "failed",
              startedAt,
              finishedAt,
              message,
              output: output ? output.slice(0, UPDATE_OUTPUT_MAX_BYTES) : null,
            }),
          );
          return { providers };
        }

        const providers = yield* refreshNow.pipe(Effect.mapError(toUpdateError));
        const refreshed = providers.find((status) => status.provider === provider);
        const stillOutdated = refreshed?.versionAdvisory?.status === "behind_latest";
        const finalProviders = yield* setProviderUpdateState(
          provider,
          makeUpdateState({
            status: stillOutdated ? "unchanged" : "succeeded",
            startedAt,
            finishedAt,
            message: stillOutdated
              ? "Update command completed, but Synara still detects an outdated provider version."
              : "Provider updated.",
            output: output ? output.slice(0, UPDATE_OUTPUT_MAX_BYTES) : null,
          }),
        );
        return { providers: finalProviders };
      });

      return yield* commandCoordinator.withCommandLock({
        targetKey: provider,
        lockKey: update.lockKey,
        onQueued: setProviderUpdateState(
          provider,
          makeUpdateState({
            status: "queued",
            startedAt: null,
            finishedAt: null,
            message: "Waiting for another provider update to finish.",
          }),
        ).pipe(Effect.asVoid),
        run,
      });
    });

    return {
      // Mirror upstream's behavior here: reads consume the latest stable
      // snapshot, while refreshes happen explicitly or from provider streams.
      getStatuses: Ref.get(statusesRef),
      refresh,
      updateProvider,
      get streamChanges() {
        return Stream.fromPubSub(changesPubSub);
      },
    } satisfies ProviderHealthShape;
  }),
);
