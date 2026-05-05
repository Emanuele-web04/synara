import {
  getSessionInfo as getClaudeSessionInfo,
  getSessionMessages as getClaudeSessionMessages,
} from "@anthropic-ai/claude-agent-sdk";
import {
  CommandId,
  type OrchestrationImportThreadInput,
  type ThreadHandoffImportedMessage,
  type ThreadId,
} from "@t3tools/contracts";
import {
  deriveAssociatedWorktreeMetadata,
  workspaceRootsEqual,
} from "@t3tools/shared/threadWorkspace";
import type { FileSystem, Path } from "effect";
import { Data, Effect } from "effect";

import { resolveThreadWorkspaceCwd } from "../checkpointing/Utils";
import type { OrchestrationEngineShape } from "./Services/OrchestrationEngine";
import type { ProviderAdapterRegistryShape } from "../provider/Services/ProviderAdapterRegistry";
import type { ProviderServiceShape } from "../provider/Services/ProviderService";
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
  readonly providerAdapterRegistry: ProviderAdapterRegistryShape;
  readonly providerService: ProviderServiceShape;
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
  }) {
    const claudeSessionInfo = yield* Effect.tryPromise({
      try: () => getClaudeSessionInfo(input.externalId, input.cwd ? { dir: input.cwd } : undefined),
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
    readonly provider: "codex" | "opencode";
    readonly externalId: string;
    readonly projectWorkspaceRoot: string;
    readonly fallbackCwd?: string;
  }) {
    const adapter = yield* options.providerAdapterRegistry.getByProvider(input.provider);
    if (!adapter.readExternalThread) return null;

    const snapshot = yield* adapter
      .readExternalThread({
        externalThreadId: input.externalId,
        ...(input.fallbackCwd ? { cwd: input.fallbackCwd } : {}),
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
    readonly threadId: ThreadId;
  }) {
    const sessionMessages = yield* Effect.tryPromise({
      try: () =>
        getClaudeSessionMessages(input.externalId, input.cwd ? { dir: input.cwd } : undefined),
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

  const importOpenCodeThreadHistory = Effect.fn(function* (input: {
    readonly importedAt: string;
    readonly threadId: ThreadId;
  }) {
    const adapter = yield* options.providerAdapterRegistry.getByProvider("opencode");
    const snapshot = yield* adapter
      .readThread(input.threadId)
      .pipe(
        Effect.mapError((cause) =>
          importMessagesError(
            cause instanceof Error && cause.message.length > 0
              ? cause.message
              : "Failed to read OpenCode session history.",
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

  return Effect.fnUntraced(function* (body: ImportThreadRequest) {
    const readModel = yield* options.orchestrationEngine.getReadModel();
    const thread = readModel.threads.find((entry) => entry.id === body.threadId);
    if (!thread || thread.deletedAt !== null) {
      return yield* Effect.fail(importMessagesError(`Thread '${body.threadId}' was not found.`));
    }

    if (thread.session && thread.session.status !== "stopped") {
      return yield* Effect.fail(
        importMessagesError(`Thread '${body.threadId}' already has an active provider session.`),
      );
    }

    const cwd = resolveThreadWorkspaceCwd({
      thread,
      projects: readModel.projects,
    });
    const externalId = body.externalId.trim();
    const project = readModel.projects.find((entry) => entry.id === thread.projectId);

    const importedProviderContext =
      (thread.modelSelection.provider === "codex" ||
        thread.modelSelection.provider === "opencode") &&
      project
        ? yield* resolveImportedProviderThreadContext({
            provider: thread.modelSelection.provider,
            externalId,
            projectWorkspaceRoot: project.workspaceRoot,
            ...(cwd ? { fallbackCwd: cwd } : {}),
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

    if (thread.modelSelection.provider === "claudeAgent") {
      yield* ensureClaudeThreadImportable({
        cwd,
        externalId,
      });
    }

    const session = yield* options.providerService.startSession(thread.id, {
      threadId: thread.id,
      provider: thread.modelSelection.provider,
      ...((importedProviderContext?.runtimeCwd ?? cwd)
        ? { cwd: importedProviderContext?.runtimeCwd ?? cwd }
        : {}),
      modelSelection: thread.modelSelection,
      resumeCursor:
        thread.modelSelection.provider === "claudeAgent"
          ? { resume: externalId }
          : thread.modelSelection.provider === "opencode"
            ? { openCodeSessionId: externalId }
            : { threadId: externalId },
      runtimeMode: thread.runtimeMode,
    });

    if (thread.modelSelection.provider === "codex") {
      yield* importCodexThreadHistory({
        threadId: thread.id,
        importedAt: session.updatedAt,
      });
    } else if (thread.modelSelection.provider === "claudeAgent") {
      yield* importClaudeThreadHistory({
        threadId: thread.id,
        externalId,
        cwd,
        importedAt: session.updatedAt,
      });
    } else if (thread.modelSelection.provider === "opencode") {
      yield* importOpenCodeThreadHistory({
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
