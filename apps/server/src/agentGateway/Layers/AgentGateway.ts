/**
 * AgentGatewayLive - Synara app-control MCP tool surface.
 *
 * Implements the `synara_*` tools served over `POST /mcp` (streamable HTTP,
 * stateless JSON responses). Every provider session gets this endpoint plus a
 * thread-bound bearer token injected at session start, so any agent running in
 * a Synara thread can list/read/create/steer threads and manage heartbeat
 * automations - the same host-tool pattern the Codex desktop app uses.
 *
 * All tools delegate to existing services (OrchestrationEngine dispatch,
 * ProjectionSnapshotQuery reads, AutomationService, GitCore); no orchestration
 * state lives here.
 *
 * @module agentGateway/Layers/AgentGateway
 */
import { randomUUID } from "node:crypto";

import {
  AutomationId,
  CommandId,
  DEFAULT_MODEL_BY_PROVIDER,
  MessageId,
  ProjectId,
  ThreadId,
  type ModelSelection,
  type ProviderKind,
  type TurnDispatchMode,
} from "@t3tools/contracts";
import { buildPromptThreadTitleFallback } from "@t3tools/shared/chatThreads";
import { Effect, Layer, Option } from "effect";

import { GitCore } from "../../git/Services/GitCore.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { AutomationService } from "../../automation/Services/AutomationService.ts";
import { AgentGateway, type AgentGatewayShape } from "../Services/AgentGateway.ts";
import { AgentGatewayCredentials } from "../Services/AgentGatewayCredentials.ts";
import {
  buildMcpInitializeResult,
  jsonRpcError,
  jsonRpcResult,
  JSON_RPC_INVALID_PARAMS,
  JSON_RPC_INVALID_REQUEST,
  JSON_RPC_METHOD_NOT_FOUND,
  mcpToolResultError,
  mcpToolResultJson,
  parseMcpMessage,
  type JsonRpcRequest,
  type McpToolCallResult,
  type McpToolDefinition,
} from "../protocol.ts";
import { summarizeThreadDetail, summarizeThreadShell } from "../threadSummary.ts";
import { extractBearerToken } from "../tokens.ts";

const LIST_THREADS_DEFAULT_LIMIT = 50;
const LIST_THREADS_MAX_LIMIT = 200;
const HEARTBEAT_DEFAULT_INTERVAL_MINUTES = 5;
const HEARTBEAT_DEFAULT_MAX_ITERATIONS = 50;

const PROVIDER_KINDS: ReadonlyArray<ProviderKind> = [
  "codex",
  "claudeAgent",
  "cursor",
  "gemini",
  "grok",
  "kilo",
  "opencode",
  "pi",
];

const AGENT_GATEWAY_INSTRUCTIONS = `You are connected to Synara, the app hosting this session. When the user asks to create, inspect, continue, steer, archive, rename, or otherwise manage Synara threads, use the synara_* tools instead of simulating actions.

Guidelines:
- Use synara_list_threads before reading or steering threads you do not know.
- Use synara_list_projects before creating a thread in another project.
- Use synara_create_thread only when the user explicitly asks for a new/background thread or the work genuinely benefits from a parallel worker. Threads you create are ordinary standalone threads; keep track of their ids to follow up on them.
- For periodic monitoring ("check every N minutes"), create a heartbeat automation on your own thread with synara_create_automation instead of relying on memory, then read the threads you spawned on each wake and cancel the automation with synara_cancel_automation when the work is done.
- When coordinated work finishes, synthesize the results and reference thread ids and statuses.
- Report tool results back to the user with thread ids, status, and next actions.`;

interface ToolContext {
  readonly callerThreadId: string;
}

type ToolHandler = (
  args: Record<string, unknown>,
  context: ToolContext,
) => Effect.Effect<McpToolCallResult>;

interface ToolEntry {
  readonly definition: McpToolDefinition;
  readonly handler: ToolHandler;
}

class ToolInputError extends Error {}

function readStringArg(
  args: Record<string, unknown>,
  name: string,
  options?: { readonly required?: boolean },
): string | undefined {
  const value = args[name];
  if (value === undefined || value === null) {
    if (options?.required) throw new ToolInputError(`Missing required argument "${name}".`);
    return undefined;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ToolInputError(`Argument "${name}" must be a non-empty string.`);
  }
  return value.trim();
}

function readNumberArg(args: Record<string, unknown>, name: string): number | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ToolInputError(`Argument "${name}" must be a number.`);
  }
  return value;
}

function readBooleanArg(args: Record<string, unknown>, name: string): boolean | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") {
    throw new ToolInputError(`Argument "${name}" must be a boolean.`);
  }
  return value;
}

function parseProviderKind(raw: string): ProviderKind {
  if ((PROVIDER_KINDS as ReadonlyArray<string>).includes(raw)) {
    return raw as ProviderKind;
  }
  throw new ToolInputError(
    `Unknown provider "${raw}". Supported providers: ${PROVIDER_KINDS.join(", ")}.`,
  );
}

function buildModelSelection(provider: ProviderKind, model: string | undefined): ModelSelection {
  const effectiveModel =
    model ??
    (provider === "pi"
      ? undefined
      : DEFAULT_MODEL_BY_PROVIDER[provider as Exclude<ProviderKind, "pi">]);
  if (!effectiveModel) {
    throw new ToolInputError(
      `Provider "${provider}" has no default model; pass an explicit "model" argument.`,
    );
  }
  return { provider, model: effectiveModel } as ModelSelection;
}

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "task"
  );
}

function isoNow(): string {
  return new Date().toISOString();
}

function makeAgentIds() {
  const id = randomUUID();
  return {
    threadId: ThreadId.makeUnsafe(`agent:${id}`),
    threadCreateCommandId: CommandId.makeUnsafe(`agent:${id}:thread-create`),
    turnStartCommandId: CommandId.makeUnsafe(`agent:${id}:turn-start`),
    messageId: MessageId.makeUnsafe(`agent:${id}:message`),
  };
}

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const makeAgentGateway = Effect.gen(function* () {
  const credentials = yield* AgentGatewayCredentials;
  const snapshotQuery = yield* ProjectionSnapshotQuery;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const automationService = yield* AutomationService;
  const git = yield* GitCore;

  const requireThreadShell = (threadId: string) =>
    snapshotQuery.getThreadShellById(ThreadId.makeUnsafe(threadId)).pipe(
      Effect.mapError((error) => new ToolInputError(errorText(error))),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(new ToolInputError(`Thread "${threadId}" was not found.`)),
          onSome: (shell) => Effect.succeed(shell),
        }),
      ),
    );

  // --- read tools -----------------------------------------------------------

  const listProjects: ToolEntry = {
    definition: {
      name: "synara_list_projects",
      description:
        "List Synara projects (id, title, workspace root). Use before creating a thread in another project.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    handler: () =>
      snapshotQuery.getShellSnapshot().pipe(
        Effect.map((snapshot) =>
          mcpToolResultJson({
            projects: snapshot.projects.map((project) => ({
              projectId: project.id,
              title: project.title,
              workspaceRoot: project.workspaceRoot,
              isPinned: project.isPinned,
            })),
          }),
        ),
        Effect.catch((error) => Effect.succeed(mcpToolResultError(errorText(error)))),
      ),
  };

  const listThreads: ToolEntry = {
    definition: {
      name: "synara_list_threads",
      description:
        "List Synara threads with status (working/idle/waiting-for-approval/...), provider, model and hierarchy. Filter by projectId or parentThreadId. Archived threads are hidden unless includeArchived is true.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string", description: "Only threads of this project." },
          parentThreadId: {
            type: "string",
            description: "Only child threads of this thread (e.g. your own thread id).",
          },
          includeArchived: { type: "boolean", description: "Include archived threads." },
          limit: { type: "number", description: "Max results (default 50, max 200)." },
        },
        additionalProperties: false,
      },
    },
    handler: (args, context) =>
      Effect.gen(function* () {
        const projectId = readStringArg(args, "projectId");
        const parentThreadId = readStringArg(args, "parentThreadId");
        const includeArchived = readBooleanArg(args, "includeArchived") ?? false;
        const limit = Math.max(
          1,
          Math.min(
            readNumberArg(args, "limit") ?? LIST_THREADS_DEFAULT_LIMIT,
            LIST_THREADS_MAX_LIMIT,
          ),
        );
        const snapshot = yield* snapshotQuery
          .getShellSnapshot()
          .pipe(Effect.mapError((error) => new ToolInputError(errorText(error))));
        const matching = snapshot.threads
          .filter((thread) => (projectId ? thread.projectId === projectId : true))
          .filter((thread) => (parentThreadId ? thread.parentThreadId === parentThreadId : true))
          .filter((thread) => (includeArchived ? true : (thread.archivedAt ?? null) === null))
          .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
        const threads = matching
          .slice(0, limit)
          .map((thread) => summarizeThreadShell(thread, context.callerThreadId));
        return mcpToolResultJson({ threads, totalMatching: matching.length });
      }).pipe(Effect.catch((error) => Effect.succeed(mcpToolResultError(errorText(error))))),
  };

  const readThread: ToolEntry = {
    definition: {
      name: "synara_read_thread",
      description:
        "Read one thread's status and recent messages (newest last, truncated). Pass the returned nextCursor as cursor to page older messages.",
      inputSchema: {
        type: "object",
        properties: {
          threadId: { type: "string", description: "Thread to read." },
          cursor: { type: "string", description: "Pagination cursor from a previous call." },
          messageLimit: { type: "number", description: "Messages per page (default 20, max 100)." },
          maxMessageChars: {
            type: "number",
            description: "Per-message truncation limit (default 1500).",
          },
        },
        required: ["threadId"],
        additionalProperties: false,
      },
    },
    handler: (args, context) =>
      Effect.gen(function* () {
        const threadId = readStringArg(args, "threadId", { required: true })!;
        const cursor = readStringArg(args, "cursor");
        const messageLimit = readNumberArg(args, "messageLimit");
        const maxMessageChars = readNumberArg(args, "maxMessageChars");
        const detail = yield* snapshotQuery.getThreadDetailById(ThreadId.makeUnsafe(threadId)).pipe(
          Effect.mapError((error) => new ToolInputError(errorText(error))),
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.fail(new ToolInputError(`Thread "${threadId}" was not found.`)),
              onSome: (thread) => Effect.succeed(thread),
            }),
          ),
        );
        return mcpToolResultJson(
          summarizeThreadDetail({
            thread: detail,
            callerThreadId: context.callerThreadId,
            cursor,
            messageLimit,
            maxMessageChars,
          }),
        );
      }).pipe(Effect.catch((error) => Effect.succeed(mcpToolResultError(errorText(error))))),
  };

  // --- write tools ----------------------------------------------------------

  const createThread: ToolEntry = {
    definition: {
      name: "synara_create_thread",
      description:
        "Create a new standalone Synara thread and send it an initial task prompt. Supports any provider/model (e.g. a Grok worker from a Codex thread) and an optional isolated git worktree for file-editing tasks. Keep the returned threadId to follow up on it.",
      inputSchema: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "Initial task message for the new thread." },
          provider: {
            type: "string",
            enum: [...PROVIDER_KINDS],
            description: "Provider running the new thread.",
          },
          model: {
            type: "string",
            description: "Model slug; defaults to the provider's default model.",
          },
          projectId: {
            type: "string",
            description: "Target project; defaults to your thread's project.",
          },
          environment: {
            type: "string",
            enum: ["local", "worktree"],
            description:
              "local = share the project workspace (default for local callers, read-only work); worktree = isolated git worktree (for file edits). Threads running in a worktree default to worktree and cannot spawn local workers.",
          },
          baseBranch: {
            type: "string",
            description: "Worktree only: branch to fork from; defaults to the current branch.",
          },
          branchName: {
            type: "string",
            description: "Worktree only: new branch name; defaults to a generated agent/ branch.",
          },
          runtimeMode: {
            type: "string",
            enum: ["approval-required", "full-access"],
            description:
              "Defaults to your thread's runtime mode. Cannot exceed it: an approval-required caller cannot spawn full-access threads.",
          },
        },
        required: ["prompt", "provider"],
        additionalProperties: false,
      },
    },
    handler: (args, context) =>
      Effect.gen(function* () {
        const prompt = readStringArg(args, "prompt", { required: true })!;
        const provider = parseProviderKind(readStringArg(args, "provider", { required: true })!);
        const model = readStringArg(args, "model");
        const environmentArg = readStringArg(args, "environment");
        if (
          environmentArg !== undefined &&
          environmentArg !== "local" &&
          environmentArg !== "worktree"
        ) {
          throw new ToolInputError(`Argument "environment" must be "local" or "worktree".`);
        }
        const runtimeModeArg = readStringArg(args, "runtimeMode");
        if (
          runtimeModeArg !== undefined &&
          runtimeModeArg !== "approval-required" &&
          runtimeModeArg !== "full-access"
        ) {
          throw new ToolInputError(
            `Argument "runtimeMode" must be "approval-required" or "full-access".`,
          );
        }

        // The caller only provides defaults (project, runtime mode); the new
        // thread is an ordinary top-level thread with no parent linkage.
        const caller = yield* requireThreadShell(context.callerThreadId);

        // Isolation boundary: a caller the user confined to a worktree must
        // not place workers on the shared project checkout. Default to a
        // fresh worktree and reject explicit "local" requests.
        const callerIsolatedInWorktree = caller.envMode === "worktree";
        if (environmentArg === "local" && callerIsolatedInWorktree) {
          throw new ToolInputError(
            'Your thread runs in an isolated worktree, so spawned threads cannot use environment "local". Omit environment (defaults to "worktree") or ask the user to run this task from a local thread.',
          );
        }
        const environment = environmentArg ?? (callerIsolatedInWorktree ? "worktree" : "local");

        const projectIdArg = readStringArg(args, "projectId");
        const projectId = ProjectId.makeUnsafe(projectIdArg ?? caller.projectId);
        const project = yield* snapshotQuery.getProjectShellById(projectId).pipe(
          Effect.mapError((error) => new ToolInputError(errorText(error))),
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.fail(new ToolInputError(`Project "${projectId}" was not found.`)),
              onSome: (shell) => Effect.succeed(shell),
            }),
          ),
        );

        const modelSelection = buildModelSelection(provider, model);
        // Privilege boundary: a delegated agent must not escalate its workers
        // beyond what the user granted the calling thread. Only the user can
        // grant full access (by running the caller itself in full-access).
        if (runtimeModeArg === "full-access" && caller.runtimeMode !== "full-access") {
          throw new ToolInputError(
            'Your thread runs in "approval-required" mode, so spawned threads cannot use "full-access". Omit runtimeMode or ask the user to switch your thread to full access first.',
          );
        }
        const runtimeMode = runtimeModeArg ?? caller.runtimeMode;
        // Same flow as UI-created threads: start with the deterministic
        // placeholder so the first-turn reactor auto-renames it with a
        // model-generated title. A custom title here would block that rename.
        const title = buildPromptThreadTitleFallback(prompt);

        let branch: string | null = null;
        let worktreePath: string | null = null;
        if (environment === "worktree") {
          const baseBranchArg = readStringArg(args, "baseBranch");
          const baseBranch =
            baseBranchArg ??
            (yield* git.statusDetails(project.workspaceRoot).pipe(
              Effect.mapError((error) => new ToolInputError(errorText(error))),
              Effect.flatMap((status) =>
                status.isRepo && status.branch
                  ? Effect.succeed(status.branch)
                  : Effect.fail(
                      new ToolInputError(
                        'The project is not on a git branch; pass an explicit baseBranch or use environment "local".',
                      ),
                    ),
              ),
            ));
          const newBranch =
            readStringArg(args, "branchName") ??
            `agent/${slugify(title)}-${randomUUID().slice(0, 8)}`;
          const created = yield* git
            .createWorktree({
              cwd: project.workspaceRoot,
              branch: baseBranch,
              newBranch,
              path: null,
            })
            .pipe(Effect.mapError((error) => new ToolInputError(errorText(error))));
          branch = created.worktree.branch;
          worktreePath = created.worktree.path;
        }

        const ids = makeAgentIds();
        const now = isoNow();
        yield* orchestrationEngine
          .dispatch({
            type: "thread.create",
            commandId: ids.threadCreateCommandId,
            threadId: ids.threadId,
            projectId,
            title,
            modelSelection,
            runtimeMode,
            interactionMode: "default",
            envMode: environment,
            branch,
            worktreePath,
            ...(worktreePath !== null
              ? {
                  associatedWorktreePath: worktreePath,
                  associatedWorktreeBranch: branch,
                  associatedWorktreeRef: branch,
                }
              : {}),
            createdAt: now,
          })
          .pipe(Effect.mapError((error) => new ToolInputError(errorText(error))));

        yield* orchestrationEngine
          .dispatch({
            type: "thread.turn.start",
            commandId: ids.turnStartCommandId,
            threadId: ids.threadId,
            message: {
              messageId: ids.messageId,
              role: "user",
              text: prompt,
              attachments: [],
            },
            modelSelection,
            dispatchMode: "queue",
            dispatchOrigin: "agent",
            runtimeMode,
            interactionMode: "default",
            createdAt: isoNow(),
          })
          .pipe(Effect.mapError((error) => new ToolInputError(errorText(error))));

        return mcpToolResultJson({
          threadId: ids.threadId,
          projectId,
          title,
          provider: modelSelection.provider,
          model: modelSelection.model,
          runtimeMode,
          environment,
          branch,
          worktreePath,
          status: "task dispatched",
        });
      }).pipe(Effect.catch((error) => Effect.succeed(mcpToolResultError(errorText(error))))),
  };

  const sendMessage: ToolEntry = {
    definition: {
      name: "synara_send_message",
      description:
        'Send a follow-up message to an existing thread. mode "queue" (default) waits for the current turn; "steer" redirects a running turn where the provider supports it (otherwise it is queued).',
      inputSchema: {
        type: "object",
        properties: {
          threadId: { type: "string", description: "Target thread." },
          message: { type: "string", description: "Message text." },
          mode: { type: "string", enum: ["queue", "steer"], description: "Dispatch mode." },
        },
        required: ["threadId", "message"],
        additionalProperties: false,
      },
    },
    handler: (args) =>
      Effect.gen(function* () {
        const threadId = readStringArg(args, "threadId", { required: true })!;
        const message = readStringArg(args, "message", { required: true })!;
        const modeArg = readStringArg(args, "mode") ?? "queue";
        if (modeArg !== "queue" && modeArg !== "steer") {
          throw new ToolInputError(`Argument "mode" must be "queue" or "steer".`);
        }
        const target = yield* requireThreadShell(threadId);
        // Steering only makes sense against a live turn. An idle "steer" would
        // ride the Codex native-steer fast path in the reactor (skipping the
        // turn-start checkpoint) instead of queueing as the tool promises, so
        // downgrade it based on the projected session state.
        const hasLiveTurn =
          target.session?.status === "running" && target.session.activeTurnId !== null;
        const dispatchMode: TurnDispatchMode =
          modeArg === "steer" && !hasLiveTurn ? "queue" : modeArg;
        const suffix = randomUUID();
        yield* orchestrationEngine
          .dispatch({
            type: "thread.turn.start",
            commandId: CommandId.makeUnsafe(`agent:${suffix}:send`),
            threadId: target.id,
            message: {
              messageId: MessageId.makeUnsafe(`agent:${suffix}:message`),
              role: "user",
              text: message,
              attachments: [],
            },
            dispatchMode,
            dispatchOrigin: "agent",
            runtimeMode: target.runtimeMode,
            interactionMode: target.interactionMode,
            createdAt: isoNow(),
          })
          .pipe(Effect.mapError((error) => new ToolInputError(errorText(error))));
        return mcpToolResultJson({ threadId: target.id, dispatched: dispatchMode });
      }).pipe(Effect.catch((error) => Effect.succeed(mcpToolResultError(errorText(error))))),
  };

  const interruptThread: ToolEntry = {
    definition: {
      name: "synara_interrupt_thread",
      description: "Interrupt the running turn of a thread.",
      inputSchema: {
        type: "object",
        properties: {
          threadId: { type: "string", description: "Thread whose turn should be interrupted." },
        },
        required: ["threadId"],
        additionalProperties: false,
      },
    },
    handler: (args) =>
      Effect.gen(function* () {
        const threadId = readStringArg(args, "threadId", { required: true })!;
        const target = yield* requireThreadShell(threadId);
        yield* orchestrationEngine
          .dispatch({
            type: "thread.turn.interrupt",
            commandId: CommandId.makeUnsafe(`agent:${randomUUID()}:interrupt`),
            threadId: target.id,
            createdAt: isoNow(),
          })
          .pipe(Effect.mapError((error) => new ToolInputError(errorText(error))));
        return mcpToolResultJson({ threadId: target.id, interrupted: true });
      }).pipe(Effect.catch((error) => Effect.succeed(mcpToolResultError(errorText(error))))),
  };

  const setThreadTitle: ToolEntry = {
    definition: {
      name: "synara_set_thread_title",
      description: "Rename a thread.",
      inputSchema: {
        type: "object",
        properties: {
          threadId: { type: "string", description: "Thread to rename." },
          title: { type: "string", description: "New title." },
        },
        required: ["threadId", "title"],
        additionalProperties: false,
      },
    },
    handler: (args) =>
      Effect.gen(function* () {
        const threadId = readStringArg(args, "threadId", { required: true })!;
        const title = readStringArg(args, "title", { required: true })!;
        const target = yield* requireThreadShell(threadId);
        yield* orchestrationEngine
          .dispatch({
            type: "thread.meta.update",
            commandId: CommandId.makeUnsafe(`agent:${randomUUID()}:rename`),
            threadId: target.id,
            title,
          })
          .pipe(Effect.mapError((error) => new ToolInputError(errorText(error))));
        return mcpToolResultJson({ threadId: target.id, title });
      }).pipe(Effect.catch((error) => Effect.succeed(mcpToolResultError(errorText(error))))),
  };

  const setThreadArchived: ToolEntry = {
    definition: {
      name: "synara_set_thread_archived",
      description:
        "Archive or unarchive a thread. Defaults to your own thread when threadId is omitted.",
      inputSchema: {
        type: "object",
        properties: {
          threadId: { type: "string", description: "Thread to archive/unarchive." },
          archived: { type: "boolean", description: "true to archive, false to unarchive." },
        },
        required: ["archived"],
        additionalProperties: false,
      },
    },
    handler: (args, context) =>
      Effect.gen(function* () {
        const threadId = readStringArg(args, "threadId") ?? context.callerThreadId;
        const archived = readBooleanArg(args, "archived");
        if (archived === undefined) {
          throw new ToolInputError(`Missing required argument "archived".`);
        }
        const target = yield* requireThreadShell(threadId);
        yield* orchestrationEngine
          .dispatch({
            type: archived ? "thread.archive" : "thread.unarchive",
            commandId: CommandId.makeUnsafe(`agent:${randomUUID()}:archive`),
            threadId: target.id,
          })
          .pipe(Effect.mapError((error) => new ToolInputError(errorText(error))));
        return mcpToolResultJson({ threadId: target.id, archived });
      }).pipe(Effect.catch((error) => Effect.succeed(mcpToolResultError(errorText(error))))),
  };

  // --- automation tools -----------------------------------------------------

  const createAutomation: ToolEntry = {
    definition: {
      name: "synara_create_automation",
      description:
        "Create a heartbeat automation that wakes a thread on an interval (default: your own thread every 5 minutes). Use it for periodic monitoring instead of relying on memory; cancel it with synara_cancel_automation when done.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Automation name." },
          prompt: {
            type: "string",
            description:
              "Message sent to the target thread on each wake (e.g. 'Check your child threads and steer them if needed').",
          },
          everyMinutes: {
            type: "number",
            description: "Wake interval in minutes (default 5, min 1).",
          },
          targetThreadId: {
            type: "string",
            description: "Thread woken on each interval; defaults to your own thread.",
          },
          maxIterations: {
            type: "number",
            description: "Safety cap on total wakes before auto-disable (default 50).",
          },
        },
        required: ["name", "prompt"],
        additionalProperties: false,
      },
    },
    handler: (args, context) =>
      Effect.gen(function* () {
        const name = readStringArg(args, "name", { required: true })!;
        const prompt = readStringArg(args, "prompt", { required: true })!;
        const everyMinutes = Math.max(
          1,
          readNumberArg(args, "everyMinutes") ?? HEARTBEAT_DEFAULT_INTERVAL_MINUTES,
        );
        const targetThreadId = readStringArg(args, "targetThreadId") ?? context.callerThreadId;
        const maxIterations = Math.max(
          1,
          Math.round(readNumberArg(args, "maxIterations") ?? HEARTBEAT_DEFAULT_MAX_ITERATIONS),
        );
        const target = yield* requireThreadShell(targetThreadId);
        // Heartbeats run in the target thread's existing environment, so the
        // automation policy must see that environment: a local-checkout target
        // requires the matching risk acknowledgement (the user already accepted
        // that environment when creating the thread), and full-access targets
        // require the full-access acknowledgement.
        const worktreeMode =
          target.envMode === "worktree" ? ("worktree" as const) : ("local" as const);
        const acknowledgedRisks: Array<"full-access" | "local-checkout"> = [];
        if (target.runtimeMode === "full-access") {
          acknowledgedRisks.push("full-access");
        }
        if (worktreeMode === "local") {
          acknowledgedRisks.push("local-checkout");
        }
        const definition = yield* automationService
          .create({
            projectId: target.projectId,
            sourceThreadId: ThreadId.makeUnsafe(context.callerThreadId),
            name,
            prompt,
            schedule: { type: "interval", everySeconds: Math.round(everyMinutes * 60) },
            modelSelection: target.modelSelection,
            runtimeMode: target.runtimeMode,
            interactionMode: target.interactionMode,
            mode: "heartbeat",
            targetThreadId: target.id,
            maxIterations,
            stopOnError: true,
            worktreeMode,
            acknowledgedRisks,
          })
          .pipe(Effect.mapError((error) => new ToolInputError(errorText(error))));
        return mcpToolResultJson({
          automationId: definition.id,
          name: definition.name,
          targetThreadId: definition.targetThreadId,
          everyMinutes,
          nextRunAt: definition.nextRunAt,
          maxIterations: definition.maxIterations,
        });
      }).pipe(Effect.catch((error) => Effect.succeed(mcpToolResultError(errorText(error))))),
  };

  const listAutomations: ToolEntry = {
    definition: {
      name: "synara_list_automations",
      description: "List automations (id, name, schedule, target thread, enabled, next run).",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string", description: "Only automations of this project." },
        },
        additionalProperties: false,
      },
    },
    handler: (args) =>
      Effect.gen(function* () {
        const projectIdArg = readStringArg(args, "projectId");
        const result = yield* automationService
          .list(projectIdArg ? { projectId: ProjectId.makeUnsafe(projectIdArg) } : undefined)
          .pipe(Effect.mapError((error) => new ToolInputError(errorText(error))));
        return mcpToolResultJson({
          automations: result.definitions.map((definition) => ({
            automationId: definition.id,
            name: definition.name,
            mode: definition.mode,
            schedule: definition.schedule,
            enabled: definition.enabled,
            targetThreadId: definition.targetThreadId,
            nextRunAt: definition.nextRunAt,
            iterationCount: definition.iterationCount,
            maxIterations: definition.maxIterations,
          })),
        });
      }).pipe(Effect.catch((error) => Effect.succeed(mcpToolResultError(errorText(error))))),
  };

  const cancelAutomation: ToolEntry = {
    definition: {
      name: "synara_cancel_automation",
      description:
        'Stop an automation. mode "disable" (default) pauses it and keeps history; "delete" archives it.',
      inputSchema: {
        type: "object",
        properties: {
          automationId: { type: "string", description: "Automation to stop." },
          mode: { type: "string", enum: ["disable", "delete"], description: "Stop mode." },
        },
        required: ["automationId"],
        additionalProperties: false,
      },
    },
    handler: (args) =>
      Effect.gen(function* () {
        const automationId = readStringArg(args, "automationId", { required: true })!;
        const modeArg = readStringArg(args, "mode") ?? "disable";
        if (modeArg !== "disable" && modeArg !== "delete") {
          throw new ToolInputError(`Argument "mode" must be "disable" or "delete".`);
        }
        const id = AutomationId.makeUnsafe(automationId);
        if (modeArg === "delete") {
          yield* automationService
            .delete({ id })
            .pipe(Effect.mapError((error) => new ToolInputError(errorText(error))));
        } else {
          yield* automationService
            .update({ id, enabled: false })
            .pipe(Effect.mapError((error) => new ToolInputError(errorText(error))));
        }
        return mcpToolResultJson({ automationId, stopped: true, mode: modeArg });
      }).pipe(Effect.catch((error) => Effect.succeed(mcpToolResultError(errorText(error))))),
  };

  const tools: ReadonlyArray<ToolEntry> = [
    listProjects,
    listThreads,
    readThread,
    createThread,
    sendMessage,
    interruptThread,
    setThreadTitle,
    setThreadArchived,
    createAutomation,
    listAutomations,
    cancelAutomation,
  ];
  const toolsByName = new Map(tools.map((tool) => [tool.definition.name, tool]));

  const handleRequest = (request: JsonRpcRequest, context: ToolContext) =>
    Effect.gen(function* () {
      switch (request.method) {
        case "initialize":
          return jsonRpcResult(
            request.id,
            buildMcpInitializeResult({
              requestedProtocolVersion: request.params.protocolVersion,
              serverVersion: "1.0.0",
              instructions: AGENT_GATEWAY_INSTRUCTIONS,
            }),
          );
        case "ping":
          return jsonRpcResult(request.id, {});
        case "tools/list":
          return jsonRpcResult(request.id, {
            tools: tools.map((tool) => tool.definition),
          });
        case "tools/call": {
          const toolName = request.params.name;
          if (typeof toolName !== "string") {
            return jsonRpcError(request.id, JSON_RPC_INVALID_PARAMS, "Missing tool name.");
          }
          const tool = toolsByName.get(toolName);
          if (!tool) {
            return jsonRpcError(request.id, JSON_RPC_INVALID_PARAMS, `Unknown tool "${toolName}".`);
          }
          const rawArgs = request.params.arguments;
          const args =
            typeof rawArgs === "object" && rawArgs !== null && !Array.isArray(rawArgs)
              ? (rawArgs as Record<string, unknown>)
              : {};
          const result = yield* Effect.suspend(() => tool.handler(args, context)).pipe(
            Effect.catchDefect((defect) => Effect.succeed(mcpToolResultError(errorText(defect)))),
          );
          return jsonRpcResult(request.id, result);
        }
        default:
          return jsonRpcError(
            request.id,
            JSON_RPC_METHOD_NOT_FOUND,
            `Method "${request.method}" is not supported.`,
          );
      }
    });

  const handleMcpPost: AgentGatewayShape["handleMcpPost"] = (input) =>
    Effect.gen(function* () {
      const token = extractBearerToken(input.authorizationHeader);
      const callerThreadId = token ? credentials.verifySessionToken(token) : null;
      if (!callerThreadId) {
        return {
          status: 401,
          body: jsonRpcError(null, JSON_RPC_INVALID_REQUEST, "Missing or invalid bearer token."),
        };
      }
      const context: ToolContext = { callerThreadId };

      const rawMessages = Array.isArray(input.body) ? input.body : [input.body];
      if (rawMessages.length === 0) {
        return {
          status: 400,
          body: jsonRpcError(null, JSON_RPC_INVALID_REQUEST, "Empty JSON-RPC batch."),
        };
      }
      const responses: Array<Record<string, unknown>> = [];
      for (const raw of rawMessages) {
        const parsed = parseMcpMessage(raw);
        switch (parsed.kind) {
          case "request":
            responses.push(yield* handleRequest(parsed.request, context));
            break;
          case "notification":
          case "response":
            break;
          case "invalid":
            responses.push(
              jsonRpcError(parsed.id, JSON_RPC_INVALID_REQUEST, "Invalid JSON-RPC message."),
            );
            break;
        }
      }
      if (responses.length === 0) {
        // Notifications/responses only: acknowledge without a body.
        return { status: 202 };
      }
      const body = Array.isArray(input.body) ? responses : responses[0];
      return { status: 200, body };
    });

  return { handleMcpPost } satisfies AgentGatewayShape;
});

export const AgentGatewayLive = Layer.effect(AgentGateway, makeAgentGateway);
