import {
  getSessionInfo as getClaudeSessionInfo,
  getSessionMessages as getClaudeSessionMessages,
} from "@anthropic-ai/claude-agent-sdk";
import {
  CommandId,
  type ModelSelection,
  type OrchestrationImportThreadInput,
  type ProviderStartOptions,
  type ThreadHandoffImportedMessage,
  type ThreadId,
} from "@t3tools/contracts";
import {
  providerStartOptionsFromInstance,
  resolveModelSelectionInstanceId,
  resolveProviderInstance,
} from "@t3tools/shared/providerInstances";
import {
  deriveAssociatedWorktreeMetadata,
  workspaceRootsEqual,
} from "@t3tools/shared/threadWorkspace";
import type { FileSystem, Path } from "effect";
import { Data, Effect, Option } from "effect";

import { resolveThreadWorkspaceCwd } from "../checkpointing/Utils";
import type { OrchestrationEngineShape } from "./Services/OrchestrationEngine";
import type { ProjectionSnapshotQueryShape } from "./Services/ProjectionSnapshotQuery";
import type { ProviderAdapterRegistryShape } from "../provider/Services/ProviderAdapterRegistry";
import type { ProviderServiceShape } from "../provider/Services/ProviderService";
import type { ServerSettingsShape } from "../serverSettings";
import { parseManagedWorktreeWorkspaceRoot } from "../workspace/managedWorktree";
import {
  mapClaudeSessionMessages,
  mapCodexSnapshotMessages,
  mapOpenCodeSnapshotMessages,
} from "./importedThreadMessages";

type ImportThreadRequest = OrchestrationImportThreadInput;

class ImportThreadError extends Data.TaggedError("ImportThreadError")<{
  readonly message: string;
}> {}

function importMessagesError(message: string): ImportThreadError {
  return new ImportThreadError({ message });
}

let claudeHistoricalSessionEnvLock: Promise<void> = Promise.resolve();

async function withSerializedProcessEnv<T>(
  environment: Readonly<Record<string, string>> | undefined,
  run: () => Promise<T>,
): Promise<T> {
  const previousLock = claudeHistoricalSessionEnvLock;
  let releaseLock: (() => void) | undefined;
  claudeHistoricalSessionEnvLock = previousLock.then(
    () =>
      new Promise<void>((resolve) => {
        releaseLock = resolve;
      }),
  );
  await previousLock;

  const environmentEntries = Object.entries(environment ?? {});
  const previousValues = new Map<string, string | undefined>();
  for (const [key, value] of environmentEntries) {
    previousValues.set(key, process.env[key]);
    process.env[key] = value;
  }

  try {
    return await run();
  } finally {
    for (const [key, previousValue] of previousValues) {
      if (previousValue === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previousValue;
      }
    }
    releaseLock?.();
  }
}

function claudeHistoricalSessionEnvironment(
  providerOptions: ProviderStartOptions | undefined,
): Readonly<Record<string, string>> | undefined {
  const claudeOptions = providerOptions?.claudeAgent;
  if (!claudeOptions) {
    return undefined;
  }
  const environment = {
    ...(claudeOptions.environment ?? {}),
    ...(claudeOptions.homePath?.trim() ? { HOME: claudeOptions.homePath.trim() } : {}),
  };
  return Object.keys(environment).length > 0 ? environment : undefined;
}

function mapProviderSessionStatusToOrchestrationStatus(
  status: "connecting" | "ready" | "running" | "error" | "closed",
): "starting" | "ready" | "running" | "error" | "stopped" {
  switch (status) {
    case "connecting":
      return "starting";
    case "running":
      return "running";
    case "error":
      return "error";
    case "closed":
      return "stopped";
    case "ready":
    default:
      return "ready";
  }
}

export interface ImportThreadHandlerOptions {
  readonly fileSystem: FileSystem.FileSystem;
  readonly orchestrationEngine: OrchestrationEngineShape;
  readonly path: Path.Path;
  readonly platform: NodeJS.Platform;
  readonly projectionSnapshotQuery: ProjectionSnapshotQueryShape;
  readonly providerAdapterRegistry: ProviderAdapterRegistryShape;
  readonly providerService: ProviderServiceShape;
  readonly serverSettings: ServerSettingsShape;
}

export function makeImportThreadHandler(options: ImportThreadHandlerOptions) {
  const dispatchImportedMessages = (input: {
    readonly createdAt: string;
    readonly messages: ReadonlyArray<ThreadHandoffImportedMessage>;
    readonly threadId: ThreadId;
  }) =>
    input.messages.length === 0
      ? Effect.void
      : options.orchestrationEngine.dispatch({
          type: "thread.messages.import",
          commandId: CommandId.makeUnsafe(crypto.randomUUID()),
          threadId: input.threadId,
          messages: input.messages,
          createdAt: input.createdAt,
        });

  const ensureClaudeThreadImportable = Effect.fn(function* (input: {
    readonly cwd: string | undefined;
    readonly externalId: string;
    readonly providerOptions?: ProviderStartOptions;
  }) {
    const historicalEnv = claudeHistoricalSessionEnvironment(input.providerOptions);
    const claudeSessionInfo = yield* Effect.tryPromise({
      try: () =>
        withSerializedProcessEnv(historicalEnv, () =>
          getClaudeSessionInfo(input.externalId, input.cwd ? { dir: input.cwd } : undefined),
        ),
      catch: (cause) =>
        importMessagesError(
          cause instanceof Error && cause.message.length > 0
            ? cause.message
            : "Failed to inspect Claude session metadata.",
        ),
    });

    if (claudeSessionInfo) return;

    const sessionFoundElsewhere = yield* Effect.tryPromise({
      try: () => getClaudeSessionInfo(input.externalId),
      catch: () => undefined,
    });

    return yield* Effect.fail(
      importMessagesError(
        sessionFoundElsewhere && input.cwd
          ? `Claude session '${input.externalId}' exists, but not for this workspace. Claude resume only works when the session file is stored for '${input.cwd}'.`
          : `Claude session '${input.externalId}' was not found on this machine for this workspace. Claude import only works with a locally persisted Claude session ID.`,
      ),
    );
  });

  const resolveImportedProviderThreadContext = Effect.fn(function* (input: {
    readonly provider: "codex" | "kilo" | "opencode";
    readonly externalId: string;
    readonly projectWorkspaceRoot: string;
    readonly fallbackCwd?: string;
    readonly providerOptions?: ProviderStartOptions;
  }) {
    const adapter = yield* options.providerAdapterRegistry.getByProvider(input.provider);
    if (!adapter.readExternalThread) return null;

    const snapshot = yield* adapter
      .readExternalThread({
        externalThreadId: input.externalId,
        ...(input.fallbackCwd ? { cwd: input.fallbackCwd } : {}),
        ...(input.providerOptions ? { providerOptions: input.providerOptions } : {}),
      })
      .pipe(Effect.catch(() => Effect.succeed(null)));
    const externalCwd = snapshot?.cwd?.trim();
    if (!externalCwd) return null;

    if (
      workspaceRootsEqual(input.projectWorkspaceRoot, externalCwd, {
        platform: options.platform,
      })
    ) {
      return {
        runtimeCwd: externalCwd,
        patch: {
          envMode: "local" as const,
          worktreePath: null,
          associatedWorktreePath: null,
          associatedWorktreeBranch: null,
          associatedWorktreeRef: null,
        },
      };
    }

    const relativeToProjectRoot = options.path.relative(input.projectWorkspaceRoot, externalCwd);
    if (
      relativeToProjectRoot.length > 0 &&
      !relativeToProjectRoot.startsWith("..") &&
      !options.path.isAbsolute(relativeToProjectRoot)
    ) {
      return {
        runtimeCwd: externalCwd,
        patch: null,
      };
    }

    let currentPath = externalCwd;
    while (true) {
      const gitPointerFileContents = yield* options.fileSystem
        .readFileString(options.path.join(currentPath, ".git"))
        .pipe(Effect.catch(() => Effect.succeed(null)));

      if (gitPointerFileContents) {
        const workspaceRoot = parseManagedWorktreeWorkspaceRoot({
          gitPointerFileContents,
          path: options.path,
          worktreePath: currentPath,
        });
        if (
          workspaceRoot &&
          workspaceRootsEqual(input.projectWorkspaceRoot, workspaceRoot, {
            platform: options.platform,
          })
        ) {
          return {
            runtimeCwd: externalCwd,
            patch: {
              envMode: "worktree" as const,
              branch: null,
              worktreePath: currentPath,
              ...deriveAssociatedWorktreeMetadata({
                branch: null,
                worktreePath: currentPath,
              }),
            },
          };
        }
      }

      const parentPath = options.path.dirname(currentPath);
      if (parentPath === currentPath) return null;
      currentPath = parentPath;
    }
  });

  const importCodexThreadHistory = Effect.fn(function* (input: {
    readonly importedAt: string;
    readonly threadId: ThreadId;
  }) {
    const adapter = yield* options.providerAdapterRegistry.getByProvider("codex");
    const snapshot = yield* adapter
      .readThread(input.threadId)
      .pipe(
        Effect.mapError((cause) =>
          importMessagesError(
            cause instanceof Error && cause.message.length > 0
              ? cause.message
              : "Failed to read Codex thread history.",
          ),
        ),
      );

    yield* dispatchImportedMessages({
      threadId: input.threadId,
      messages: mapCodexSnapshotMessages({
        threadId: input.threadId,
        turns: snapshot.turns,
        importedAt: input.importedAt,
      }),
      createdAt: input.importedAt,
    });
  });

  const importClaudeThreadHistory = Effect.fn(function* (input: {
    readonly cwd: string | undefined;
    readonly externalId: string;
    readonly importedAt: string;
    readonly providerOptions?: ProviderStartOptions;
    readonly threadId: ThreadId;
  }) {
    const historicalEnv = claudeHistoricalSessionEnvironment(input.providerOptions);
    const sessionMessages = yield* Effect.tryPromise({
      try: () =>
        withSerializedProcessEnv(historicalEnv, () =>
          getClaudeSessionMessages(input.externalId, input.cwd ? { dir: input.cwd } : undefined),
        ),
      catch: (cause) =>
        importMessagesError(
          cause instanceof Error && cause.message.length > 0
            ? cause.message
            : "Failed to read Claude session history.",
        ),
    });

    yield* dispatchImportedMessages({
      threadId: input.threadId,
      messages: mapClaudeSessionMessages({
        threadId: input.threadId,
        messages: sessionMessages,
        importedAt: input.importedAt,
      }),
      createdAt: input.importedAt,
    });
  });

  const importOpenCodeCompatibleThreadHistory = Effect.fn(function* (input: {
    readonly importedAt: string;
    readonly provider: "kilo" | "opencode";
    readonly threadId: ThreadId;
  }) {
    const adapter = yield* options.providerAdapterRegistry.getByProvider(input.provider);
    const snapshot = yield* adapter
      .readThread(input.threadId)
      .pipe(
        Effect.mapError((cause) =>
          importMessagesError(
            cause instanceof Error && cause.message.length > 0
              ? cause.message
              : `Failed to read ${input.provider === "kilo" ? "Kilo" : "OpenCode"} session history.`,
          ),
        ),
      );

    yield* dispatchImportedMessages({
      threadId: input.threadId,
      messages: mapOpenCodeSnapshotMessages({
        threadId: input.threadId,
        turns: snapshot.turns,
        importedAt: input.importedAt,
      }),
      createdAt: input.importedAt,
    });
  });

  const resolveThreadProviderOptions = Effect.fn(function* (input: {
    readonly modelSelection: ModelSelection;
  }) {
    const settings = yield* options.serverSettings.getSettings.pipe(
      Effect.mapError((cause) =>
        importMessagesError(
          cause instanceof Error && cause.message.length > 0
            ? cause.message
            : "Failed to load provider instance settings.",
        ),
      ),
    );
    const instanceId = resolveModelSelectionInstanceId(input.modelSelection);
    const instance = resolveProviderInstance(settings, { instanceId });
    if (!instance) {
      return yield* Effect.fail(
        importMessagesError(`Unknown provider instance '${instanceId}' for thread import.`),
      );
    }
    return { instance, providerOptions: providerStartOptionsFromInstance(instance) };
  });

  return Effect.fnUntraced(function* (body: ImportThreadRequest) {
    const threadOption = yield* options.projectionSnapshotQuery.getThreadDetailById(body.threadId);
    if (Option.isNone(threadOption)) {
      return yield* Effect.fail(importMessagesError(`Thread '${body.threadId}' was not found.`));
    }
    const thread = threadOption.value;

    if (thread.session && thread.session.status !== "stopped") {
      return yield* Effect.fail(
        importMessagesError(`Thread '${body.threadId}' already has an active provider session.`),
      );
    }

    const projectOption = yield* options.projectionSnapshotQuery.getProjectShellById(
      thread.projectId,
    );
    const project = Option.getOrNull(projectOption);
    const cwd = resolveThreadWorkspaceCwd({
      thread,
      projects: project
        ? [
            {
              id: project.id,
              workspaceRoot: project.workspaceRoot,
            },
          ]
        : [],
    });
    const externalId = body.externalId.trim();
    const resolvedProvider = yield* resolveThreadProviderOptions({
      modelSelection: thread.modelSelection,
    });
    const provider = resolvedProvider.instance.driver;
    const providerOptions = resolvedProvider.providerOptions;

    const importedProviderContext =
      (provider === "codex" || provider === "kilo" || provider === "opencode") && project
        ? yield* resolveImportedProviderThreadContext({
            provider,
            externalId,
            projectWorkspaceRoot: project.workspaceRoot,
            ...(cwd ? { fallbackCwd: cwd } : {}),
            ...(providerOptions ? { providerOptions } : {}),
          })
        : null;

    if (importedProviderContext?.patch) {
      yield* options.orchestrationEngine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.makeUnsafe(crypto.randomUUID()),
        threadId: thread.id,
        ...importedProviderContext.patch,
      });
    }

    if (provider === "claudeAgent") {
      yield* ensureClaudeThreadImportable({
        cwd,
        externalId,
        ...(providerOptions ? { providerOptions } : {}),
      });
    }

    const session = yield* options.providerService.startSession(thread.id, {
      threadId: thread.id,
      provider,
      ...((importedProviderContext?.runtimeCwd ?? cwd)
        ? { cwd: importedProviderContext?.runtimeCwd ?? cwd }
        : {}),
      modelSelection: thread.modelSelection,
      ...(providerOptions ? { providerOptions } : {}),
      resumeCursor:
        provider === "claudeAgent"
          ? { resume: externalId }
          : provider === "kilo" || provider === "opencode"
            ? { openCodeSessionId: externalId }
            : { threadId: externalId },
      runtimeMode: thread.runtimeMode,
    });

    if (provider === "codex") {
      yield* importCodexThreadHistory({
        threadId: thread.id,
        importedAt: session.updatedAt,
      });
    } else if (provider === "claudeAgent") {
      yield* importClaudeThreadHistory({
        threadId: thread.id,
        externalId,
        cwd,
        ...(providerOptions ? { providerOptions } : {}),
        importedAt: session.updatedAt,
      });
    } else if (provider === "kilo" || provider === "opencode") {
      yield* importOpenCodeCompatibleThreadHistory({
        provider,
        threadId: thread.id,
        importedAt: session.updatedAt,
      });
    }

    yield* options.orchestrationEngine.dispatch({
      type: "thread.session.set",
      commandId: CommandId.makeUnsafe(crypto.randomUUID()),
      threadId: thread.id,
      session: {
        threadId: thread.id,
        status: mapProviderSessionStatusToOrchestrationStatus(session.status),
        providerName: session.provider,
        providerInstanceId: session.providerInstanceId ?? thread.modelSelection.instanceId,
        runtimeMode: thread.runtimeMode,
        activeTurnId: null,
        lastError: session.lastError ?? null,
        updatedAt: session.updatedAt,
      },
      createdAt: session.updatedAt,
    });

    return { threadId: thread.id };
  });
}
