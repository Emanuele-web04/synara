import { execFile } from "node:child_process";
import { promises as fsPromises } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { pathToFileURL } from "node:url";

import {
  getSessionInfo as getClaudeSessionInfo,
  getSessionMessages as getClaudeSessionMessages,
  type SDKSessionInfo,
  type SessionMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  CommandId,
  type ModelSelection,
  type OrchestrationImportThreadInput,
  type ProviderStartOptions,
  type ServerSettings,
  type ThreadHandoffImportedMessage,
  type ThreadId,
} from "@t3tools/contracts";
import {
  providerStartOptionsFromInstance,
  resolveModelSelectionInstanceId,
  resolveProviderInstance,
  type ResolvedProviderInstance,
} from "@t3tools/shared/providerInstances";
import {
  deriveAssociatedWorktreeMetadata,
  workspaceRootsEqual,
} from "@t3tools/shared/threadWorkspace";
import type { FileSystem, Path } from "effect";
import { Data, Effect, Option } from "effect";

import { resolveThreadWorkspaceCwd } from "../checkpointing/Utils";
import type { ServerConfigShape } from "../config";
import { buildClaudeProcessEnv } from "../provider/claudeEnvironment";
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

// The Claude agent SDK resolves its config dir from the process environment
// (HOME/CLAUDE_CONFIG_DIR). Imports for instances with a custom home must not
// mutate the server's process.env — concurrent health checks, text generation,
// or session startups would observe the wrong Claude account — so the session
// query runs in a short-lived child process that gets the custom environment.
const CLAUDE_SESSION_QUERY_SCRIPT = `const [moduleUrl, method, sessionId, optionsJson] = process.argv.slice(2);
const sdk = await import(moduleUrl);
const options = JSON.parse(optionsJson);
const result = await sdk[method](sessionId, options ?? undefined);
process.stdout.write(JSON.stringify(result ?? null));
`;

type ClaudeSessionQueryMethod = "getSessionInfo" | "getSessionMessages";

export function claudeHistoricalSessionChildEnvironment(
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return environment;
}

async function runClaudeSessionQueryInChildProcess<T>(input: {
  readonly method: ClaudeSessionQueryMethod;
  readonly sessionId: string;
  readonly dir: string | undefined;
  readonly environment: NodeJS.ProcessEnv;
}): Promise<T> {
  const moduleUrl = pathToFileURL(
    createRequire(import.meta.url).resolve("@anthropic-ai/claude-agent-sdk"),
  ).href;
  const scriptDir = await fsPromises.mkdtemp(nodePath.join(tmpdir(), "t3code-claude-import-"));
  const scriptPath = nodePath.join(scriptDir, "claudeSessionQuery.mjs");
  try {
    await fsPromises.writeFile(scriptPath, CLAUDE_SESSION_QUERY_SCRIPT, "utf8");
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        process.execPath,
        [
          scriptPath,
          moduleUrl,
          input.method,
          input.sessionId,
          JSON.stringify(input.dir ? { dir: input.dir } : null),
        ],
        {
          env: claudeHistoricalSessionChildEnvironment(input.environment),
          maxBuffer: 64 * 1024 * 1024,
        },
        (error, childStdout, childStderr) => {
          if (error) {
            const detail = childStderr.toString().trim();
            reject(detail.length > 0 ? new Error(detail) : error);
            return;
          }
          resolve(childStdout.toString());
        },
      );
    });
    return JSON.parse(stdout) as T;
  } finally {
    await fsPromises.rm(scriptDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function queryClaudeHistoricalSession<T>(input: {
  readonly method: ClaudeSessionQueryMethod;
  readonly sessionId: string;
  readonly dir: string | undefined;
  readonly environment: NodeJS.ProcessEnv | undefined;
}): Promise<T> {
  if (input.environment && Object.keys(input.environment).length > 0) {
    return runClaudeSessionQueryInChildProcess<T>({
      method: input.method,
      sessionId: input.sessionId,
      dir: input.dir,
      environment: input.environment,
    });
  }
  const options = input.dir ? { dir: input.dir } : undefined;
  return (
    input.method === "getSessionInfo"
      ? getClaudeSessionInfo(input.sessionId, options)
      : getClaudeSessionMessages(input.sessionId, options)
  ) as Promise<T>;
}

export function claudeHistoricalSessionEnvironment(
  providerOptions: ProviderStartOptions | undefined,
  input?: { readonly homeDir?: string | undefined },
): NodeJS.ProcessEnv | undefined {
  const claudeOptions = providerOptions?.claudeAgent;
  if (!claudeOptions && !input?.homeDir) {
    return undefined;
  }
  const homePath = claudeOptions?.homePath?.trim();
  const environment = claudeOptions?.environment ?? {};
  if (!homePath && Object.keys(environment).length === 0) {
    // Default Claude imports still belong to the configured Synara home, not the server process HOME.
    return buildClaudeProcessEnv({ homeDir: input?.homeDir });
  }
  return buildClaudeProcessEnv({ homePath, environment, homeDir: input?.homeDir });
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

export function resolveImportedThreadProviderOptionsForSettings(
  settings: ServerSettings,
  modelSelection: ModelSelection,
): {
  readonly instance: ResolvedProviderInstance;
  readonly providerOptions: ProviderStartOptions | undefined;
} {
  const instanceId = resolveModelSelectionInstanceId(modelSelection);
  const instance = resolveProviderInstance(settings, { instanceId });
  if (!instance) {
    throw importMessagesError(`Unknown provider instance '${instanceId}' for thread import.`);
  }
  if (!instance.enabled) {
    throw importMessagesError(`Provider instance '${instanceId}' is disabled for thread import.`);
  }
  return { instance, providerOptions: providerStartOptionsFromInstance(instance) };
}

export interface ImportThreadHandlerOptions {
  readonly fileSystem: FileSystem.FileSystem;
  readonly orchestrationEngine: OrchestrationEngineShape;
  readonly path: Path.Path;
  readonly platform: NodeJS.Platform;
  readonly projectionSnapshotQuery: ProjectionSnapshotQueryShape;
  readonly providerAdapterRegistry: ProviderAdapterRegistryShape;
  readonly providerService: ProviderServiceShape;
  readonly serverConfig: Pick<ServerConfigShape, "homeDir">;
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
    const historicalEnv = claudeHistoricalSessionEnvironment(input.providerOptions, {
      homeDir: options.serverConfig.homeDir,
    });
    const claudeSessionInfo = yield* Effect.tryPromise({
      try: () =>
        queryClaudeHistoricalSession<SDKSessionInfo | null | undefined>({
          method: "getSessionInfo",
          sessionId: input.externalId,
          dir: input.cwd,
          environment: historicalEnv,
        }),
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
    const historicalEnv = claudeHistoricalSessionEnvironment(input.providerOptions, {
      homeDir: options.serverConfig.homeDir,
    });
    const sessionMessages = yield* Effect.tryPromise({
      try: () =>
        queryClaudeHistoricalSession<SessionMessage[]>({
          method: "getSessionMessages",
          sessionId: input.externalId,
          dir: input.cwd,
          environment: historicalEnv,
        }),
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
    return yield* Effect.try({
      try: () => resolveImportedThreadProviderOptionsForSettings(settings, input.modelSelection),
      catch: (cause) =>
        cause instanceof ImportThreadError
          ? cause
          : importMessagesError("Failed to resolve provider instance for thread import."),
    });
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
              kind: project.kind,
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
