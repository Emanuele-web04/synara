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
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";

import {
  AutomationId,
  SynaraCreateThreadsInput,
  SynaraWaitForThreadsInput,
  SYNARA_GATEWAY_MAX_THREADS_PER_OPERATION,
  type AutomationDefinition,
  CommandId,
  DEFAULT_MODEL_BY_PROVIDER,
  EventId,
  MessageId,
  type OrchestrationThreadShell,
  ProjectId,
  ThreadId,
  TurnId,
  type ModelSelection,
  type ProviderKind,
  type ServerProviderStatus,
  type SynaraCreateThreadsResult,
  type TurnDispatchMode,
} from "@synara/contracts";
import { buildPromptThreadTitleFallback } from "@synara/shared/chatThreads";
import { Effect, Layer, Option, Schema } from "effect";

import { GitCore } from "../../git/Services/GitCore.ts";
import { ServerConfig } from "../../config.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { AutomationService } from "../../automation/Services/AutomationService.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
import { AgentGateway, type AgentGatewayShape } from "../Services/AgentGateway.ts";
import { AgentGatewayCredentials } from "../Services/AgentGatewayCredentials.ts";
import { AgentGatewayOperationRepository } from "../Services/AgentGatewayOperationRepository.ts";
import { SYNARA_GATEWAY_HARNESS_POLICY, SYNARA_HARNESS_POLICY_VERSION } from "../harnessPolicy.ts";
import { ProviderDiscoveryService } from "../../provider/Services/ProviderDiscoveryService.ts";
import { ProviderHealth } from "../../provider/Services/ProviderHealth.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import {
  type AgentGatewayProviderAvailability,
  AgentGatewayTargetError,
  loadAgentGatewayProviderCatalog,
  resolveAgentGatewayTarget,
} from "../targetResolver.ts";
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
  type JsonRpcId,
  type McpToolCallResult,
  type McpToolDefinition,
} from "../protocol.ts";
import { summarizeThreadDetail, summarizeThreadShell } from "../threadSummary.ts";
import { extractBearerToken } from "../tokens.ts";

const LIST_THREADS_DEFAULT_LIMIT = 50;
const LIST_THREADS_MAX_LIMIT = 200;
const HEARTBEAT_DEFAULT_INTERVAL_MINUTES = 5;
const HEARTBEAT_DEFAULT_MAX_ITERATIONS = 50;
const MCP_MAX_BATCH_MESSAGES = 50;
const CREATION_REPLAY_WAIT_MS = 60_000;

const PROVIDER_KINDS: ReadonlyArray<ProviderKind> = [
  "codex",
  "claudeAgent",
  "cursor",
  "gemini",
  "grok",
  "droid",
  "kilo",
  "opencode",
  "pi",
];

const AGENT_GATEWAY_INSTRUCTIONS = SYNARA_GATEWAY_HARNESS_POLICY;

const READ_ONLY_TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const WRITE_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
} as const;

interface ToolContext {
  readonly callerThreadId: string;
  readonly callerSessionKey: string;
  readonly callerProvider: ProviderKind;
  readonly callerCapabilities: ReadonlySet<"thread:read" | "thread:write" | "automation:write">;
  readonly callerTurnId: string | null;
  readonly jsonRpcRequestId: JsonRpcId;
}

type ToolHandler = (
  args: Record<string, unknown>,
  context: ToolContext,
) => Effect.Effect<McpToolCallResult>;

interface ToolEntry {
  readonly definition: McpToolDefinition;
  readonly handler: ToolHandler;
  readonly requiresActiveTurn?: boolean;
}

class ToolInputError extends Error {}

class GatewayToolError extends Error {
  readonly code: string;
  readonly details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

function gatewayToolErrorResult(error: GatewayToolError | AgentGatewayTargetError) {
  return {
    ...mcpToolResultJson({
      error: {
        code: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
      },
    }),
    isError: true as const,
  };
}

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

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function stableDigest(value: unknown, length = 32): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex").slice(0, length);
}

function makeAgentIds(operationId: string, index: number) {
  const id = stableDigest({ operationId, index }, 32);
  return {
    threadId: ThreadId.makeUnsafe(`agent:${id}`),
    threadCreateCommandId: CommandId.makeUnsafe(`agent:${id}:thread-create`),
    turnStartCommandId: CommandId.makeUnsafe(`agent:${id}:turn-start`),
    messageId: MessageId.makeUnsafe(`agent:${id}:message`),
    compensateCommandId: CommandId.makeUnsafe(`agent:${id}:compensate-delete`),
  };
}

interface RecoverableCreationPlanEntry {
  readonly workspaceRoot: string;
  readonly environment: "local" | "worktree";
  readonly newBranch: string | null;
  readonly plannedWorktreePath: string | null;
  readonly ownershipPreflightPassed: boolean;
  readonly ids: {
    readonly threadId: string;
    readonly compensateCommandId: string;
  };
}

function parseRecoverableCreationPlan(
  planJson: string,
): ReadonlyArray<RecoverableCreationPlanEntry> {
  const parsed: unknown = JSON.parse(planJson);
  if (!Array.isArray(parsed)) {
    throw new Error("Stored gateway creation plan is not an array.");
  }
  return parsed.map((entry, index) => {
    if (!entry || typeof entry !== "object") {
      throw new Error(`Stored gateway creation plan entry ${index} is invalid.`);
    }
    const value = entry as Record<string, unknown>;
    const ids = value.ids;
    if (!ids || typeof ids !== "object") {
      throw new Error(`Stored gateway creation plan entry ${index} has no deterministic ids.`);
    }
    const idRecord = ids as Record<string, unknown>;
    if (
      typeof value.workspaceRoot !== "string" ||
      (value.environment !== "local" && value.environment !== "worktree") ||
      (value.newBranch !== null && typeof value.newBranch !== "string") ||
      (value.plannedWorktreePath !== null && typeof value.plannedWorktreePath !== "string") ||
      typeof idRecord.threadId !== "string" ||
      typeof idRecord.compensateCommandId !== "string"
    ) {
      throw new Error(`Stored gateway creation plan entry ${index} is incomplete.`);
    }
    return {
      workspaceRoot: value.workspaceRoot,
      environment: value.environment,
      newBranch: value.newBranch,
      plannedWorktreePath: value.plannedWorktreePath,
      // Older in-progress rows predate explicit ownership proof. They remain
      // decodable, but recovery refuses destructive git cleanup for them.
      ownershipPreflightPassed: value.ownershipPreflightPassed === true,
      ids: {
        threadId: idRecord.threadId,
        compensateCommandId: idRecord.compensateCommandId,
      },
    };
  });
}

function readRecordArg(
  args: Record<string, unknown>,
  name: string,
): Record<string, unknown> | undefined {
  const value = args[name];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new ToolInputError(`Argument "${name}" must be an object.`);
  }
  return value as Record<string, unknown>;
}

function decodeCreateThreadsInput(value: unknown) {
  try {
    return Schema.decodeUnknownSync(SynaraCreateThreadsInput)(value);
  } catch (error) {
    throw new ToolInputError(`Invalid Synara creation plan: ${errorText(error)}`);
  }
}

function decodeWaitForThreadsInput(value: unknown) {
  try {
    return Schema.decodeUnknownSync(SynaraWaitForThreadsInput)(value);
  } catch (error) {
    throw new ToolInputError(`Invalid Synara wait request: ${errorText(error)}`);
  }
}

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const makeAgentGateway = Effect.gen(function* () {
  const credentials = yield* AgentGatewayCredentials;
  const snapshotQuery = yield* ProjectionSnapshotQuery;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const automationService = yield* AutomationService;
  const git = yield* GitCore;
  const providerDiscovery = yield* ProviderDiscoveryService;
  const providerHealth = yield* ProviderHealth;
  const serverSettings = yield* ServerSettingsService;
  const operationRepository = yield* AgentGatewayOperationRepository;
  const projectionTurns = yield* ProjectionTurnRepository;
  const serverConfig = yield* ServerConfig;

  const loadProviderAvailabilities = Effect.gen(function* () {
    const [settings, statuses] = yield* Effect.all([
      serverSettings.getSettings,
      providerHealth.getStatuses,
    ]);
    const statusByProvider = new Map<ProviderKind, ServerProviderStatus>(
      statuses.map((status) => [status.provider, status]),
    );
    return new Map<ProviderKind, AgentGatewayProviderAvailability>(
      PROVIDER_KINDS.map((provider) => {
        const status = statusByProvider.get(provider);
        return [
          provider,
          {
            enabled: settings.providers[provider].enabled,
            ...(status
              ? {
                  available: status.available,
                  authStatus: status.authStatus,
                  ...(status.message ? { message: status.message } : {}),
                }
              : {}),
          },
        ];
      }),
    );
  });

  const awaitCreationReplay = (
    operationId: string,
  ): Effect.Effect<McpToolCallResult, GatewayToolError | ToolInputError> =>
    Effect.gen(function* () {
      const deadline = Date.now() + CREATION_REPLAY_WAIT_MS;
      let operation = yield* operationRepository
        .getById(operationId)
        .pipe(Effect.mapError((error) => new ToolInputError(errorText(error))));
      while (
        operation !== null &&
        operation.status !== "completed" &&
        operation.status !== "failed" &&
        Date.now() < deadline
      ) {
        yield* Effect.sleep(25);
        operation = yield* operationRepository
          .getById(operationId)
          .pipe(Effect.mapError((error) => new ToolInputError(errorText(error))));
      }
      if (operation?.status === "completed") {
        return mcpToolResultJson(JSON.parse(operation.resultJson ?? "{}"));
      }
      if (operation?.status === "failed") {
        return yield* Effect.fail(
          new GatewayToolError(
            "operation_failed",
            "The original thread-creation operation failed; it will not create replacement threads.",
            {
              operationId,
              error: operation.errorJson ? JSON.parse(operation.errorJson) : null,
            },
          ),
        );
      }
      return yield* Effect.fail(
        new GatewayToolError(
          "operation_failed",
          "The original thread-creation operation is still in progress. Retry only with the same request id; Synara will not create replacement threads.",
          { operationId, status: operation?.status ?? "missing" },
        ),
      );
    });

  const interruptedOperations = yield* operationRepository.listNonTerminal().pipe(
    Effect.catch((error) =>
      Effect.logWarning("agent gateway recovery could not list interrupted operations", {
        error: errorText(error),
      }).pipe(Effect.as([])),
    ),
  );
  yield* Effect.forEach(
    interruptedOperations,
    (operation) =>
      Effect.gen(function* () {
        if (operation.status === "reserved") {
          yield* operationRepository.fail({
            operationId: operation.operationId,
            errorJson: JSON.stringify({
              code: "server_restarted_before_dispatch",
              message:
                "Synara restarted before dispatch began. No git or orchestration resources were touched.",
            }),
            now: isoNow(),
          });
          return;
        }
        yield* operationRepository.markCompensating({
          operationId: operation.operationId,
          now: isoNow(),
        });
        const plan = parseRecoverableCreationPlan(operation.planJson);
        const recoveryErrors: string[] = [];
        yield* Effect.forEach(
          [...plan].reverse(),
          (entry) =>
            Effect.gen(function* () {
              const projected = yield* snapshotQuery.getThreadShellById(
                ThreadId.makeUnsafe(entry.ids.threadId),
              );
              if (Option.isSome(projected)) {
                if (
                  projected.value.creationSource !== "synara_mcp" ||
                  projected.value.gatewayOperationId !== operation.operationId
                ) {
                  return yield* Effect.fail(
                    new Error(
                      `Refusing to delete thread ${entry.ids.threadId}: gateway ownership does not match operation ${operation.operationId}.`,
                    ),
                  );
                }
                yield* orchestrationEngine.dispatch({
                  type: "thread.delete",
                  commandId: CommandId.makeUnsafe(entry.ids.compensateCommandId),
                  threadId: ThreadId.makeUnsafe(entry.ids.threadId),
                });
              }
            }).pipe(
              Effect.catch((error) => Effect.sync(() => recoveryErrors.push(errorText(error)))),
            ),
          { discard: true },
        );
        yield* Effect.forEach(
          [...plan].reverse(),
          (entry) =>
            entry.environment === "worktree" && entry.plannedWorktreePath && entry.newBranch
              ? Effect.gen(function* () {
                  if (!entry.ownershipPreflightPassed) {
                    return yield* Effect.fail(
                      new Error(
                        `Refusing to clean worktree ${entry.plannedWorktreePath}: the operation has no durable ownership preflight.`,
                      ),
                    );
                  }
                  if (existsSync(entry.plannedWorktreePath!)) {
                    yield* git.removeWorktree({
                      cwd: entry.workspaceRoot,
                      path: entry.plannedWorktreePath!,
                      force: true,
                    });
                  }
                  const branches = yield* git.listBranches({ cwd: entry.workspaceRoot });
                  if (
                    branches.branches.some(
                      (branch) => !branch.isRemote && branch.name === entry.newBranch,
                    )
                  ) {
                    yield* git.deleteBranch({
                      cwd: entry.workspaceRoot,
                      branch: entry.newBranch!,
                      force: true,
                    });
                  }
                }).pipe(
                  Effect.catch((error) => Effect.sync(() => recoveryErrors.push(errorText(error)))),
                )
              : Effect.void,
          { discard: true },
        );
        if (recoveryErrors.length > 0) {
          yield* Effect.logWarning("agent gateway recovery remains incomplete", {
            operationId: operation.operationId,
            errors: recoveryErrors,
          });
          return;
        }
        yield* operationRepository.fail({
          operationId: operation.operationId,
          errorJson: JSON.stringify({
            code: "server_restarted",
            message:
              "Synara restarted before the operation completed. Deterministic operation-owned resources were compensated; no replacements were created.",
            compensatedCount: plan.length,
          }),
          now: isoNow(),
        });
      }).pipe(
        Effect.catch((error) =>
          Effect.logWarning("agent gateway recovery failed", {
            operationId: operation.operationId,
            error: errorText(error),
          }),
        ),
      ),
    { concurrency: 1, discard: true },
  );

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

  // Privilege boundary shared by every tool that makes another thread execute
  // work or mutates another thread's state: a caller must not drive a thread
  // that runs with more privileges than the user granted the caller itself —
  // otherwise an approval-required or worktree-isolated agent escalates by proxy.
  const assertCallerMayDriveThread = (
    caller: { readonly runtimeMode: string; readonly envMode?: string | null | undefined },
    target: {
      readonly id: string;
      readonly runtimeMode: string;
      readonly envMode?: string | null | undefined;
    },
  ) =>
    Effect.gen(function* () {
      if (target.runtimeMode === "full-access" && caller.runtimeMode !== "full-access") {
        return yield* Effect.fail(
          new ToolInputError(
            `Thread "${target.id}" runs in "full-access" mode but your thread is "approval-required"; you cannot drive higher-privileged threads. Ask the user to do this or to elevate your thread.`,
          ),
        );
      }
      if (caller.envMode === "worktree" && (target.envMode ?? "local") === "local") {
        return yield* Effect.fail(
          new ToolInputError(
            `Thread "${target.id}" runs on the shared local checkout but your thread is isolated in a worktree; you cannot drive local-checkout threads. Ask the user to do this from a local thread.`,
          ),
        );
      }
    });

  const requireAutomationDefinition = (automationId: string) =>
    automationService.list({ includeArchived: true }).pipe(
      Effect.mapError((error) => new ToolInputError(errorText(error))),
      Effect.flatMap((result) => {
        const definition = result.definitions.find((entry) => entry.id === automationId);
        return definition
          ? Effect.succeed(definition)
          : Effect.fail(new ToolInputError(`Automation "${automationId}" was not found.`));
      }),
    );

  // Stopping an automation changes future execution, so a gateway caller must
  // either own it or be allowed to drive the thread it wakes.
  const assertCallerMayCancelAutomation = (
    caller: OrchestrationThreadShell,
    definition: AutomationDefinition,
  ) =>
    Effect.gen(function* () {
      if (definition.sourceThreadId === caller.id) {
        return;
      }
      if (definition.targetThreadId) {
        const target = yield* requireThreadShell(definition.targetThreadId);
        yield* assertCallerMayDriveThread(caller, target);
        return;
      }
      return yield* Effect.fail(
        new ToolInputError(
          `Automation "${definition.id}" was not created by your thread and has no target thread you can authorize against.`,
        ),
      );
    });

  // --- read tools -----------------------------------------------------------

  const contextTool: ToolEntry = {
    definition: {
      name: "synara_context",
      description:
        "Inspect the current Synara harness identity, caller thread/turn, and authorized coordination capabilities.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: {
        title: "Synara context",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    handler: (_args, context) =>
      Effect.gen(function* () {
        const caller = yield* requireThreadShell(context.callerThreadId);
        const turnId = caller.latestTurn?.state === "running" ? caller.latestTurn.turnId : null;
        return mcpToolResultJson({
          harness: { name: "Synara", policyVersion: SYNARA_HARNESS_POLICY_VERSION },
          caller: {
            threadId: caller.id,
            turnId,
            provider: context.callerProvider,
            projectId: caller.projectId,
          },
          capabilities: {
            threadRead: context.callerCapabilities.has("thread:read"),
            threadCreate: turnId !== null && context.callerCapabilities.has("thread:write"),
            threadWait: context.callerCapabilities.has("thread:read"),
            automations: turnId !== null && context.callerCapabilities.has("automation:write"),
          },
        });
      }).pipe(Effect.catch((error) => Effect.succeed(mcpToolResultError(errorText(error))))),
  };

  const capabilitiesTool: ToolEntry = {
    definition: {
      name: "synara_capabilities",
      description:
        "List the canonical Synara provider/model targets and gateway limits used to validate thread creation.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: {
        title: "Synara capabilities",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    handler: (_args, context) =>
      Effect.gen(function* () {
        const caller = yield* requireThreadShell(context.callerThreadId);
        const project = yield* snapshotQuery.getProjectShellById(caller.projectId).pipe(
          Effect.mapError((error) => new ToolInputError(errorText(error))),
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.fail(new ToolInputError(`Project "${caller.projectId}" was not found.`)),
              onSome: Effect.succeed,
            }),
          ),
        );
        const availabilities = yield* loadProviderAvailabilities;
        const providers = yield* Effect.forEach(PROVIDER_KINDS, (provider) =>
          loadAgentGatewayProviderCatalog({
            provider,
            discovery: providerDiscovery,
            ...(availabilities.get(provider) !== undefined
              ? { availability: availabilities.get(provider)! }
              : {}),
            cwd: project.workspaceRoot,
          }),
        );
        return mcpToolResultJson({
          providers,
          limits: {
            maxThreadsPerOperation: SYNARA_GATEWAY_MAX_THREADS_PER_OPERATION,
            maxWaitMs: 60_000,
            oneCreationPlanPerActiveTurn: true,
          },
        });
      }).pipe(Effect.catch((error) => Effect.succeed(mcpToolResultError(errorText(error))))),
  };

  const listProjects: ToolEntry = {
    definition: {
      name: "synara_list_projects",
      description:
        "List Synara projects (id, title, workspace root). Use before creating a thread in another project.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { title: "List Synara projects", ...READ_ONLY_TOOL_ANNOTATIONS },
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
      annotations: { title: "List Synara threads", ...READ_ONLY_TOOL_ANNOTATIONS },
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
        "Read one Synara thread's status and recent messages (newest last, truncated). Pass the returned nextCursor as cursor to page older messages.",
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
      annotations: { title: "Read a Synara thread", ...READ_ONLY_TOOL_ANNOTATIONS },
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

  const waitForThreads: ToolEntry = {
    definition: {
      name: "synara_wait_for_threads",
      description:
        "Wait for the pinned turns of 1–20 Synara threads and return every outcome in input order. Timeouts only report progress; they never retry, replace, cancel, or create work.",
      inputSchema: {
        type: "object",
        properties: {
          threadIds: {
            type: "array",
            minItems: 1,
            maxItems: SYNARA_GATEWAY_MAX_THREADS_PER_OPERATION,
            items: { type: "string" },
          },
          runIds: {
            type: "array",
            maxItems: SYNARA_GATEWAY_MAX_THREADS_PER_OPERATION,
            items: { type: ["string", "null"] },
            description: "Optional pinned turn ids from a prior wait. Must match threadIds length.",
          },
          timeoutMs: {
            type: "integer",
            minimum: 0,
            maximum: 60_000,
            description: "Long-poll duration; defaults to 30000ms.",
          },
        },
        required: ["threadIds"],
        additionalProperties: false,
      },
      annotations: {
        title: "Wait for Synara threads",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    handler: (args, context) =>
      Effect.gen(function* () {
        const input = decodeWaitForThreadsInput(args);
        if (input.runIds && input.runIds.length !== input.threadIds.length) {
          throw new ToolInputError('Argument "runIds" must have the same length as "threadIds".');
        }
        const timeoutMs = input.timeoutMs ?? 30_000;
        const deadline = Date.now() + timeoutMs;
        const pinned = yield* Effect.forEach(input.threadIds, (threadId, index) =>
          snapshotQuery.getThreadDetailById(threadId).pipe(
            Effect.mapError((error) => new ToolInputError(errorText(error))),
            Effect.flatMap(
              Option.match({
                onNone: () =>
                  Effect.fail(
                    new GatewayToolError("thread_not_found", `Thread "${threadId}" was not found.`),
                  ),
                onSome: (thread) =>
                  Effect.succeed({
                    threadId,
                    runId: input.runIds?.[index] ?? thread.latestTurn?.turnId ?? null,
                  }),
              }),
            ),
          ),
        );

        const readPinned = () =>
          Effect.forEach(pinned, (pin) =>
            Effect.gen(function* () {
              const detail = yield* snapshotQuery.getThreadDetailById(pin.threadId).pipe(
                Effect.mapError((error) => new ToolInputError(errorText(error))),
                Effect.flatMap(
                  Option.match({
                    onNone: () =>
                      Effect.fail(
                        new GatewayToolError(
                          "thread_not_found",
                          `Thread "${pin.threadId}" was not found.`,
                        ),
                      ),
                    onSome: Effect.succeed,
                  }),
                ),
              );
              if (pin.runId === null) {
                return {
                  threadId: pin.threadId,
                  runId: null,
                  state: "idle",
                  terminal: true,
                  timedOut: false,
                  summary: null,
                  error: null,
                };
              }
              const turn = yield* projectionTurns
                .getByTurnId({ threadId: pin.threadId, turnId: TurnId.makeUnsafe(pin.runId) })
                .pipe(Effect.mapError((error) => new ToolInputError(errorText(error))));
              const row = Option.getOrUndefined(turn);
              const state =
                row?.state ??
                (detail.latestTurn?.turnId === pin.runId ? detail.latestTurn.state : "pending");
              const terminal =
                state === "completed" || state === "error" || state === "interrupted";
              const assistantMessage = detail.messages
                .filter((message) => message.role === "assistant" && message.turnId === pin.runId)
                .at(-1);
              return {
                threadId: pin.threadId,
                runId: pin.runId,
                state,
                terminal,
                timedOut: false,
                summary: terminal ? (assistantMessage?.text ?? null) : null,
                error: state === "error" ? (detail.session?.lastError ?? "Turn failed.") : null,
              };
            }),
          );

        let results = yield* readPinned();
        while (results.some((result) => !result.terminal) && Date.now() < deadline) {
          yield* Effect.sleep(Math.min(200, Math.max(1, deadline - Date.now())));
          results = yield* readPinned();
        }
        const timedOut = results.some((result) => !result.terminal);
        const finalResults = results.map((result) => ({
          ...result,
          timedOut: !result.terminal && timedOut,
        }));
        return mcpToolResultJson({
          callerThreadId: context.callerThreadId,
          runIds: pinned.map((pin) => pin.runId),
          allTerminal: finalResults.every((result) => result.terminal),
          timedOut,
          threads: finalResults,
        });
      }).pipe(
        Effect.catch((error) =>
          Effect.succeed(
            error instanceof GatewayToolError
              ? gatewayToolErrorResult(error)
              : mcpToolResultError(errorText(error)),
          ),
        ),
      ),
  };

  // --- write tools ----------------------------------------------------------

  const appendThreadCreationRecap = (input: {
    readonly callerThreadId: string;
    readonly callerTurnId: string;
    readonly result: SynaraCreateThreadsResult;
  }) => {
    const marker = stableDigest({
      operationId: input.result.operationId,
      kind: "threads-created-recap",
    });
    const createdAt = isoNow();
    const threadLabel = input.result.createdCount === 1 ? "thread" : "threads";
    return orchestrationEngine
      .dispatch({
        type: "thread.activity.append",
        commandId: CommandId.makeUnsafe(`agent:${marker}:threads-created-recap`),
        threadId: ThreadId.makeUnsafe(input.callerThreadId),
        activity: {
          id: EventId.makeUnsafe(`gateway:${marker}:threads-created-recap`),
          tone: "info",
          kind: "synara.threads.created",
          summary: `Created ${input.result.createdCount} Synara ${threadLabel}`,
          payload: {
            source: "synara_mcp",
            operationId: input.result.operationId,
            requestId: input.result.requestId,
            requestedCount: input.result.requestedCount,
            createdCount: input.result.createdCount,
            threads: input.result.threads,
          },
          turnId: TurnId.makeUnsafe(input.callerTurnId),
          createdAt,
        },
        createdAt,
      })
      .pipe(
        Effect.catch((error) =>
          Effect.logWarning("agent gateway could not append thread creation recap", {
            operationId: input.result.operationId,
            callerThreadId: input.callerThreadId,
            error: errorText(error),
          }),
        ),
      );
  };

  const runCreateThreads = (input: typeof SynaraCreateThreadsInput.Type, context: ToolContext) =>
    Effect.gen(function* () {
      if (context.callerTurnId === null) {
        return yield* Effect.fail(
          new GatewayToolError(
            "caller_turn_inactive",
            "Thread creation requires an active caller turn.",
          ),
        );
      }
      const callerTurnId = context.callerTurnId;
      const caller = yield* requireThreadShell(context.callerThreadId);
      const operationId = `gateway:create:${stableDigest({
        callerThreadId: context.callerThreadId,
        callerTurnId,
        requestId: input.requestId,
      })}`;
      const fingerprint = stableDigest(input, 64);
      const existingOperation = yield* operationRepository
        .getByScope({
          callerThreadId: context.callerThreadId,
          callerTurnId,
          operationKind: "create_threads",
        })
        .pipe(Effect.mapError((error) => new ToolInputError(errorText(error))));
      if (existingOperation !== null) {
        if (existingOperation.requestId !== input.requestId) {
          return yield* Effect.fail(
            new GatewayToolError(
              "creation_plan_locked",
              "This caller turn already committed a different thread-creation plan. A new user turn is required for another plan.",
              {
                operationId: existingOperation.operationId,
                requestId: existingOperation.requestId,
                requestedCount: existingOperation.requestedCount,
                status: existingOperation.status,
              },
            ),
          );
        }
        if (existingOperation.fingerprint !== fingerprint) {
          return yield* Effect.fail(
            new GatewayToolError(
              "idempotency_conflict",
              `Request id "${input.requestId}" was already used with a different creation plan.`,
              { operationId: existingOperation.operationId },
            ),
          );
        }
        if (existingOperation.status === "completed") {
          return mcpToolResultJson(JSON.parse(existingOperation.resultJson ?? "{}"));
        }
        if (existingOperation.status === "failed") {
          return yield* Effect.fail(
            new GatewayToolError(
              "operation_failed",
              "The original thread-creation operation failed; it will not create replacement threads.",
              {
                operationId: existingOperation.operationId,
                error: existingOperation.errorJson ? JSON.parse(existingOperation.errorJson) : null,
              },
            ),
          );
        }
        return yield* awaitCreationReplay(existingOperation.operationId);
      }
      const callerIsolatedInWorktree = caller.envMode === "worktree";
      const providerAvailabilities = yield* loadProviderAvailabilities;

      // Validate and resolve the entire exact plan before reserving any git or
      // orchestration side effect.
      const prepared = yield* Effect.forEach(input.threads, (spec, index) =>
        Effect.gen(function* () {
          const projectId = ProjectId.makeUnsafe(spec.projectId ?? caller.projectId);
          const project = yield* snapshotQuery.getProjectShellById(projectId).pipe(
            Effect.mapError((error) => new ToolInputError(errorText(error))),
            Effect.flatMap(
              Option.match({
                onNone: () =>
                  Effect.fail(new ToolInputError(`Project "${projectId}" was not found.`)),
                onSome: Effect.succeed,
              }),
            ),
          );
          const target = yield* resolveAgentGatewayTarget({
            target: spec.target,
            discovery: providerDiscovery,
            ...(providerAvailabilities.get(spec.target.provider) !== undefined
              ? { availability: providerAvailabilities.get(spec.target.provider)! }
              : {}),
            cwd: project.workspaceRoot,
          });
          const environment = spec.environment ?? (callerIsolatedInWorktree ? "worktree" : "local");
          if (environment === "local" && callerIsolatedInWorktree) {
            return yield* Effect.fail(
              new ToolInputError(
                'Your thread runs in an isolated worktree, so created threads cannot use environment "local".',
              ),
            );
          }
          if (spec.runtimeMode === "full-access" && caller.runtimeMode !== "full-access") {
            return yield* Effect.fail(
              new ToolInputError(
                'Your thread runs in "approval-required" mode, so created threads cannot use "full-access".',
              ),
            );
          }
          const runtimeMode = spec.runtimeMode ?? caller.runtimeMode;
          const title = spec.title ?? buildPromptThreadTitleFallback(spec.prompt);
          let baseBranch: string | null = null;
          let newBranch: string | null = null;
          let plannedWorktreePath: string | null = null;
          if (environment === "worktree") {
            const callerBranch =
              callerIsolatedInWorktree && caller.projectId === projectId
                ? (caller.branch ?? null)
                : null;
            baseBranch =
              spec.baseBranch ??
              callerBranch ??
              (yield* git.statusDetails(project.workspaceRoot).pipe(
                Effect.mapError((error) => new ToolInputError(errorText(error))),
                Effect.flatMap((status) =>
                  status.isRepo && status.branch
                    ? Effect.succeed(status.branch)
                    : Effect.fail(
                        new ToolInputError(
                          'The project is not on a git branch; pass baseBranch or use environment "local".',
                        ),
                      ),
                ),
              ));
            newBranch =
              spec.branchName ??
              `agent/${slugify(title)}-${stableDigest({ operationId, index }, 8)}`;
            plannedWorktreePath = join(
              serverConfig.worktreesDir,
              basename(project.workspaceRoot),
              newBranch.replace(/\//g, "-"),
            );
            if (existsSync(plannedWorktreePath)) {
              return yield* Effect.fail(
                new ToolInputError(
                  `Worktree path "${plannedWorktreePath}" already exists. Synara will not reuse or remove a pre-existing path.`,
                ),
              );
            }
            const branches = yield* git
              .listBranches({ cwd: project.workspaceRoot })
              .pipe(Effect.mapError((error) => new ToolInputError(errorText(error))));
            if (branches.branches.some((branch) => !branch.isRemote && branch.name === newBranch)) {
              return yield* Effect.fail(
                new ToolInputError(
                  `Branch "${newBranch}" already exists. Synara will not reuse or remove a pre-existing branch.`,
                ),
              );
            }
          }
          return {
            index,
            spec,
            projectId,
            workspaceRoot: project.workspaceRoot,
            target,
            environment,
            runtimeMode,
            title,
            baseBranch,
            newBranch,
            plannedWorktreePath,
            ownershipPreflightPassed: true,
            ids: makeAgentIds(operationId, index),
          };
        }),
      );

      const plannedWorktrees = prepared
        .map((entry) => entry.plannedWorktreePath)
        .filter((path): path is string => path !== null);
      if (new Set(plannedWorktrees).size !== plannedWorktrees.length) {
        return yield* Effect.fail(
          new ToolInputError(
            "The creation plan resolves multiple entries to the same worktree path. Use distinct branchName values.",
          ),
        );
      }

      const now = isoNow();
      const reservation = yield* operationRepository
        .reserve({
          operationId,
          callerThreadId: context.callerThreadId,
          callerTurnId,
          operationKind: "create_threads",
          requestId: input.requestId,
          fingerprint,
          requestedCount: prepared.length,
          planJson: canonicalJson(
            prepared.map((entry) => ({
              index: entry.index,
              spec: entry.spec,
              projectId: entry.projectId,
              workspaceRoot: entry.workspaceRoot,
              environment: entry.environment,
              runtimeMode: entry.runtimeMode,
              baseBranch: entry.baseBranch,
              newBranch: entry.newBranch,
              plannedWorktreePath: entry.plannedWorktreePath,
              ownershipPreflightPassed: entry.ownershipPreflightPassed,
              ids: entry.ids,
            })),
          ),
          now,
        })
        .pipe(Effect.mapError((error) => new ToolInputError(errorText(error))));

      if (reservation.kind === "idempotency_conflict") {
        return yield* Effect.fail(
          new GatewayToolError(
            "idempotency_conflict",
            `Request id "${input.requestId}" was already used with a different creation plan.`,
            { operationId: reservation.operation.operationId },
          ),
        );
      }
      if (reservation.kind === "creation_plan_locked") {
        return yield* Effect.fail(
          new GatewayToolError(
            "creation_plan_locked",
            "This caller turn already committed a different thread-creation plan. A new user turn is required for another plan.",
            {
              operationId: reservation.operation.operationId,
              requestId: reservation.operation.requestId,
              requestedCount: reservation.operation.requestedCount,
              status: reservation.operation.status,
            },
          ),
        );
      }
      if (reservation.kind === "replay" && reservation.operation.status === "completed") {
        return mcpToolResultJson(JSON.parse(reservation.operation.resultJson ?? "{}"));
      }
      if (reservation.kind === "replay" && reservation.operation.status === "failed") {
        return yield* Effect.fail(
          new GatewayToolError(
            "operation_failed",
            "The original thread-creation operation failed; it will not create replacement threads.",
            {
              operationId: reservation.operation.operationId,
              error: reservation.operation.errorJson
                ? JSON.parse(reservation.operation.errorJson)
                : null,
            },
          ),
        );
      }

      if (reservation.kind === "replay" && reservation.operation.status !== "reserved") {
        return yield* awaitCreationReplay(operationId);
      }

      const claimed = yield* operationRepository
        .markDispatching({ operationId, now: isoNow() })
        .pipe(Effect.mapError((error) => new ToolInputError(errorText(error))));
      if (!claimed) {
        return yield* awaitCreationReplay(operationId);
      }

      const createdThreads: Array<(typeof prepared)[number]> = [];
      const createdWorktrees: Array<{
        readonly cwd: string;
        readonly path: string;
        readonly branch: string;
      }> = [];

      const results = yield* Effect.forEach(prepared, (entry) =>
        Effect.gen(function* () {
          let branch: string | null = null;
          let worktreePath: string | null = null;
          if (entry.environment === "worktree") {
            const created = yield* git.createWorktree({
              cwd: entry.workspaceRoot,
              branch: entry.baseBranch!,
              newBranch: entry.newBranch!,
              path: entry.plannedWorktreePath,
            });
            branch = created.worktree.branch;
            worktreePath = created.worktree.path;
            createdWorktrees.push({ cwd: entry.workspaceRoot, path: worktreePath, branch });
          }

          yield* orchestrationEngine.dispatch({
            type: "thread.create",
            commandId: entry.ids.threadCreateCommandId,
            threadId: entry.ids.threadId,
            projectId: entry.projectId,
            title: entry.title,
            modelSelection: entry.target,
            runtimeMode: entry.runtimeMode,
            interactionMode: "default",
            envMode: entry.environment,
            branch,
            worktreePath,
            creationSource: "synara_mcp",
            sourceThreadId: ThreadId.makeUnsafe(context.callerThreadId),
            sourceTurnId: TurnId.makeUnsafe(callerTurnId),
            gatewayOperationId: operationId,
            gatewayOperationIndex: entry.index,
            ...(worktreePath !== null
              ? {
                  associatedWorktreePath: worktreePath,
                  associatedWorktreeBranch: branch,
                  associatedWorktreeRef: branch,
                }
              : {}),
            createdAt: isoNow(),
          });
          createdThreads.push(entry);

          yield* orchestrationEngine.dispatch({
            type: "thread.turn.start",
            commandId: entry.ids.turnStartCommandId,
            threadId: entry.ids.threadId,
            message: {
              messageId: entry.ids.messageId,
              role: "user",
              text: entry.spec.prompt,
              attachments: [],
            },
            modelSelection: entry.target,
            dispatchMode: "queue",
            dispatchOrigin: "agent",
            runtimeMode: entry.runtimeMode,
            interactionMode: "default",
            createdAt: isoNow(),
          });

          return {
            index: entry.index,
            threadId: entry.ids.threadId,
            projectId: entry.projectId,
            title: entry.title,
            target: entry.target,
            provider: entry.target.provider,
            model: entry.target.model,
            runtimeMode: entry.runtimeMode,
            environment: entry.environment,
            branch,
            worktreePath,
            status: "task_dispatched",
          };
        }),
      ).pipe(
        Effect.catch((cause) =>
          Effect.gen(function* () {
            yield* operationRepository
              .markCompensating({ operationId, now: isoNow() })
              .pipe(Effect.catch(() => Effect.void));
            const compensationErrors: string[] = [];
            let compensatedThreadCount = 0;
            let compensatedWorktreeCount = 0;
            yield* Effect.forEach(
              [...createdThreads].reverse(),
              (entry) =>
                orchestrationEngine
                  .dispatch({
                    type: "thread.delete",
                    commandId: entry.ids.compensateCommandId,
                    threadId: entry.ids.threadId,
                  })
                  .pipe(
                    Effect.tap(() =>
                      Effect.sync(() => {
                        compensatedThreadCount += 1;
                      }),
                    ),
                    Effect.catch((error) =>
                      Effect.sync(() =>
                        compensationErrors.push(
                          `thread ${entry.ids.threadId}: ${errorText(error)}`,
                        ),
                      ),
                    ),
                  ),
              { discard: true },
            );
            yield* Effect.forEach(
              [...createdWorktrees].reverse(),
              (worktree) =>
                git.removeWorktree({ cwd: worktree.cwd, path: worktree.path, force: true }).pipe(
                  Effect.flatMap(() =>
                    git.deleteBranch({
                      cwd: worktree.cwd,
                      branch: worktree.branch,
                      force: true,
                    }),
                  ),
                  Effect.tap(() =>
                    Effect.sync(() => {
                      compensatedWorktreeCount += 1;
                    }),
                  ),
                  Effect.catch((error) =>
                    Effect.sync(() =>
                      compensationErrors.push(`worktree ${worktree.path}: ${errorText(error)}`),
                    ),
                  ),
                ),
              { discard: true },
            );
            const failure = {
              message: errorText(cause),
              createdThreadCount: createdThreads.length,
              compensatedThreadCount,
              compensatedWorktreeCount,
              compensationErrors,
            };
            if (compensationErrors.length > 0) {
              yield* Effect.logWarning("agent gateway compensation remains pending", {
                operationId,
                errors: compensationErrors,
              });
              return yield* Effect.fail(
                new GatewayToolError(
                  "operation_failed",
                  "Synara could not dispatch the exact creation plan and cleanup is still pending. The durable operation remains compensating and will never create replacements.",
                  { operationId, ...failure, compensationPending: true },
                ),
              );
            }
            yield* operationRepository
              .fail({ operationId, errorJson: JSON.stringify(failure), now: isoNow() })
              .pipe(Effect.catch(() => Effect.void));
            return yield* Effect.fail(
              new GatewayToolError(
                "operation_failed",
                "Synara could not dispatch the exact creation plan. Created operation-owned resources were compensated; no replacements were created.",
                { operationId, ...failure },
              ),
            );
          }),
        ),
      );

      const result = {
        operationId,
        requestId: input.requestId,
        requestedCount: input.threads.length,
        createdCount: results.length,
        threadIds: results.map((entry) => entry.threadId),
        threads: results,
      };
      yield* operationRepository
        .complete({ operationId, resultJson: JSON.stringify(result), now: isoNow() })
        .pipe(Effect.mapError((error) => new ToolInputError(errorText(error))));
      yield* appendThreadCreationRecap({
        callerThreadId: context.callerThreadId,
        callerTurnId,
        result,
      });
      return mcpToolResultJson(result);
    }).pipe(
      Effect.catch((error) =>
        Effect.succeed(
          error instanceof GatewayToolError || error instanceof AgentGatewayTargetError
            ? gatewayToolErrorResult(error)
            : mcpToolResultError(errorText(error)),
        ),
      ),
    );

  const createThreads: ToolEntry = {
    requiresActiveTurn: true,
    definition: {
      name: "synara_create_threads",
      description:
        "Create an exact batch of 1–20 standalone Synara threads. Call once for plural requests; retries with the same requestId replay the same durable operation and never add replacement threads.",
      inputSchema: {
        type: "object",
        properties: {
          requestId: {
            type: "string",
            maxLength: 256,
            description: "Stable id for this exact user-requested creation plan.",
          },
          threads: {
            type: "array",
            minItems: 1,
            maxItems: SYNARA_GATEWAY_MAX_THREADS_PER_OPERATION,
            items: {
              type: "object",
              properties: {
                prompt: { type: "string" },
                title: { type: "string" },
                target: {
                  type: "object",
                  description:
                    "Canonical ModelSelection from synara_capabilities: provider, model, and provider-specific options.",
                },
                projectId: { type: "string" },
                environment: { type: "string", enum: ["local", "worktree"] },
                baseBranch: { type: "string" },
                branchName: { type: "string" },
                runtimeMode: {
                  type: "string",
                  enum: ["approval-required", "full-access"],
                },
              },
              required: ["prompt", "target"],
              additionalProperties: false,
            },
          },
        },
        required: ["requestId", "threads"],
        additionalProperties: false,
      },
      annotations: {
        title: "Create Synara threads",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    handler: (args, context) => runCreateThreads(decodeCreateThreadsInput(args), context),
  };

  const createThread: ToolEntry = {
    requiresActiveTurn: true,
    definition: {
      name: "synara_create_thread",
      description:
        "Create exactly one standalone Synara thread. For two or more threads use one synara_create_threads call instead.",
      inputSchema: {
        type: "object",
        properties: {
          requestId: { type: "string", maxLength: 256 },
          prompt: { type: "string" },
          title: { type: "string" },
          target: {
            type: "object",
            description: "Canonical provider/model/options selection from synara_capabilities.",
          },
          provider: { type: "string", enum: [...PROVIDER_KINDS] },
          model: { type: "string" },
          options: { type: "object" },
          projectId: { type: "string" },
          environment: { type: "string", enum: ["local", "worktree"] },
          baseBranch: { type: "string" },
          branchName: { type: "string" },
          runtimeMode: { type: "string", enum: ["approval-required", "full-access"] },
        },
        required: ["requestId", "prompt"],
        additionalProperties: false,
      },
      annotations: {
        title: "Create a Synara thread",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    handler: (args, context) =>
      Effect.suspend(() => {
        const explicitTarget = readRecordArg(args, "target");
        let target: Record<string, unknown>;
        if (explicitTarget) {
          target = explicitTarget;
        } else {
          const provider = parseProviderKind(readStringArg(args, "provider", { required: true })!);
          const modelSelection = buildModelSelection(provider, readStringArg(args, "model"));
          const options = readRecordArg(args, "options");
          target = { ...modelSelection, ...(options ? { options } : {}) };
        }
        const spec: Record<string, unknown> = {
          prompt: readStringArg(args, "prompt", { required: true })!,
          target,
        };
        for (const key of [
          "title",
          "projectId",
          "environment",
          "baseBranch",
          "branchName",
          "runtimeMode",
        ]) {
          const value = args[key];
          if (value !== undefined) spec[key] = value;
        }
        return runCreateThreads(
          decodeCreateThreadsInput({
            requestId: readStringArg(args, "requestId", { required: true }),
            threads: [spec],
          }),
          context,
        ).pipe(
          Effect.map((result) => {
            if (result.isError) return result;
            const batch = JSON.parse(result.content[0]?.text ?? "{}") as {
              operationId?: string;
              requestId?: string;
              threads?: Array<Record<string, unknown>>;
            };
            return mcpToolResultJson({
              operationId: batch.operationId,
              requestId: batch.requestId,
              ...(batch.threads?.[0] ?? {}),
            });
          }),
        );
      }).pipe(Effect.catchDefect((error) => Effect.succeed(mcpToolResultError(errorText(error))))),
  };

  const sendMessage: ToolEntry = {
    requiresActiveTurn: true,
    definition: {
      name: "synara_send_message",
      description:
        'Send a Synara follow-up message to an existing thread. mode "queue" (default) waits for the current turn; "steer" redirects a running turn where the provider supports it (otherwise it is queued).',
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
      annotations: { title: "Send a Synara message", ...WRITE_TOOL_ANNOTATIONS },
    },
    handler: (args, context) =>
      Effect.gen(function* () {
        const threadId = readStringArg(args, "threadId", { required: true })!;
        const message = readStringArg(args, "message", { required: true })!;
        const modeArg = readStringArg(args, "mode") ?? "queue";
        if (modeArg !== "queue" && modeArg !== "steer") {
          throw new ToolInputError(`Argument "mode" must be "queue" or "steer".`);
        }
        const caller = yield* requireThreadShell(context.callerThreadId);
        const target = yield* requireThreadShell(threadId);
        yield* assertCallerMayDriveThread(caller, target);
        // Pass the requested mode through unchanged: the reactor checks live
        // provider state (authoritative, unlike this projection snapshot) and
        // already downgrades steers whose turn is not actually live.
        const dispatchMode: TurnDispatchMode = modeArg;
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
    requiresActiveTurn: true,
    definition: {
      name: "synara_interrupt_thread",
      description: "Interrupt the running turn of a Synara thread.",
      inputSchema: {
        type: "object",
        properties: {
          threadId: { type: "string", description: "Thread whose turn should be interrupted." },
        },
        required: ["threadId"],
        additionalProperties: false,
      },
      annotations: { title: "Interrupt a Synara thread", ...WRITE_TOOL_ANNOTATIONS },
    },
    handler: (args, context) =>
      Effect.gen(function* () {
        const threadId = readStringArg(args, "threadId", { required: true })!;
        const caller = yield* requireThreadShell(context.callerThreadId);
        const target = yield* requireThreadShell(threadId);
        // Stopping a higher-privileged thread's work is still driving it.
        yield* assertCallerMayDriveThread(caller, target);
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
    requiresActiveTurn: true,
    definition: {
      name: "synara_set_thread_title",
      description: "Rename a Synara thread.",
      inputSchema: {
        type: "object",
        properties: {
          threadId: { type: "string", description: "Thread to rename." },
          title: { type: "string", description: "New title." },
        },
        required: ["threadId", "title"],
        additionalProperties: false,
      },
      annotations: { title: "Rename a Synara thread", ...WRITE_TOOL_ANNOTATIONS },
    },
    handler: (args, context) =>
      Effect.gen(function* () {
        const threadId = readStringArg(args, "threadId", { required: true })!;
        const title = readStringArg(args, "title", { required: true })!;
        const caller = yield* requireThreadShell(context.callerThreadId);
        const target = yield* requireThreadShell(threadId);
        yield* assertCallerMayDriveThread(caller, target);
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
    requiresActiveTurn: true,
    definition: {
      name: "synara_set_thread_archived",
      description:
        "Archive or unarchive a Synara thread. Defaults to your own thread when threadId is omitted.",
      inputSchema: {
        type: "object",
        properties: {
          threadId: { type: "string", description: "Thread to archive/unarchive." },
          archived: { type: "boolean", description: "true to archive, false to unarchive." },
        },
        required: ["archived"],
        additionalProperties: false,
      },
      annotations: { title: "Update a Synara thread", ...WRITE_TOOL_ANNOTATIONS },
    },
    handler: (args, context) =>
      Effect.gen(function* () {
        const threadId = readStringArg(args, "threadId") ?? context.callerThreadId;
        const archived = readBooleanArg(args, "archived");
        if (archived === undefined) {
          throw new ToolInputError(`Missing required argument "archived".`);
        }
        const caller = yield* requireThreadShell(context.callerThreadId);
        const target = yield* requireThreadShell(threadId);
        yield* assertCallerMayDriveThread(caller, target);
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
    requiresActiveTurn: true,
    definition: {
      name: "synara_create_automation",
      description:
        "Create a Synara heartbeat automation that wakes a thread on an interval (default: your own thread every 5 minutes). Use it for periodic monitoring instead of relying on memory; cancel it with synara_cancel_automation when done.",
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
      annotations: { title: "Create a Synara automation", ...WRITE_TOOL_ANNOTATIONS },
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
        if (target.id !== context.callerThreadId) {
          // A heartbeat repeatedly executes prompts on the target with the
          // target's privileges; cap it exactly like direct sends.
          const caller = yield* requireThreadShell(context.callerThreadId);
          yield* assertCallerMayDriveThread(caller, target);
        }
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
      description:
        "List Synara automations (id, name, schedule, target thread, enabled, next run).",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string", description: "Only automations of this project." },
        },
        additionalProperties: false,
      },
      annotations: { title: "List Synara automations", ...READ_ONLY_TOOL_ANNOTATIONS },
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
    requiresActiveTurn: true,
    definition: {
      name: "synara_cancel_automation",
      description:
        'Stop a Synara automation. mode "disable" (default) pauses it and keeps history; "delete" archives it.',
      inputSchema: {
        type: "object",
        properties: {
          automationId: { type: "string", description: "Automation to stop." },
          mode: { type: "string", enum: ["disable", "delete"], description: "Stop mode." },
        },
        required: ["automationId"],
        additionalProperties: false,
      },
      annotations: { title: "Stop a Synara automation", ...WRITE_TOOL_ANNOTATIONS },
    },
    handler: (args, context) =>
      Effect.gen(function* () {
        const automationId = readStringArg(args, "automationId", { required: true })!;
        const modeArg = readStringArg(args, "mode") ?? "disable";
        if (modeArg !== "disable" && modeArg !== "delete") {
          throw new ToolInputError(`Argument "mode" must be "disable" or "delete".`);
        }
        const id = AutomationId.makeUnsafe(automationId);
        const caller = yield* requireThreadShell(context.callerThreadId);
        const definition = yield* requireAutomationDefinition(automationId);
        yield* assertCallerMayCancelAutomation(caller, definition);
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
    contextTool,
    capabilitiesTool,
    listProjects,
    listThreads,
    readThread,
    waitForThreads,
    createThreads,
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

  const handleRequest = (request: JsonRpcRequest, context: Omit<ToolContext, "jsonRpcRequestId">) =>
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
          const requiredCapability = tool.requiresActiveTurn
            ? toolName.includes("automation")
              ? "automation:write"
              : "thread:write"
            : "thread:read";
          if (!context.callerCapabilities.has(requiredCapability)) {
            return jsonRpcResult(
              request.id,
              gatewayToolErrorResult(
                new GatewayToolError(
                  "capability_denied",
                  `This provider session is not authorized for ${requiredCapability}.`,
                  { requiredCapability },
                ),
              ),
            );
          }
          let invocationContext: ToolContext = {
            ...context,
            jsonRpcRequestId: request.id,
          };
          if (tool.requiresActiveTurn) {
            const caller = yield* requireThreadShell(context.callerThreadId);
            if (caller.latestTurn?.state !== "running") {
              return jsonRpcResult(
                request.id,
                gatewayToolErrorResult(
                  new GatewayToolError(
                    "caller_turn_inactive",
                    "This Synara write was rejected because the calling turn is no longer active. Detached or completed agents cannot mutate Synara resources.",
                    {
                      callerThreadId: context.callerThreadId,
                      latestTurnId: caller.latestTurn?.turnId ?? null,
                      latestTurnState: caller.latestTurn?.state ?? null,
                    },
                  ),
                ),
              );
            }
            invocationContext = {
              ...invocationContext,
              callerTurnId: caller.latestTurn.turnId,
            };
          }
          const result = yield* Effect.suspend(() => tool.handler(args, invocationContext)).pipe(
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
      const callerSession = token ? credentials.verifySession(token) : null;
      if (!callerSession) {
        return {
          status: 401,
          body: jsonRpcError(
            null,
            JSON_RPC_INVALID_REQUEST,
            "caller_session_inactive: Missing, expired, revoked, or invalid provider-session credential.",
          ),
        };
      }
      const callerThreadId = callerSession.threadId;
      // The registry is in-memory and session scoped. Also bind the credential
      // to the current projected thread/provider so a deleted or re-routed
      // session cannot retain app-control access.
      const callerThread = yield* snapshotQuery
        .getThreadShellById(ThreadId.makeUnsafe(callerThreadId))
        .pipe(Effect.catch(() => Effect.succeed(Option.none())));
      if (Option.isNone(callerThread)) {
        return {
          status: 401,
          body: jsonRpcError(
            null,
            JSON_RPC_INVALID_REQUEST,
            "Bearer token refers to a thread that no longer exists.",
          ),
        };
      }
      if (callerThread.value.modelSelection.provider !== callerSession.provider) {
        return {
          status: 401,
          body: jsonRpcError(
            null,
            JSON_RPC_INVALID_REQUEST,
            "caller_session_inactive: Provider session no longer owns this thread.",
          ),
        };
      }
      const context: Omit<ToolContext, "jsonRpcRequestId"> = {
        callerThreadId,
        callerSessionKey: callerSession.sessionKey,
        callerProvider: callerSession.provider,
        callerCapabilities: callerSession.capabilities,
        callerTurnId:
          callerThread.value.latestTurn?.state === "running"
            ? callerThread.value.latestTurn.turnId
            : null,
      };

      const rawMessages = Array.isArray(input.body) ? input.body : [input.body];
      if (rawMessages.length === 0) {
        return {
          status: 400,
          body: jsonRpcError(null, JSON_RPC_INVALID_REQUEST, "Empty JSON-RPC batch."),
        };
      }
      if (rawMessages.length > MCP_MAX_BATCH_MESSAGES) {
        return {
          status: 400,
          body: jsonRpcError(
            null,
            JSON_RPC_INVALID_REQUEST,
            `JSON-RPC batches may contain at most ${MCP_MAX_BATCH_MESSAGES} messages.`,
          ),
        };
      }
      const parsedMessages = rawMessages.map(parseMcpMessage);
      const requestIds = new Set<string>();
      for (const parsed of parsedMessages) {
        if (parsed.kind !== "request") continue;
        const key = `${typeof parsed.request.id}:${String(parsed.request.id)}`;
        if (requestIds.has(key)) {
          return {
            status: 400,
            body: jsonRpcError(
              parsed.request.id,
              JSON_RPC_INVALID_REQUEST,
              `Duplicate JSON-RPC request id ${JSON.stringify(parsed.request.id)} in one batch.`,
            ),
          };
        }
        requestIds.add(key);
      }
      const responses: Array<Record<string, unknown>> = [];
      for (const parsed of parsedMessages) {
        switch (parsed.kind) {
          case "request":
            responses.push(
              yield* handleRequest(parsed.request, context).pipe(
                Effect.catch((error) =>
                  Effect.succeed(
                    jsonRpcResult(parsed.request.id, mcpToolResultError(errorText(error))),
                  ),
                ),
              ),
            );
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
