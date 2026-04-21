/**
 * Server - HTTP/WebSocket server service interface.
 *
 * Owns startup and shutdown lifecycle of the HTTP server, static asset serving,
 * and WebSocket request routing.
 *
 * @module Server
 */
import http from "node:http";
import { realpathSync } from "node:fs";
import type { Duplex } from "node:stream";

import {
  getSessionInfo as getClaudeSessionInfo,
  getSessionMessages as getClaudeSessionMessages,
  type SessionMessage as ClaudeSessionMessage,
} from "@anthropic-ai/claude-agent-sdk";
import Mime from "@effect/platform-node/Mime";
import {
  CommandId,
  DEFAULT_TERMINAL_ID,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  type ClientOrchestrationCommand,
  MessageId,
  type OrchestrationEvent,
  type ThreadHandoffImportedMessage,
  type OrchestrationReadModel,
  type OrchestrationShellStreamEvent,
  type OrchestrationCommand,
  ORCHESTRATION_WS_CHANNELS,
  ORCHESTRATION_WS_METHODS,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  ProjectId,
  ThreadId,
  WS_CHANNELS,
  WS_METHODS,
  WebSocketRequest,
  type WsResponse as WsResponseMessage,
  WsResponse,
  type WsPushEnvelopeBase,
} from "@t3tools/contracts";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import {
  Cause,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Path,
  Ref,
  Result,
  Schema,
  Scope,
  ServiceMap,
  Stream,
  Struct,
} from "effect";
import OS from "node:os";
import { WebSocketServer, type WebSocket } from "ws";

import { createLogger } from "./logger";
import { resolveThreadWorkspaceCwd } from "./checkpointing/Utils.ts";
import { GitManager } from "./git/Services/GitManager.ts";
import { TerminalManager } from "./terminal/Services/Manager.ts";
import { Keybindings } from "./keybindings";
import {
  listWorkspaceDirectories,
  searchLocalEntries,
  searchWorkspaceEntries,
} from "./workspaceEntries";
import { OrchestrationEngineService } from "./orchestration/Services/OrchestrationEngine";
import { ProjectionSnapshotQuery } from "./orchestration/Services/ProjectionSnapshotQuery";
import { OrchestrationReactor } from "./orchestration/Services/OrchestrationReactor";
import { ProviderService } from "./provider/Services/ProviderService";
import { ProviderDiscoveryService } from "./provider/Services/ProviderDiscoveryService";
import { ProviderAdapterRegistry } from "./provider/Services/ProviderAdapterRegistry";
import { ProviderHealth } from "./provider/Services/ProviderHealth";
import { CheckpointDiffQuery } from "./checkpointing/Services/CheckpointDiffQuery";
import { clamp } from "effect/Number";
import { Open, resolveAvailableEditors } from "./open";
import { ServerConfig } from "./config";
import { GitCore } from "./git/Services/GitCore.ts";
import { tryHandleProjectFaviconRequest } from "./projectFaviconRoute";
import {
  ATTACHMENTS_ROUTE_PREFIX,
  normalizeAttachmentRelativePath,
  resolveAttachmentRelativePath,
} from "./attachmentPaths";

import {
  createAttachmentId,
  resolveAttachmentPath,
  resolveAttachmentPathById,
} from "./attachmentStore.ts";
import { parseBase64DataUrl } from "./imageMime.ts";
import { AnalyticsService } from "./telemetry/Services/AnalyticsService.ts";
import { expandHomePath } from "./os-jank.ts";
import { makeServerPushBus } from "./wsServer/pushBus.ts";
import { makeServerReadiness } from "./wsServer/readiness.ts";
import { decodeJsonResult, formatSchemaError } from "@t3tools/shared/schemaJson";
import {
  deriveAssociatedWorktreeMetadata,
  workspaceRootsEqual,
} from "@t3tools/shared/threadWorkspace";
import { TerminalThreadTitleTracker } from "./terminal/terminalThreadTitleTracker";

/**
 * ServerShape - Service API for server lifecycle control.
 */
export interface ServerShape {
  /**
   * Start HTTP and WebSocket listeners.
   */
  readonly start: Effect.Effect<
    http.Server,
    ServerLifecycleError,
    Scope.Scope | ServerRuntimeServices | ServerConfig | FileSystem.FileSystem | Path.Path
  >;

  /**
   * Wait for process shutdown signals.
   */
  readonly stopSignal: Effect.Effect<void, never>;
}

/**
 * Server - Service tag for HTTP/WebSocket lifecycle management.
 */
export class Server extends ServiceMap.Service<Server, ServerShape>()("t3/wsServer/Server") {}

const isServerNotRunningError = (error: Error): boolean => {
  const maybeCode = (error as NodeJS.ErrnoException).code;
  return (
    maybeCode === "ERR_SERVER_NOT_RUNNING" || error.message.toLowerCase().includes("not running")
  );
};

const parseManagedWorktreeWorkspaceRoot = (input: {
  gitPointerFileContents: string;
  path: Path.Path;
  worktreePath: string;
}): string | null => {
  const firstLine = input.gitPointerFileContents.split(/\r?\n/, 1)[0]?.trim() ?? "";
  if (!firstLine.toLowerCase().startsWith("gitdir:")) {
    return null;
  }
  const gitdirValue = firstLine.slice("gitdir:".length).trim();
  if (!gitdirValue) {
    return null;
  }
  const resolvedGitdir = input.path.isAbsolute(gitdirValue)
    ? input.path.normalize(gitdirValue)
    : input.path.resolve(input.worktreePath, gitdirValue);
  const marker = `${input.path.sep}.git${input.path.sep}worktrees${input.path.sep}`;
  const markerIndex = resolvedGitdir.lastIndexOf(marker);
  if (markerIndex < 0) {
    return null;
  }
  return resolvedGitdir.slice(0, markerIndex);
};

function rejectUpgrade(socket: Duplex, statusCode: number, message: string): void {
  socket.end(
    `HTTP/1.1 ${statusCode} ${statusCode === 401 ? "Unauthorized" : "Bad Request"}\r\n` +
      "Connection: close\r\n" +
      "Content-Type: text/plain\r\n" +
      `Content-Length: ${Buffer.byteLength(message)}\r\n` +
      "\r\n" +
      message,
  );
}

type BootstrapSnapshotThread = OrchestrationReadModel["threads"][number];

interface ClientOrchestrationSubscriptions {
  readonly shell: boolean;
  readonly threadIds: ReadonlySet<ThreadId>;
}

function isThreadDetailEvent(event: OrchestrationEvent): event is Extract<
  OrchestrationEvent,
  {
    type:
      | "thread.message-sent"
      | "thread.proposed-plan-upserted"
      | "thread.activity-appended"
      | "thread.turn-diff-completed"
      | "thread.reverted"
      | "thread.session-set";
  }
> {
  return (
    event.type === "thread.message-sent" ||
    event.type === "thread.proposed-plan-upserted" ||
    event.type === "thread.activity-appended" ||
    event.type === "thread.turn-diff-completed" ||
    event.type === "thread.reverted" ||
    event.type === "thread.session-set"
  );
}

function toSortableBootstrapTimestamp(iso: string | undefined): number {
  if (!iso) {
    return Number.NEGATIVE_INFINITY;
  }
  const timestamp = Date.parse(iso);
  return Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY;
}

function getLatestBootstrapUserMessageTimestamp(thread: BootstrapSnapshotThread): number {
  let latestUserMessageTimestamp = Number.NEGATIVE_INFINITY;

  for (const message of thread.messages) {
    if (message.role !== "user") {
      continue;
    }
    latestUserMessageTimestamp = Math.max(
      latestUserMessageTimestamp,
      toSortableBootstrapTimestamp(message.createdAt),
    );
  }

  if (latestUserMessageTimestamp !== Number.NEGATIVE_INFINITY) {
    return latestUserMessageTimestamp;
  }

  return toSortableBootstrapTimestamp(thread.updatedAt ?? thread.createdAt);
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

function readTranscriptTextParts(value: unknown): ReadonlyArray<string> {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((part) => {
    if (!part || typeof part !== "object") {
      return [];
    }

    const candidate = part as {
      readonly type?: unknown;
      readonly text?: unknown;
    };
    return candidate.type === "text" && typeof candidate.text === "string" ? [candidate.text] : [];
  });
}

function readCodexSnapshotMessageText(value: unknown): string {
  if (!value || typeof value !== "object") {
    return "";
  }

  const candidate = value as {
    readonly text?: unknown;
    readonly content?: unknown;
  };

  if (typeof candidate.text === "string") {
    return candidate.text;
  }

  return readTranscriptTextParts(candidate.content).join("");
}

function mapCodexSnapshotMessages(input: {
  readonly importedAt: string;
  readonly threadId: ThreadId;
  readonly turns: ReadonlyArray<{
    readonly items: ReadonlyArray<unknown>;
  }>;
}): ReadonlyArray<ThreadHandoffImportedMessage> {
  return input.turns.flatMap((turn, turnIndex) =>
    turn.items.flatMap((item, itemIndex) => {
      if (!item || typeof item !== "object") {
        return [];
      }

      const candidate = item as {
        readonly type?: unknown;
        readonly content?: unknown;
      };
      const role =
        candidate.type === "userMessage"
          ? "user"
          : candidate.type === "agentMessage"
            ? "assistant"
            : null;
      if (role === null) {
        return [];
      }

      const text = readCodexSnapshotMessageText(candidate);
      if (text.length === 0) {
        return [];
      }

      return [
        {
          messageId: MessageId.makeUnsafe(
            `import:${String(input.threadId)}:${turnIndex}:${itemIndex}`,
          ),
          role,
          text,
          createdAt: input.importedAt,
          updatedAt: input.importedAt,
        },
      ];
    }),
  );
}

function readClaudeSessionMessageText(value: unknown): string {
  if (!value || typeof value !== "object") {
    return typeof value === "string" ? value : "";
  }

  const candidate = value as {
    readonly content?: unknown;
    readonly text?: unknown;
  };
  if (typeof candidate.text === "string") {
    return candidate.text;
  }

  if (typeof candidate.content === "string") {
    return candidate.content;
  }

  return readTranscriptTextParts(candidate.content).join("\n\n");
}

function mapClaudeSessionMessages(input: {
  readonly importedAt: string;
  readonly threadId: ThreadId;
  readonly messages: ReadonlyArray<ClaudeSessionMessage>;
}): ReadonlyArray<ThreadHandoffImportedMessage> {
  return input.messages.flatMap((message, messageIndex) => {
    if (message.type !== "user" && message.type !== "assistant") {
      return [];
    }

    const text = readClaudeSessionMessageText(message.message).trim();
    if (text.length === 0) {
      return [];
    }

    return [
      {
        messageId: MessageId.makeUnsafe(
          `import:${String(input.threadId)}:claude:${messageIndex}:${message.uuid}`,
        ),
        role: message.type,
        text,
        createdAt: input.importedAt,
        updatedAt: input.importedAt,
      },
    ];
  });
}

function buildImportMessagesError(message: string): RouteRequestError {
  return new RouteRequestError({ message });
}

function getMostRecentBootstrapThread(
  snapshot: OrchestrationReadModel,
): BootstrapSnapshotThread | null {
  const activeProjectIds = new Set(
    snapshot.projects.filter((project) => project.deletedAt === null).map((project) => project.id),
  );

  return (
    snapshot.threads
      .filter(
        (thread) =>
          thread.deletedAt === null &&
          (thread.archivedAt ?? null) === null &&
          activeProjectIds.has(thread.projectId),
      )
      .toSorted((left, right) => {
        const rightTimestamp = getLatestBootstrapUserMessageTimestamp(right);
        const leftTimestamp = getLatestBootstrapUserMessageTimestamp(left);
        const byTimestamp =
          rightTimestamp === leftTimestamp ? 0 : rightTimestamp > leftTimestamp ? 1 : -1;
        if (byTimestamp !== 0) {
          return byTimestamp;
        }
        return right.id.localeCompare(left.id);
      })[0] ?? null
  );
}

function websocketRawToString(raw: unknown): string | null {
  if (typeof raw === "string") {
    return raw;
  }
  if (raw instanceof Uint8Array) {
    return Buffer.from(raw).toString("utf8");
  }
  if (raw instanceof ArrayBuffer) {
    return Buffer.from(new Uint8Array(raw)).toString("utf8");
  }
  if (Array.isArray(raw)) {
    const chunks: string[] = [];
    for (const chunk of raw) {
      if (typeof chunk === "string") {
        chunks.push(chunk);
        continue;
      }
      if (chunk instanceof Uint8Array) {
        chunks.push(Buffer.from(chunk).toString("utf8"));
        continue;
      }
      if (chunk instanceof ArrayBuffer) {
        chunks.push(Buffer.from(new Uint8Array(chunk)).toString("utf8"));
        continue;
      }
      return null;
    }
    return chunks.join("");
  }
  return null;
}

function toPosixRelativePath(input: string): string {
  return input.replaceAll("\\", "/");
}

function resolveWorkspaceWritePath(params: {
  workspaceRoot: string;
  relativePath: string;
  path: Path.Path;
}): Effect.Effect<{ absolutePath: string; relativePath: string }, RouteRequestError> {
  const normalizedInputPath = params.relativePath.trim();
  if (params.path.isAbsolute(normalizedInputPath)) {
    return Effect.fail(
      new RouteRequestError({
        message: "Workspace file path must be relative to the project root.",
      }),
    );
  }

  const absolutePath = params.path.resolve(params.workspaceRoot, normalizedInputPath);
  const relativeToRoot = toPosixRelativePath(
    params.path.relative(params.workspaceRoot, absolutePath),
  );
  if (
    relativeToRoot.length === 0 ||
    relativeToRoot === "." ||
    relativeToRoot.startsWith("../") ||
    relativeToRoot === ".." ||
    params.path.isAbsolute(relativeToRoot)
  ) {
    return Effect.fail(
      new RouteRequestError({
        message: "Workspace file path must stay within the project root.",
      }),
    );
  }

  return Effect.succeed({
    absolutePath,
    relativePath: relativeToRoot,
  });
}

function stripRequestTag<T extends { _tag: string }>(body: T) {
  return Struct.omit(body, ["_tag"]);
}

const encodeWsResponse = Schema.encodeEffect(Schema.fromJsonString(WsResponse));
const decodeWebSocketRequest = decodeJsonResult(WebSocketRequest);

export type ServerCoreRuntimeServices =
  | OrchestrationEngineService
  | ProjectionSnapshotQuery
  | CheckpointDiffQuery
  | OrchestrationReactor
  | ProviderService
  | ProviderDiscoveryService
  | ProviderAdapterRegistry
  | ProviderHealth;

export type ServerRuntimeServices =
  | ServerCoreRuntimeServices
  | GitManager
  | GitCore
  | TerminalManager
  | Keybindings
  | Open
  | AnalyticsService;

export class ServerLifecycleError extends Schema.TaggedErrorClass<ServerLifecycleError>()(
  "ServerLifecycleError",
  {
    operation: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {}

class RouteRequestError extends Schema.TaggedErrorClass<RouteRequestError>()("RouteRequestError", {
  message: Schema.String,
}) {}

// Summarize noisy websocket pushes so explicit debug logging stays useful
// without dumping ANSI-heavy terminal redraw traffic into the server logs.
function summarizePushForLog(push: WsPushEnvelopeBase): unknown {
  if (push.channel !== WS_CHANNELS.terminalEvent || typeof push.data !== "object" || !push.data) {
    return push.data;
  }

  const event = push.data as Record<string, unknown>;
  const threadId = typeof event.threadId === "string" ? event.threadId : undefined;
  const terminalId = typeof event.terminalId === "string" ? event.terminalId : undefined;
  const createdAt = typeof event.createdAt === "string" ? event.createdAt : undefined;
  const type = typeof event.type === "string" ? event.type : "unknown";

  if (type === "output") {
    const data = typeof event.data === "string" ? event.data : "";
    return {
      type,
      threadId,
      terminalId,
      createdAt,
      outputBytes: Buffer.byteLength(data),
      preview: "redacted",
    };
  }

  const snapshot =
    typeof event.snapshot === "object" && event.snapshot
      ? (event.snapshot as Record<string, unknown>)
      : null;

  if (type === "started" || type === "restarted") {
    const history = typeof snapshot?.history === "string" ? snapshot.history : "";
    return {
      type,
      threadId,
      terminalId,
      createdAt,
      snapshot: {
        cwd: typeof snapshot?.cwd === "string" ? snapshot.cwd : undefined,
        status: typeof snapshot?.status === "string" ? snapshot.status : undefined,
        pid: typeof snapshot?.pid === "number" ? snapshot.pid : null,
        historyBytes: Buffer.byteLength(history),
      },
    };
  }

  return {
    ...event,
    ...(snapshot
      ? {
          snapshot: {
            cwd: typeof snapshot.cwd === "string" ? snapshot.cwd : undefined,
            status: typeof snapshot.status === "string" ? snapshot.status : undefined,
            pid: typeof snapshot.pid === "number" ? snapshot.pid : null,
          },
        }
      : {}),
  };
}

export const createServer = Effect.fn(function* (): Effect.fn.Return<
  http.Server,
  ServerLifecycleError,
  Scope.Scope | ServerRuntimeServices | ServerConfig | FileSystem.FileSystem | Path.Path
> {
  const serverConfig = yield* ServerConfig;
  const {
    port,
    cwd,
    homeDir,
    keybindingsConfigPath,
    staticDir,
    devUrl,
    authToken,
    host,
    logWebSocketEvents,
    autoBootstrapProjectFromCwd,
  } = serverConfig;
  const availableEditors = resolveAvailableEditors();

  const gitManager = yield* GitManager;
  const terminalManager = yield* TerminalManager;
  const keybindingsManager = yield* Keybindings;
  const providerService = yield* ProviderService;
  const providerHealth = yield* ProviderHealth;
  const providerDiscoveryService = yield* ProviderDiscoveryService;
  const providerAdapterRegistry = yield* ProviderAdapterRegistry;
  const git = yield* GitCore;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  yield* keybindingsManager.syncDefaultKeybindingsOnStartup.pipe(
    Effect.catch((error) =>
      Effect.logWarning("failed to sync keybindings defaults on startup", {
        path: error.configPath,
        detail: error.detail,
        cause: error.cause,
      }),
    ),
  );

  const clients = yield* Ref.make(new Set<WebSocket>());
  const logger = createLogger("ws");
  const readiness = yield* makeServerReadiness;

  // Canonicalizes imported workspace roots once at the server boundary.
  const canonicalizeProjectWorkspaceRoot = Effect.fnUntraced(function* (workspaceRoot: string) {
    const normalizedWorkspaceRoot = path.resolve(yield* expandHomePath(workspaceRoot.trim()));
    const workspaceStat = yield* fileSystem
      .stat(normalizedWorkspaceRoot)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (!workspaceStat) {
      return yield* new RouteRequestError({
        message: `Project directory does not exist: ${normalizedWorkspaceRoot}`,
      });
    }
    if (workspaceStat.type !== "Directory") {
      return yield* new RouteRequestError({
        message: `Project path is not a directory: ${normalizedWorkspaceRoot}`,
      });
    }
    return yield* Effect.try({
      try: () => realpathSync.native(normalizedWorkspaceRoot),
      catch: () => normalizedWorkspaceRoot,
    });
  });

  const listManagedWorktrees = Effect.fnUntraced(function* () {
    const worktreeParentEntries = yield* fileSystem
      .readDirectory(serverConfig.worktreesDir, { recursive: false })
      .pipe(Effect.catch(() => Effect.succeed([] as Array<string>)));

    const discoveredWorktrees: Array<{ path: string; workspaceRoot: string }> = [];

    for (const parentEntry of worktreeParentEntries) {
      const parentPath = path.join(serverConfig.worktreesDir, parentEntry);
      const parentStat = yield* fileSystem
        .stat(parentPath)
        .pipe(Effect.catch(() => Effect.succeed(null)));
      if (!parentStat || parentStat.type !== "Directory") {
        continue;
      }

      const worktreeEntries = yield* fileSystem
        .readDirectory(parentPath, { recursive: false })
        .pipe(Effect.catch(() => Effect.succeed([] as Array<string>)));

      for (const worktreeEntry of worktreeEntries) {
        const worktreePath = path.join(parentPath, worktreeEntry);
        const worktreeStat = yield* fileSystem
          .stat(worktreePath)
          .pipe(Effect.catch(() => Effect.succeed(null)));
        if (!worktreeStat || worktreeStat.type !== "Directory") {
          continue;
        }

        const gitPointerFileContents = yield* fileSystem
          .readFileString(path.join(worktreePath, ".git"))
          .pipe(Effect.catch(() => Effect.succeed(null)));
        if (!gitPointerFileContents) {
          continue;
        }

        const workspaceRoot = parseManagedWorktreeWorkspaceRoot({
          gitPointerFileContents,
          path,
          worktreePath,
        });
        if (!workspaceRoot) {
          continue;
        }

        discoveredWorktrees.push({
          path: worktreePath,
          workspaceRoot,
        });
      }
    }

    return Array.from(
      new Map(discoveredWorktrees.map((worktree) => [worktree.path, worktree])).values(),
    ).toSorted(
      (left, right) =>
        left.workspaceRoot.localeCompare(right.workspaceRoot) ||
        left.path.localeCompare(right.path),
    );
  });

  function logOutgoingPush(push: WsPushEnvelopeBase, recipients: number) {
    if (!logWebSocketEvents) return;
    logger.event("outgoing push", {
      channel: push.channel,
      sequence: push.sequence,
      recipients,
      payload: summarizePushForLog(push),
    });
  }

  const pushBus = yield* makeServerPushBus({
    clients,
    logOutgoingPush,
  });
  yield* readiness.markPushBusReady;
  yield* keybindingsManager.start.pipe(
    Effect.mapError(
      (cause) => new ServerLifecycleError({ operation: "keybindingsRuntimeStart", cause }),
    ),
  );
  yield* readiness.markKeybindingsReady;

  const normalizeDispatchCommand = Effect.fnUntraced(function* (input: {
    readonly command: ClientOrchestrationCommand;
  }) {
    if (input.command.type === "project.create") {
      return {
        ...input.command,
        workspaceRoot: yield* canonicalizeProjectWorkspaceRoot(input.command.workspaceRoot),
      } satisfies OrchestrationCommand;
    }

    if (input.command.type === "project.meta.update" && input.command.workspaceRoot !== undefined) {
      return {
        ...input.command,
        workspaceRoot: yield* canonicalizeProjectWorkspaceRoot(input.command.workspaceRoot),
      } satisfies OrchestrationCommand;
    }

    if (input.command.type !== "thread.turn.start") {
      return input.command as OrchestrationCommand;
    }
    const turnStartCommand = input.command;

    const normalizedAttachments = yield* Effect.forEach(
      turnStartCommand.message.attachments,
      (attachment) =>
        Effect.gen(function* () {
          if (attachment.type === "assistant-selection") {
            const attachmentId = createAttachmentId(turnStartCommand.threadId);
            if (!attachmentId) {
              return yield* new RouteRequestError({
                message: "Failed to create a safe attachment id.",
              });
            }

            return {
              type: "assistant-selection" as const,
              id: attachmentId,
              assistantMessageId: attachment.assistantMessageId,
              text: attachment.text,
            };
          }

          const parsed = parseBase64DataUrl(attachment.dataUrl);
          if (!parsed || !parsed.mimeType.startsWith("image/")) {
            return yield* new RouteRequestError({
              message: `Invalid image attachment payload for '${attachment.name}'.`,
            });
          }

          const bytes = Buffer.from(parsed.base64, "base64");
          if (bytes.byteLength === 0 || bytes.byteLength > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
            return yield* new RouteRequestError({
              message: `Image attachment '${attachment.name}' is empty or too large.`,
            });
          }

          const attachmentId = createAttachmentId(turnStartCommand.threadId);
          if (!attachmentId) {
            return yield* new RouteRequestError({
              message: "Failed to create a safe attachment id.",
            });
          }

          const persistedAttachment = {
            type: "image" as const,
            id: attachmentId,
            name: attachment.name,
            mimeType: parsed.mimeType.toLowerCase(),
            sizeBytes: bytes.byteLength,
          };

          const attachmentPath = resolveAttachmentPath({
            attachmentsDir: serverConfig.attachmentsDir,
            attachment: persistedAttachment,
          });
          if (!attachmentPath) {
            return yield* new RouteRequestError({
              message: `Failed to resolve persisted path for '${attachment.name}'.`,
            });
          }

          yield* fileSystem.makeDirectory(path.dirname(attachmentPath), { recursive: true }).pipe(
            Effect.mapError(
              () =>
                new RouteRequestError({
                  message: `Failed to create attachment directory for '${attachment.name}'.`,
                }),
            ),
          );
          yield* fileSystem.writeFile(attachmentPath, bytes).pipe(
            Effect.mapError(
              () =>
                new RouteRequestError({
                  message: `Failed to persist attachment '${attachment.name}'.`,
                }),
            ),
          );

          return persistedAttachment;
        }),
      { concurrency: 1 },
    );

    return {
      ...turnStartCommand,
      message: {
        ...turnStartCommand.message,
        attachments: normalizedAttachments,
      },
    } satisfies OrchestrationCommand;
  });
  const terminalTitleTracker = new TerminalThreadTitleTracker();
  // Terminal auto-titles are best-effort metadata and must never block terminal writes.
  const maybeAutoRenameTerminalThread = Effect.fnUntraced(function* (input: {
    threadId: string;
    terminalId: string;
    data: string;
  }) {
    const readModel = yield* orchestrationEngine.getReadModel();
    const thread = readModel.threads.find((entry) => entry.id === input.threadId);
    if (!thread) {
      return;
    }
    const nextTitle = terminalTitleTracker.consumeWrite({
      currentTitle: thread.title,
      data: input.data,
      terminalId: input.terminalId,
      threadId: input.threadId,
    });
    if (!nextTitle) {
      return;
    }

    yield* orchestrationEngine.dispatch({
      type: "thread.meta.update",
      commandId: CommandId.makeUnsafe(crypto.randomUUID()),
      threadId: ThreadId.makeUnsafe(input.threadId),
      title: nextTitle,
    });
  });

  // HTTP server — serves lightweight health checks, assets, and the web app shell.
  const httpServer = http.createServer((req, res) => {
    const respond = (
      statusCode: number,
      headers: Record<string, string>,
      body?: string | Uint8Array,
    ) => {
      res.writeHead(statusCode, headers);
      res.end(body);
    };

    void Effect.runPromise(
      Effect.gen(function* () {
        const url = new URL(req.url ?? "/", `http://localhost:${port}`);
        if (url.pathname === "/health") {
          const readinessSnapshot = yield* readiness.getSnapshot;
          respond(
            200,
            { "Content-Type": "application/json; charset=utf-8" },
            JSON.stringify({
              status: "ok",
              startupReady: readinessSnapshot.startupReady,
              pushBusReady: readinessSnapshot.pushBusReady,
              keybindingsReady: readinessSnapshot.keybindingsReady,
              terminalSubscriptionsReady: readinessSnapshot.terminalSubscriptionsReady,
              orchestrationSubscriptionsReady: readinessSnapshot.orchestrationSubscriptionsReady,
            }),
          );
          return;
        }

        if (tryHandleProjectFaviconRequest(url, res)) {
          return;
        }

        if (url.pathname.startsWith(ATTACHMENTS_ROUTE_PREFIX)) {
          const rawRelativePath = url.pathname.slice(ATTACHMENTS_ROUTE_PREFIX.length);
          const normalizedRelativePath = normalizeAttachmentRelativePath(rawRelativePath);
          if (!normalizedRelativePath) {
            respond(400, { "Content-Type": "text/plain" }, "Invalid attachment path");
            return;
          }

          const isIdLookup =
            !normalizedRelativePath.includes("/") && !normalizedRelativePath.includes(".");
          const filePath = isIdLookup
            ? resolveAttachmentPathById({
                attachmentsDir: serverConfig.attachmentsDir,
                attachmentId: normalizedRelativePath,
              })
            : resolveAttachmentRelativePath({
                attachmentsDir: serverConfig.attachmentsDir,
                relativePath: normalizedRelativePath,
              });
          if (!filePath) {
            respond(
              isIdLookup ? 404 : 400,
              { "Content-Type": "text/plain" },
              isIdLookup ? "Not Found" : "Invalid attachment path",
            );
            return;
          }

          const fileInfo = yield* fileSystem
            .stat(filePath)
            .pipe(Effect.catch(() => Effect.succeed(null)));
          if (!fileInfo || fileInfo.type !== "File") {
            respond(404, { "Content-Type": "text/plain" }, "Not Found");
            return;
          }

          const contentType = Mime.getType(filePath) ?? "application/octet-stream";
          res.writeHead(200, {
            "Content-Type": contentType,
            "Cache-Control": "public, max-age=31536000, immutable",
          });
          const streamExit = yield* Stream.runForEach(fileSystem.stream(filePath), (chunk) =>
            Effect.sync(() => {
              if (!res.destroyed) {
                res.write(chunk);
              }
            }),
          ).pipe(Effect.exit);
          if (Exit.isFailure(streamExit)) {
            if (!res.destroyed) {
              res.destroy();
            }
            return;
          }
          if (!res.writableEnded) {
            res.end();
          }
          return;
        }

        // In dev mode, redirect to Vite dev server
        if (devUrl) {
          respond(302, { Location: devUrl.href });
          return;
        }

        // Serve static files from the web app build
        if (!staticDir) {
          respond(
            503,
            { "Content-Type": "text/plain" },
            "No static directory configured and no dev URL set.",
          );
          return;
        }

        const staticRoot = path.resolve(staticDir);
        const staticRequestPath = url.pathname === "/" ? "/index.html" : url.pathname;
        const rawStaticRelativePath = staticRequestPath.replace(/^[/\\]+/, "");
        const hasRawLeadingParentSegment = rawStaticRelativePath.startsWith("..");
        const staticRelativePath = path.normalize(rawStaticRelativePath).replace(/^[/\\]+/, "");
        const hasPathTraversalSegment = staticRelativePath.startsWith("..");
        if (
          staticRelativePath.length === 0 ||
          hasRawLeadingParentSegment ||
          hasPathTraversalSegment ||
          staticRelativePath.includes("\0")
        ) {
          respond(400, { "Content-Type": "text/plain" }, "Invalid static file path");
          return;
        }

        const isWithinStaticRoot = (candidate: string) =>
          candidate === staticRoot ||
          candidate.startsWith(
            staticRoot.endsWith(path.sep) ? staticRoot : `${staticRoot}${path.sep}`,
          );

        let filePath = path.resolve(staticRoot, staticRelativePath);
        if (!isWithinStaticRoot(filePath)) {
          respond(400, { "Content-Type": "text/plain" }, "Invalid static file path");
          return;
        }

        const ext = path.extname(filePath);
        if (!ext) {
          filePath = path.resolve(filePath, "index.html");
          if (!isWithinStaticRoot(filePath)) {
            respond(400, { "Content-Type": "text/plain" }, "Invalid static file path");
            return;
          }
        }

        const fileInfo = yield* fileSystem
          .stat(filePath)
          .pipe(Effect.catch(() => Effect.succeed(null)));
        if (!fileInfo || fileInfo.type !== "File") {
          const indexPath = path.resolve(staticRoot, "index.html");
          const indexData = yield* fileSystem
            .readFile(indexPath)
            .pipe(Effect.catch(() => Effect.succeed(null)));
          if (!indexData) {
            respond(404, { "Content-Type": "text/plain" }, "Not Found");
            return;
          }
          respond(200, { "Content-Type": "text/html; charset=utf-8" }, indexData);
          return;
        }

        const contentType = Mime.getType(filePath) ?? "application/octet-stream";
        const data = yield* fileSystem
          .readFile(filePath)
          .pipe(Effect.catch(() => Effect.succeed(null)));
        if (!data) {
          respond(500, { "Content-Type": "text/plain" }, "Internal Server Error");
          return;
        }
        respond(200, { "Content-Type": contentType }, data);
      }),
    ).catch(() => {
      if (!res.headersSent) {
        respond(500, { "Content-Type": "text/plain" }, "Internal Server Error");
      }
    });
  });

  // WebSocket server — upgrades from the HTTP server
  const wss = new WebSocketServer({ noServer: true });

  const closeWebSocketServer = Effect.callback<void, ServerLifecycleError>((resume) => {
    wss.close((error) => {
      if (error && !isServerNotRunningError(error)) {
        resume(
          Effect.fail(
            new ServerLifecycleError({ operation: "closeWebSocketServer", cause: error }),
          ),
        );
      } else {
        resume(Effect.void);
      }
    });
  });

  const closeAllClients = Ref.get(clients).pipe(
    Effect.flatMap(Effect.forEach((client) => Effect.sync(() => client.close()))),
    Effect.flatMap(() => Ref.set(clients, new Set())),
  );

  const listenOptions = host ? { host, port } : { port };

  // Listen as soon as the health and static handlers are attached so desktop
  // startup can distinguish "backend is alive but still warming up" from a
  // true launch failure.
  yield* NodeHttpServer.make(() => httpServer, listenOptions).pipe(
    Effect.mapError((cause) => new ServerLifecycleError({ operation: "httpServerListen", cause })),
  );
  yield* readiness.markHttpListening;

  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionReadModelQuery = yield* ProjectionSnapshotQuery;
  const checkpointDiffQuery = yield* CheckpointDiffQuery;
  const orchestrationReactor = yield* OrchestrationReactor;
  const { openInEditor } = yield* Open;

  const subscriptionsScope = yield* Scope.make("sequential");
  yield* Effect.addFinalizer(() => Scope.close(subscriptionsScope, Exit.void));

  const clientOrchestrationSubscriptions = new Map<WebSocket, ClientOrchestrationSubscriptions>();

  const getClientOrchestrationSubscriptions = (ws: WebSocket): ClientOrchestrationSubscriptions => {
    const existing = clientOrchestrationSubscriptions.get(ws);
    if (existing) {
      return existing;
    }
    const initial: ClientOrchestrationSubscriptions = {
      shell: false,
      threadIds: new Set<ThreadId>(),
    };
    clientOrchestrationSubscriptions.set(ws, initial);
    return initial;
  };

  const setClientOrchestrationSubscriptions = (
    ws: WebSocket,
    subscriptions: ClientOrchestrationSubscriptions,
  ): void => {
    clientOrchestrationSubscriptions.set(ws, subscriptions);
  };

  const clearClientOrchestrationSubscriptions = (ws: WebSocket): void => {
    clientOrchestrationSubscriptions.delete(ws);
  };

  const toShellStreamEvent = (
    event: OrchestrationEvent,
  ): Effect.Effect<Option.Option<OrchestrationShellStreamEvent>, never, never> => {
    switch (event.type) {
      case "project.created":
      case "project.meta-updated":
        return projectionReadModelQuery.getProjectShellById(event.payload.projectId).pipe(
          Effect.map((project) =>
            Option.map(project, (nextProject) => ({
              kind: "project-upserted" as const,
              sequence: event.sequence,
              project: nextProject,
            })),
          ),
          Effect.catch(() => Effect.succeed(Option.none())),
        );
      case "project.deleted":
        return Effect.succeed(
          Option.some({
            kind: "project-removed" as const,
            sequence: event.sequence,
            projectId: event.payload.projectId,
          }),
        );
      case "thread.deleted":
        return Effect.succeed(
          Option.some({
            kind: "thread-removed" as const,
            sequence: event.sequence,
            threadId: event.payload.threadId,
          }),
        );
      default:
        if (event.aggregateKind !== "thread") {
          return Effect.succeed(Option.none());
        }
        return projectionReadModelQuery
          .getThreadShellById(ThreadId.makeUnsafe(String(event.aggregateId)))
          .pipe(
            Effect.map((thread) =>
              Option.map(thread, (nextThread) => ({
                kind: "thread-upserted" as const,
                sequence: event.sequence,
                thread: nextThread,
              })),
            ),
            Effect.catch(() => Effect.succeed(Option.none())),
          );
    }
  };

  const publishScopedOrchestrationEvent = Effect.fnUntraced(function* (event: OrchestrationEvent) {
    const connectedClients = yield* Ref.get(clients);
    const threadDetailEvent =
      event.aggregateKind === "thread" && isThreadDetailEvent(event)
        ? {
            threadId: ThreadId.makeUnsafe(String(event.aggregateId)),
            payload: {
              kind: "event" as const,
              event,
            },
          }
        : null;
    let shellEvent: Option.Option<OrchestrationShellStreamEvent> | null = null;

    for (const client of connectedClients) {
      const subscriptions = getClientOrchestrationSubscriptions(client);
      const hasScopedSubscriptions = subscriptions.shell || subscriptions.threadIds.size > 0;
      // Preserve the legacy firehose for callers that have not opted into
      // scoped orchestration subscriptions yet.
      if (!hasScopedSubscriptions) {
        yield* pushBus
          .publishClient(client, ORCHESTRATION_WS_CHANNELS.domainEvent, event)
          .pipe(Effect.asVoid);
        continue;
      }

      if (subscriptions.shell) {
        if (shellEvent === null) {
          shellEvent = yield* toShellStreamEvent(event);
        }
        if (Option.isSome(shellEvent)) {
          yield* pushBus
            .publishClient(client, ORCHESTRATION_WS_CHANNELS.shellEvent, shellEvent.value)
            .pipe(Effect.asVoid);
        }
      }

      if (threadDetailEvent === null) {
        continue;
      }

      if (!subscriptions.threadIds.has(threadDetailEvent.threadId)) {
        continue;
      }

      yield* pushBus
        .publishClient(client, ORCHESTRATION_WS_CHANNELS.threadEvent, threadDetailEvent.payload)
        .pipe(Effect.asVoid);
    }
  });

  yield* Stream.runForEach(
    orchestrationEngine.streamDomainEvents,
    publishScopedOrchestrationEvent,
  ).pipe(Effect.forkIn(subscriptionsScope));

  yield* Stream.runForEach(keybindingsManager.streamChanges, (event) =>
    Effect.gen(function* () {
      const providerStatuses = yield* providerHealth.getStatuses;
      yield* pushBus.publishAll(WS_CHANNELS.serverConfigUpdated, {
        issues: event.issues,
        providers: providerStatuses,
      });
    }),
  ).pipe(Effect.forkIn(subscriptionsScope));

  yield* Stream.runForEach(providerHealth.streamChanges, (providerStatuses) =>
    pushBus.publishAll(WS_CHANNELS.serverProviderStatusesUpdated, {
      providers: providerStatuses,
    }),
  ).pipe(Effect.forkIn(subscriptionsScope));

  yield* Scope.provide(orchestrationReactor.start, subscriptionsScope);
  yield* readiness.markOrchestrationSubscriptionsReady;

  let welcomeBootstrapProjectId: ProjectId | undefined;
  let welcomeBootstrapThreadId: ThreadId | undefined;

  if (autoBootstrapProjectFromCwd) {
    yield* Effect.gen(function* () {
      const canonicalCwd = yield* canonicalizeProjectWorkspaceRoot(cwd);
      const snapshot = yield* projectionReadModelQuery.getSnapshot();
      const mostRecentThread = getMostRecentBootstrapThread(snapshot);
      const existingProject = snapshot.projects.find(
        (project) =>
          project.kind === "project" &&
          project.deletedAt === null &&
          workspaceRootsEqual(project.workspaceRoot, canonicalCwd, {
            platform: process.platform,
          }),
      );
      let bootstrapProjectId: ProjectId;
      let bootstrapProjectDefaultModelSelection;

      if (!existingProject) {
        const createdAt = new Date().toISOString();
        bootstrapProjectId = ProjectId.makeUnsafe(crypto.randomUUID());
        const bootstrapProjectTitle = path.basename(cwd) || "project";
        bootstrapProjectDefaultModelSelection = {
          provider: "codex" as const,
          model: "gpt-5-codex",
        };
        yield* orchestrationEngine.dispatch({
          type: "project.create",
          commandId: CommandId.makeUnsafe(crypto.randomUUID()),
          projectId: bootstrapProjectId,
          kind: "project",
          title: bootstrapProjectTitle,
          workspaceRoot: canonicalCwd,
          defaultModelSelection: bootstrapProjectDefaultModelSelection,
          createdAt,
        });
      } else {
        bootstrapProjectId = existingProject.id;
        bootstrapProjectDefaultModelSelection = existingProject.defaultModelSelection ?? {
          provider: "codex" as const,
          model: "gpt-5-codex",
        };
      }

      if (mostRecentThread) {
        welcomeBootstrapProjectId = mostRecentThread.projectId;
        welcomeBootstrapThreadId = mostRecentThread.id;
        return;
      }

      const existingThread = snapshot.threads.find(
        (thread) =>
          thread.projectId === bootstrapProjectId &&
          thread.deletedAt === null &&
          (thread.archivedAt ?? null) === null,
      );
      if (!existingThread) {
        const createdAt = new Date().toISOString();
        const threadId = ThreadId.makeUnsafe(crypto.randomUUID());
        yield* orchestrationEngine.dispatch({
          type: "thread.create",
          commandId: CommandId.makeUnsafe(crypto.randomUUID()),
          threadId,
          projectId: bootstrapProjectId,
          title: "New thread",
          modelSelection: bootstrapProjectDefaultModelSelection,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access",
          envMode: "local",
          branch: null,
          worktreePath: null,
          createdAt,
        });
        welcomeBootstrapProjectId = bootstrapProjectId;
        welcomeBootstrapThreadId = threadId;
      } else {
        welcomeBootstrapProjectId = bootstrapProjectId;
        welcomeBootstrapThreadId = existingThread.id;
      }
    }).pipe(
      Effect.mapError(
        (cause) => new ServerLifecycleError({ operation: "autoBootstrapProject", cause }),
      ),
    );
  }

  const runtimeServices = yield* Effect.services<
    ServerRuntimeServices | ServerConfig | FileSystem.FileSystem | Path.Path
  >();
  const runPromise = Effect.runPromiseWith(runtimeServices);

  const unsubscribeTerminalEvents = yield* terminalManager.subscribe(
    (event) => void Effect.runPromise(pushBus.publishAll(WS_CHANNELS.terminalEvent, event)),
  );
  yield* Effect.addFinalizer(() => Effect.sync(() => unsubscribeTerminalEvents()));
  yield* readiness.markTerminalSubscriptionsReady;

  yield* Effect.addFinalizer(() =>
    Effect.all([closeAllClients, closeWebSocketServer.pipe(Effect.ignoreCause({ log: true }))]),
  );

  const dispatchImportedMessages = (input: {
    readonly createdAt: string;
    readonly messages: ReadonlyArray<ThreadHandoffImportedMessage>;
    readonly threadId: ThreadId;
  }) =>
    input.messages.length === 0
      ? Effect.void
      : orchestrationEngine.dispatch({
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
        buildImportMessagesError(
          cause instanceof Error && cause.message.length > 0
            ? cause.message
            : "Failed to inspect Claude session metadata.",
        ),
    });

    if (claudeSessionInfo) {
      return;
    }

    const sessionFoundElsewhere = yield* Effect.tryPromise({
      try: () => getClaudeSessionInfo(input.externalId),
      catch: () => undefined,
    });

    return yield* buildImportMessagesError(
      sessionFoundElsewhere && input.cwd
        ? `Claude session '${input.externalId}' exists, but not for this workspace. Claude resume only works when the session file is stored for '${input.cwd}'.`
        : `Claude session '${input.externalId}' was not found on this machine for this workspace. Claude import only works with a locally persisted Claude session ID.`,
    );
  });

  const resolveImportedCodexThreadContext = Effect.fn(function* (input: {
    readonly externalId: string;
    readonly projectWorkspaceRoot: string;
    readonly fallbackCwd?: string;
  }) {
    const adapter = yield* providerAdapterRegistry.getByProvider("codex");
    if (!adapter.readExternalThread) {
      return null;
    }

    const snapshot = yield* adapter
      .readExternalThread({
        externalThreadId: input.externalId,
        ...(input.fallbackCwd ? { cwd: input.fallbackCwd } : {}),
      })
      .pipe(Effect.catch(() => Effect.succeed(null)));
    const externalCwd = snapshot?.cwd?.trim();
    if (!externalCwd) {
      return null;
    }

    if (
      workspaceRootsEqual(input.projectWorkspaceRoot, externalCwd, {
        platform: process.platform,
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

    const relativeToProjectRoot = path.relative(input.projectWorkspaceRoot, externalCwd);
    if (
      relativeToProjectRoot.length > 0 &&
      !relativeToProjectRoot.startsWith("..") &&
      !path.isAbsolute(relativeToProjectRoot)
    ) {
      return {
        runtimeCwd: externalCwd,
        patch: null,
      };
    }

    let currentPath = externalCwd;
    while (true) {
      const gitPointerFileContents = yield* fileSystem
        .readFileString(path.join(currentPath, ".git"))
        .pipe(Effect.catch(() => Effect.succeed(null)));

      if (gitPointerFileContents) {
        const workspaceRoot = parseManagedWorktreeWorkspaceRoot({
          gitPointerFileContents,
          path,
          worktreePath: currentPath,
        });
        if (
          workspaceRoot &&
          workspaceRootsEqual(input.projectWorkspaceRoot, workspaceRoot, {
            platform: process.platform,
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

      const parentPath = path.dirname(currentPath);
      if (parentPath === currentPath) {
        return null;
      }
      currentPath = parentPath;
    }
  });

  const importCodexThreadHistory = Effect.fn(function* (input: {
    readonly importedAt: string;
    readonly threadId: ThreadId;
  }) {
    const adapter = yield* providerAdapterRegistry.getByProvider("codex");
    const snapshot = yield* adapter
      .readThread(input.threadId)
      .pipe(
        Effect.mapError((cause) =>
          buildImportMessagesError(
            cause instanceof Error && cause.message.length > 0
              ? cause.message
              : "Failed to read Codex thread history.",
          ),
        ),
      );

    const importedMessages = mapCodexSnapshotMessages({
      threadId: input.threadId,
      turns: snapshot.turns,
      importedAt: input.importedAt,
    });

    yield* dispatchImportedMessages({
      threadId: input.threadId,
      messages: importedMessages,
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
        buildImportMessagesError(
          cause instanceof Error && cause.message.length > 0
            ? cause.message
            : "Failed to read Claude session history.",
        ),
    });

    const importedMessages = mapClaudeSessionMessages({
      threadId: input.threadId,
      messages: sessionMessages,
      importedAt: input.importedAt,
    });

    yield* dispatchImportedMessages({
      threadId: input.threadId,
      messages: importedMessages,
      createdAt: input.importedAt,
    });
  });

  const routeRequest = Effect.fnUntraced(function* (ws: WebSocket, request: WebSocketRequest) {
    switch (request.body._tag) {
      case ORCHESTRATION_WS_METHODS.getSnapshot:
        return yield* projectionReadModelQuery.getSnapshot();

      case ORCHESTRATION_WS_METHODS.repairState: {
        yield* orchestrationEngine.repairState();
        return yield* projectionReadModelQuery.getSnapshot();
      }

      case ORCHESTRATION_WS_METHODS.dispatchCommand: {
        const { command } = request.body;
        const normalizedCommand = yield* normalizeDispatchCommand({ command });
        return yield* orchestrationEngine.dispatch(normalizedCommand);
      }

      case ORCHESTRATION_WS_METHODS.importThread: {
        const body = request.body;
        if (body._tag !== ORCHESTRATION_WS_METHODS.importThread) {
          return undefined;
        }
        const readModel = yield* orchestrationEngine.getReadModel();
        const thread = readModel.threads.find((entry) => entry.id === body.threadId);
        if (!thread || thread.deletedAt !== null) {
          return yield* new RouteRequestError({
            message: `Thread '${body.threadId}' was not found.`,
          });
        }

        if (thread.session && thread.session.status !== "stopped") {
          return yield* new RouteRequestError({
            message: `Thread '${body.threadId}' already has an active provider session.`,
          });
        }

        const cwd = resolveThreadWorkspaceCwd({
          thread,
          projects: readModel.projects,
        });
        const externalId = body.externalId.trim();
        const project = readModel.projects.find((entry) => entry.id === thread.projectId);

        const importedCodexContext =
          thread.modelSelection.provider === "codex" && project
            ? yield* resolveImportedCodexThreadContext({
                externalId,
                projectWorkspaceRoot: project.workspaceRoot,
                ...(cwd ? { fallbackCwd: cwd } : {}),
              })
            : null;

        if (importedCodexContext?.patch) {
          yield* orchestrationEngine.dispatch({
            type: "thread.meta.update",
            commandId: CommandId.makeUnsafe(crypto.randomUUID()),
            threadId: thread.id,
            ...importedCodexContext.patch,
          });
        }

        if (thread.modelSelection.provider === "claudeAgent") {
          yield* ensureClaudeThreadImportable({
            cwd,
            externalId,
          });
        }

        const session = yield* providerService.startSession(thread.id, {
          threadId: thread.id,
          provider: thread.modelSelection.provider,
          ...((importedCodexContext?.runtimeCwd ?? cwd)
            ? { cwd: importedCodexContext?.runtimeCwd ?? cwd }
            : {}),
          modelSelection: thread.modelSelection,
          resumeCursor:
            thread.modelSelection.provider === "claudeAgent"
              ? { resume: externalId }
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
        }

        yield* orchestrationEngine.dispatch({
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
      }

      case ORCHESTRATION_WS_METHODS.getTurnDiff: {
        const body = stripRequestTag(request.body);
        return yield* checkpointDiffQuery.getTurnDiff(body);
      }

      case ORCHESTRATION_WS_METHODS.getFullThreadDiff: {
        const body = stripRequestTag(request.body);
        return yield* checkpointDiffQuery.getFullThreadDiff(body);
      }

      case ORCHESTRATION_WS_METHODS.replayEvents: {
        const { fromSequenceExclusive } = request.body;
        return yield* Stream.runCollect(
          orchestrationEngine.readEvents(
            clamp(fromSequenceExclusive, {
              maximum: Number.MAX_SAFE_INTEGER,
              minimum: 0,
            }),
          ),
        ).pipe(Effect.map((events) => Array.from(events)));
      }

      case ORCHESTRATION_WS_METHODS.subscribeShell: {
        const subscriptions = getClientOrchestrationSubscriptions(ws);
        setClientOrchestrationSubscriptions(ws, {
          ...subscriptions,
          shell: true,
        });
        const snapshot = yield* projectionReadModelQuery.getShellSnapshot();
        yield* pushBus
          .publishClient(ws, ORCHESTRATION_WS_CHANNELS.shellEvent, {
            kind: "snapshot" as const,
            snapshot,
          })
          .pipe(Effect.asVoid);
        return undefined;
      }

      case ORCHESTRATION_WS_METHODS.unsubscribeShell: {
        const subscriptions = getClientOrchestrationSubscriptions(ws);
        setClientOrchestrationSubscriptions(ws, {
          ...subscriptions,
          shell: false,
        });
        return undefined;
      }

      case ORCHESTRATION_WS_METHODS.subscribeThread: {
        const subscriptions = getClientOrchestrationSubscriptions(ws);
        const nextThreadIds = new Set(subscriptions.threadIds);
        nextThreadIds.add(request.body.threadId);
        setClientOrchestrationSubscriptions(ws, {
          ...subscriptions,
          threadIds: nextThreadIds,
        });
        const threadSnapshot = yield* projectionReadModelQuery.getThreadDetailSnapshotById(
          request.body.threadId,
        );
        if (Option.isSome(threadSnapshot)) {
          yield* pushBus
            .publishClient(ws, ORCHESTRATION_WS_CHANNELS.threadEvent, {
              kind: "snapshot" as const,
              snapshot: threadSnapshot.value,
            })
            .pipe(Effect.asVoid);
        }
        return undefined;
      }

      case ORCHESTRATION_WS_METHODS.unsubscribeThread: {
        const subscriptions = getClientOrchestrationSubscriptions(ws);
        const nextThreadIds = new Set(subscriptions.threadIds);
        nextThreadIds.delete(request.body.threadId);
        setClientOrchestrationSubscriptions(ws, {
          ...subscriptions,
          threadIds: nextThreadIds,
        });
        return undefined;
      }

      case WS_METHODS.projectsSearchEntries: {
        const body = stripRequestTag(request.body);
        return yield* Effect.tryPromise({
          try: () => searchWorkspaceEntries(body),
          catch: (cause) =>
            new RouteRequestError({
              message: `Failed to search workspace entries: ${String(cause)}`,
            }),
        });
      }

      case WS_METHODS.projectsListDirectories: {
        const body = stripRequestTag(request.body);
        return yield* Effect.tryPromise({
          try: () => listWorkspaceDirectories(body),
          catch: (cause) =>
            new RouteRequestError({
              message: `Failed to list workspace directories: ${String(cause)}`,
            }),
        });
      }

      case WS_METHODS.projectsSearchLocalEntries: {
        const body = stripRequestTag(request.body);
        return yield* Effect.tryPromise({
          try: () => searchLocalEntries(body),
          catch: (cause) =>
            new RouteRequestError({
              message: `Failed to search local entries: ${String(cause)}`,
            }),
        });
      }

      case WS_METHODS.projectsWriteFile: {
        const body = stripRequestTag(request.body);
        const target = yield* resolveWorkspaceWritePath({
          workspaceRoot: body.cwd,
          relativePath: body.relativePath,
          path,
        });
        yield* fileSystem
          .makeDirectory(path.dirname(target.absolutePath), { recursive: true })
          .pipe(
            Effect.mapError(
              (cause) =>
                new RouteRequestError({
                  message: `Failed to prepare workspace path: ${String(cause)}`,
                }),
            ),
          );
        yield* fileSystem.writeFileString(target.absolutePath, body.contents).pipe(
          Effect.mapError(
            (cause) =>
              new RouteRequestError({
                message: `Failed to write workspace file: ${String(cause)}`,
              }),
          ),
        );
        return { relativePath: target.relativePath };
      }

      case WS_METHODS.shellOpenInEditor: {
        const body = stripRequestTag(request.body);
        return yield* openInEditor(body);
      }

      case WS_METHODS.gitStatus: {
        const body = stripRequestTag(request.body);
        return yield* gitManager.status(body);
      }

      case WS_METHODS.gitReadWorkingTreeDiff: {
        const body = stripRequestTag(request.body);
        return yield* gitManager.readWorkingTreeDiff(body);
      }

      case WS_METHODS.gitSummarizeDiff: {
        const body = stripRequestTag(request.body);
        return yield* gitManager.summarizeDiff(body);
      }

      case WS_METHODS.gitPull: {
        const body = stripRequestTag(request.body);
        return yield* git.pullCurrentBranch(body.cwd);
      }

      case WS_METHODS.gitRunStackedAction: {
        const body = stripRequestTag(request.body);
        return yield* gitManager.runStackedAction(body, {
          actionId: body.actionId,
          progressReporter: {
            publish: (event) =>
              pushBus.publishClient(ws, WS_CHANNELS.gitActionProgress, event).pipe(Effect.asVoid),
          },
        });
      }

      case WS_METHODS.gitResolvePullRequest: {
        const body = stripRequestTag(request.body);
        return yield* gitManager.resolvePullRequest(body);
      }

      case WS_METHODS.gitPreparePullRequestThread: {
        const body = stripRequestTag(request.body);
        return yield* gitManager.preparePullRequestThread(body);
      }

      case WS_METHODS.gitListBranches: {
        const body = stripRequestTag(request.body);
        return yield* git.listBranches(body);
      }

      case WS_METHODS.gitCreateWorktree: {
        const body = stripRequestTag(request.body);
        return yield* git.createWorktree(body);
      }

      case WS_METHODS.gitCreateDetachedWorktree: {
        const body = stripRequestTag(request.body);
        return yield* git.createDetachedWorktree(body);
      }

      case WS_METHODS.gitRemoveWorktree: {
        const body = stripRequestTag(request.body);
        return yield* git.removeWorktree(body);
      }

      case WS_METHODS.gitCreateBranch: {
        const body = stripRequestTag(request.body);
        return yield* git.createBranch(body);
      }

      case WS_METHODS.gitCheckout: {
        const body = stripRequestTag(request.body);
        return yield* Effect.scoped(git.checkoutBranch(body));
      }

      case WS_METHODS.gitInit: {
        const body = stripRequestTag(request.body);
        return yield* git.initRepo(body);
      }

      case WS_METHODS.gitHandoffThread: {
        const body = stripRequestTag(request.body);
        return yield* gitManager.handoffThread(body);
      }

      case WS_METHODS.terminalOpen: {
        const body = stripRequestTag(request.body);
        terminalTitleTracker.reset(body.threadId, body.terminalId ?? DEFAULT_TERMINAL_ID);
        return yield* terminalManager.open(body);
      }

      case WS_METHODS.terminalWrite: {
        const body = stripRequestTag(request.body);
        yield* terminalManager.write(body);
        yield* maybeAutoRenameTerminalThread({
          threadId: body.threadId,
          terminalId: body.terminalId ?? DEFAULT_TERMINAL_ID,
          data: body.data,
        }).pipe(Effect.catch(() => Effect.void));
        return;
      }

      case WS_METHODS.terminalResize: {
        const body = stripRequestTag(request.body);
        return yield* terminalManager.resize(body);
      }

      case WS_METHODS.terminalClear: {
        const body = stripRequestTag(request.body);
        return yield* terminalManager.clear(body);
      }

      case WS_METHODS.terminalRestart: {
        const body = stripRequestTag(request.body);
        terminalTitleTracker.reset(body.threadId, body.terminalId ?? DEFAULT_TERMINAL_ID);
        return yield* terminalManager.restart(body);
      }

      case WS_METHODS.terminalClose: {
        const body = stripRequestTag(request.body);
        terminalTitleTracker.reset(body.threadId, body.terminalId ?? null);
        return yield* terminalManager.close(body);
      }

      case WS_METHODS.serverGetConfig:
        const keybindingsConfig = yield* keybindingsManager.loadConfigState;
        const providerStatuses = yield* providerHealth.getStatuses;
        return {
          cwd,
          homeDir,
          worktreesDir: serverConfig.worktreesDir,
          keybindingsConfigPath,
          keybindings: keybindingsConfig.keybindings,
          issues: keybindingsConfig.issues,
          providers: providerStatuses,
          availableEditors,
        };

      case WS_METHODS.serverRefreshProviders:
        return {
          providers: yield* providerHealth.refresh,
        };

      case WS_METHODS.serverListWorktrees:
        return {
          worktrees: yield* listManagedWorktrees(),
        };

      case WS_METHODS.serverTranscribeVoice: {
        const body = stripRequestTag(request.body);
        const adapter = yield* providerAdapterRegistry.getByProvider(body.provider);
        if (!adapter.transcribeVoice) {
          return yield* new RouteRequestError({
            message: `Voice transcription is unavailable for provider '${body.provider}'.`,
          });
        }
        return yield* adapter.transcribeVoice(body).pipe(
          Effect.mapError(
            (cause) =>
              new RouteRequestError({
                message:
                  cause instanceof Error && cause.message.length > 0
                    ? cause.message
                    : "Voice transcription failed.",
              }),
          ),
        );
      }

      case WS_METHODS.serverUpsertKeybinding: {
        const body = stripRequestTag(request.body);
        const keybindingsConfig = yield* keybindingsManager.upsertKeybindingRule(body);
        return { keybindings: keybindingsConfig, issues: [] };
      }

      case WS_METHODS.providerGetComposerCapabilities: {
        const body = stripRequestTag(request.body);
        return yield* providerDiscoveryService.getComposerCapabilities(body);
      }

      case WS_METHODS.providerCompactThread: {
        const body = stripRequestTag(request.body);
        return yield* providerService.compactThread(body);
      }

      case WS_METHODS.providerListCommands: {
        const body = stripRequestTag(request.body);
        return yield* providerDiscoveryService.listCommands(body);
      }

      case WS_METHODS.providerListSkills: {
        const body = stripRequestTag(request.body);
        return yield* providerDiscoveryService.listSkills(body);
      }

      case WS_METHODS.providerListPlugins: {
        const body = stripRequestTag(request.body);
        return yield* providerDiscoveryService.listPlugins(body);
      }

      case WS_METHODS.providerReadPlugin: {
        const body = stripRequestTag(request.body);
        return yield* providerDiscoveryService.readPlugin(body);
      }

      case WS_METHODS.providerListModels: {
        const body = stripRequestTag(request.body);
        return yield* providerDiscoveryService.listModels(body);
      }

      case WS_METHODS.providerListAgents: {
        const body = stripRequestTag(request.body);
        return yield* providerDiscoveryService.listAgents(body);
      }

      default: {
        const _exhaustiveCheck: never = request.body;
        return yield* new RouteRequestError({
          message: `Unknown method: ${String(_exhaustiveCheck)}`,
        });
      }
    }
  });

  const handleMessage = Effect.fnUntraced(function* (ws: WebSocket, raw: unknown) {
    const sendWsResponse = (response: WsResponseMessage) =>
      encodeWsResponse(response).pipe(
        Effect.tap((encodedResponse) => Effect.sync(() => ws.send(encodedResponse))),
        Effect.asVoid,
      );

    const messageText = websocketRawToString(raw);
    if (messageText === null) {
      return yield* sendWsResponse({
        id: "unknown",
        error: { message: "Invalid request format: Failed to read message" },
      });
    }

    const request = decodeWebSocketRequest(messageText);
    if (Result.isFailure(request)) {
      return yield* sendWsResponse({
        id: "unknown",
        error: { message: `Invalid request format: ${formatSchemaError(request.failure)}` },
      });
    }

    const result = yield* Effect.exit(routeRequest(ws, request.success));
    if (Exit.isFailure(result)) {
      return yield* sendWsResponse({
        id: request.success.id,
        error: { message: Cause.pretty(result.cause) },
      });
    }

    return yield* sendWsResponse({
      id: request.success.id,
      result: result.value,
    });
  });

  httpServer.on("upgrade", (request, socket, head) => {
    socket.on("error", () => {}); // Prevent unhandled `EPIPE`/`ECONNRESET` from crashing the process if the client disconnects mid-handshake

    if (authToken) {
      let providedToken: string | null = null;
      try {
        const url = new URL(request.url ?? "/", `http://localhost:${port}`);
        providedToken = url.searchParams.get("token");
      } catch {
        rejectUpgrade(socket, 400, "Invalid WebSocket URL");
        return;
      }

      if (providedToken !== authToken) {
        rejectUpgrade(socket, 401, "Unauthorized WebSocket connection");
        return;
      }
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  });

  wss.on("connection", (ws) => {
    const segments = cwd.split(/[/\\]/).filter(Boolean);
    const projectName = segments[segments.length - 1] ?? "project";

    const welcomeData = {
      cwd,
      homeDir: OS.homedir(),
      projectName,
      ...(welcomeBootstrapProjectId ? { bootstrapProjectId: welcomeBootstrapProjectId } : {}),
      ...(welcomeBootstrapThreadId ? { bootstrapThreadId: welcomeBootstrapThreadId } : {}),
    };
    // Send welcome before adding to broadcast set so publishAll calls
    // cannot reach this client before the welcome arrives.
    void runPromise(
      readiness.awaitServerReady.pipe(
        Effect.flatMap(() => pushBus.publishClient(ws, WS_CHANNELS.serverWelcome, welcomeData)),
        Effect.flatMap((delivered) =>
          delivered ? Ref.update(clients, (clients) => clients.add(ws)) : Effect.void,
        ),
      ),
    );

    ws.on("message", (raw) => {
      void runPromise(handleMessage(ws, raw).pipe(Effect.ignoreCause({ log: true })));
    });

    ws.on("close", () => {
      clearClientOrchestrationSubscriptions(ws);
      void runPromise(
        Ref.update(clients, (clients) => {
          clients.delete(ws);
          return clients;
        }),
      );
    });

    ws.on("error", () => {
      clearClientOrchestrationSubscriptions(ws);
      void runPromise(
        Ref.update(clients, (clients) => {
          clients.delete(ws);
          return clients;
        }),
      );
    });
  });

  return httpServer;
});

export const ServerLive = Layer.succeed(Server, {
  start: createServer(),
  stopSignal: Effect.never,
} satisfies ServerShape);
