import {
  SYNARA_GATEWAY_MAX_THREADS_PER_OPERATION,
  SYNARA_GATEWAY_MAX_WAIT_MS,
  SYNARA_GATEWAY_MAX_THREADS_PER_TURN,
  ThreadId,
  ProjectId,
  type OrchestrationThreadShell,
  type ProviderKind,
} from "@synara/contracts";
import { Clock, Effect, Option } from "effect";

import {
  isOrdinaryProjectRow,
  type SpaceAssignmentWorkspacePaths,
} from "../orchestration/commandInvariants.ts";
import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import type {
  ProjectionAgentWaitTarget,
  ProjectionTurnRepositoryShape,
} from "../persistence/Services/ProjectionTurns.ts";
import type { ProviderDiscoveryServiceShape } from "../provider/Services/ProviderDiscoveryService.ts";
import { SYNARA_HARNESS_POLICY_VERSION } from "./harnessPolicy.ts";
import { mcpToolResultError, mcpToolResultJson } from "./protocol.ts";
import {
  AGENT_GATEWAY_TARGET_OPTIONS_DESCRIPTION,
  agentGatewayTargetOptionGuidance,
  loadAgentGatewayProviderCatalog,
  type AgentGatewayProviderAvailability,
} from "./targetResolver.ts";
import {
  deriveAgentThreadStatus,
  READ_THREAD_MAX_MESSAGE_CHARS,
  READ_THREAD_MAX_MESSAGE_LIMIT,
  summarizeThreadDetail,
  summarizeThreadShell,
  summarizeWaitThreadText,
  WAIT_THREAD_SUMMARY_MAX_CHARS,
} from "./threadSummary.ts";
import {
  decodeWaitForThreadsInput,
  errorText,
  PROVIDER_KINDS,
  readBooleanArg,
  readIsoTimestampArg,
  readNumberArg,
  readStringArg,
  ToolInputError,
} from "./toolInput.ts";
import {
  gatewayToolErrorResult,
  GatewayToolError,
  READ_ONLY_TOOL_ANNOTATIONS,
  type ToolEntry,
} from "./toolRuntime.ts";

const LIST_THREADS_DEFAULT_LIMIT = 50;
const LIST_THREADS_MAX_LIMIT = 200;
// Leave time for the progress response before the caller's 60-second tool deadline.
const WAIT_PROGRESS_INTERVAL_MS = 30_000;
const WAIT_SUMMARY_BUDGET_MS = 2_000;

export interface ThreadReadToolsInput {
  readonly snapshotQuery: ProjectionSnapshotQueryShape;
  readonly projectionTurns: ProjectionTurnRepositoryShape;
  readonly providerDiscovery: ProviderDiscoveryServiceShape;
  readonly loadProviderAvailabilities: Effect.Effect<
    ReadonlyMap<ProviderKind, AgentGatewayProviderAvailability>,
    unknown,
    never
  >;
  readonly requireThreadShell: (
    threadId: string,
  ) => Effect.Effect<OrchestrationThreadShell, unknown, never>;
  readonly workspacePaths: SpaceAssignmentWorkspacePaths;
}

export function makeThreadReadTools(input: ThreadReadToolsInput): ReadonlyArray<ToolEntry> {
  const {
    snapshotQuery,
    projectionTurns,
    providerDiscovery,
    loadProviderAvailabilities,
    requireThreadShell,
    workspacePaths,
  } = input;

  const contextTool: ToolEntry = {
    requiredCapability: "thread:read",
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
            diagnostics: context.callerCapabilities.has("diagnostics:read"),
            automations: turnId !== null && context.callerCapabilities.has("automation:write"),
          },
        });
      }).pipe(Effect.catch((error) => Effect.succeed(mcpToolResultError(errorText(error))))),
  };

  const capabilitiesTool: ToolEntry = {
    requiredCapability: "thread:read",
    definition: {
      name: "synara_capabilities",
      description: `List canonical Synara provider/model targets and delegation constraints. Use instanceId to look up the catalog and exact options for a particular account. ${AGENT_GATEWAY_TARGET_OPTIONS_DESCRIPTION}`,
      inputSchema: {
        type: "object",
        properties: {
          projectId: {
            type: "string",
            description: "Project for provider discovery; required on another computer.",
          },
          instanceId: {
            type: "string",
            description:
              "Exact account ID from providers[].instances[].instanceId. Omit for the default catalogs.",
          },
        },
        additionalProperties: false,
      },
      annotations: {
        title: "Synara capabilities",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    handler: (args, context) =>
      Effect.gen(function* () {
        const projectArg = readStringArg(args, "projectId", { required: !!context.remoteCaller });
        const instanceId = readStringArg(args, "instanceId");
        const localCaller = context.remoteCaller
          ? undefined
          : yield* requireThreadShell(context.callerThreadId);
        const callerMode = context.remoteCaller?.runtimeMode ?? localCaller?.runtimeMode;
        const projectId = ProjectId.makeUnsafe((projectArg ?? localCaller?.projectId)!);
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
        const availabilities = yield* loadProviderAvailabilities;
        const providerKinds = instanceId
          ? PROVIDER_KINDS.filter((provider) =>
              availabilities
                .get(provider)
                ?.instances?.some((instance) => instance.instanceId === instanceId),
            )
          : PROVIDER_KINDS;
        if (providerKinds.length === 0) {
          return yield* Effect.fail(
            new ToolInputError(
              `Unknown provider instance "${instanceId}". Use an ID from synara_capabilities.`,
            ),
          );
        }
        const providers = yield* Effect.forEach(providerKinds, (provider) =>
          loadAgentGatewayProviderCatalog({
            provider,
            discovery: providerDiscovery,
            ...(availabilities.get(provider) !== undefined
              ? { availability: availabilities.get(provider)! }
              : {}),
            cwd: project.workspaceRoot,
            ...(callerMode ? { callerMode } : {}),
            ...(instanceId ? { instanceId } : {}),
          }),
        );
        const targetConstruction = Object.fromEntries(
          providers.map((provider) => [
            provider.provider,
            {
              modelValueSource: "providers[].models[].slug",
              ...agentGatewayTargetOptionGuidance(provider),
            },
          ]),
        );
        return mcpToolResultJson({
          targetConstruction,
          providers,
          limits: {
            maxThreadsPerOperation: SYNARA_GATEWAY_MAX_THREADS_PER_OPERATION,
            maxWaitMs: SYNARA_GATEWAY_MAX_WAIT_MS,
            oneCreationPlanPerActiveTurn: false,
            maxThreadsPerActiveTurn: SYNARA_GATEWAY_MAX_THREADS_PER_TURN,
          },
        });
      }).pipe(Effect.catch((error) => Effect.succeed(mcpToolResultError(errorText(error))))),
  };

  const listProjects: ToolEntry = {
    requiredCapability: "thread:read",
    definition: {
      name: "synara_list_projects",
      description:
        "List Synara projects (id, title, workspace root). System-managed containers (the Chats and Studio surfaces) are not projects and are excluded. Use before creating a thread in another project.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { title: "List Synara projects", ...READ_ONLY_TOOL_ANNOTATIONS },
    },
    handler: () =>
      snapshotQuery.getShellSnapshot().pipe(
        Effect.map((snapshot) =>
          mcpToolResultJson({
            projects: snapshot.projects
              .filter((project) =>
                isOrdinaryProjectRow({
                  projectKind: project.kind,
                  projectTitle: project.title,
                  projectWorkspaceRoot: project.workspaceRoot,
                  workspacePaths,
                }),
              )
              .map((project) => ({
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
    requiredCapability: "thread:read",
    definition: {
      name: "synara_list_threads",
      description:
        "Discover Synara threads by project, hierarchy, provider, model, status, title, creation source, or update window. Archived threads are hidden unless includeArchived is true.",
      inputSchema: {
        type: "object",
        properties: {
          projectId: { type: "string", description: "Only threads of this project." },
          parentThreadId: {
            type: "string",
            description: "Only child threads of this thread (e.g. your own thread id).",
          },
          provider: { type: "string", enum: [...PROVIDER_KINDS] },
          model: { type: "string", description: "Exact model slug." },
          status: {
            type: "string",
            description:
              "Derived thread status such as working, idle, error, or waiting-for-approval.",
          },
          titleContains: { type: "string", description: "Case-insensitive title substring." },
          creationSource: { type: "string", description: "Exact thread creation source." },
          updatedAfter: { type: "string", description: "ISO timestamp lower bound (inclusive)." },
          updatedBefore: { type: "string", description: "ISO timestamp upper bound (inclusive)." },
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
        const provider = readStringArg(args, "provider");
        const model = readStringArg(args, "model");
        const status = readStringArg(args, "status");
        const titleContains = readStringArg(args, "titleContains")?.toLocaleLowerCase();
        const creationSource = readStringArg(args, "creationSource");
        const updatedAfter = readIsoTimestampArg(args, "updatedAfter");
        const updatedBefore = readIsoTimestampArg(args, "updatedBefore");
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
          .filter((thread) => (provider ? thread.modelSelection.provider === provider : true))
          .filter((thread) => (model ? thread.modelSelection.model === model : true))
          .filter((thread) => (status ? deriveAgentThreadStatus(thread) === status : true))
          .filter((thread) =>
            titleContains ? thread.title.toLocaleLowerCase().includes(titleContains) : true,
          )
          .filter((thread) =>
            creationSource ? (thread.creationSource ?? null) === creationSource : true,
          )
          .filter((thread) => (updatedAfter ? thread.updatedAt >= updatedAfter : true))
          .filter((thread) => (updatedBefore ? thread.updatedAt <= updatedBefore : true))
          .filter((thread) => (includeArchived ? true : (thread.archivedAt ?? null) === null))
          .toSorted((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
        const threads = matching
          .slice(0, limit)
          .map((thread) => summarizeThreadShell(thread, context.callerThreadId));
        return mcpToolResultJson({ threads, totalMatching: matching.length });
      }).pipe(Effect.catch((error) => Effect.succeed(mcpToolResultError(errorText(error))))),
  };

  const readThread: ToolEntry = {
    requiredCapability: "thread:read",
    definition: {
      name: "synara_read_thread",
      description: `Read one Synara thread's status and recent messages (newest last). Pass nextCursor as cursor to page older messages. To read one settled long message losslessly, pass the summary's index, messageId, and messageVersion with messageOffsetChars 0, then follow messagePage.nextOffsetChars with the same identity and version.`,
      inputSchema: {
        type: "object",
        properties: {
          threadId: { type: "string", description: "Thread to read." },
          cursor: { type: "string", description: "Pagination cursor from a previous call." },
          messageLimit: {
            type: "integer",
            minimum: 1,
            maximum: READ_THREAD_MAX_MESSAGE_LIMIT,
            description: `Messages per transcript page (default 20, max ${READ_THREAD_MAX_MESSAGE_LIMIT}).`,
          },
          maxMessageChars: {
            type: "integer",
            minimum: 50,
            maximum: READ_THREAD_MAX_MESSAGE_CHARS,
            description: `Characters per message or single-message slice (default 1500, max ${READ_THREAD_MAX_MESSAGE_CHARS}). The response reports the effective value.`,
          },
          messageIndex: {
            type: "integer",
            minimum: 0,
            description:
              "Current transcript index of one message to read losslessly; messageId and messageVersion detect stale coordinates.",
          },
          messageOffsetChars: {
            type: "integer",
            minimum: 0,
            description:
              "Character offset within messageIndex (default 0); follow messagePage.nextOffsetChars until absent.",
          },
          messageId: {
            type: "string",
            description:
              "Message identity returned in each message summary; required with messageIndex.",
          },
          messageVersion: {
            type: "string",
            description:
              "Opaque version returned in each message summary; required with messageIndex so slices stay bound to one snapshot.",
          },
        },
        required: ["threadId"],
        additionalProperties: false,
      },
      annotations: { title: "Read a Synara thread", ...READ_ONLY_TOOL_ANNOTATIONS },
    },
    handler: (args, _context) =>
      Effect.gen(function* () {
        const threadId = readStringArg(args, "threadId", { required: true })!;
        const cursor = readStringArg(args, "cursor");
        const messageLimit = readNumberArg(args, "messageLimit");
        const maxMessageChars = readNumberArg(args, "maxMessageChars");
        const messageIndex = readNumberArg(args, "messageIndex");
        const messageOffsetChars = readNumberArg(args, "messageOffsetChars");
        const messageId = readStringArg(args, "messageId");
        const messageVersion = readStringArg(args, "messageVersion");
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
            cursor,
            messageLimit,
            maxMessageChars,
            messageIndex,
            messageOffsetChars,
            messageId,
            messageVersion,
          }),
        );
      }).pipe(Effect.catch((error) => Effect.succeed(mcpToolResultError(errorText(error))))),
  };

  const waitForThreads: ToolEntry = {
    requiredCapability: "thread:read",
    definition: {
      name: "synara_wait_for_threads",
      description: `Wait for the pinned turns of 1–20 Synara threads and return every outcome in input order. When results are required, keep calling until allTerminal is true, passing the returned runIds to each subsequent call. A timedOut response is progress, not completion; do not finish or ask the user to check again while required work is pending. Assistant summaries are capped at ${WAIT_THREAD_SUMMARY_MAX_CHARS} characters and can be omitted if collecting them takes too long. Use each result's readThread call to page the full transcript. Timeouts never retry, replace, cancel, or create work.`,
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
            description:
              "Optional pinned turn IDs from a prior wait. Keep null for a child with no provider turn ID yet. Must match threadIds length.",
          },
          timeoutMs: {
            type: "integer",
            minimum: 0,
            maximum: SYNARA_GATEWAY_MAX_WAIT_MS,
            description: `Upper bound for this wait. Pending work returns progress after at most ${WAIT_PROGRESS_INTERVAL_MS}ms of polling.`,
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
        const waitInput = decodeWaitForThreadsInput(args);
        if (waitInput.runIds && waitInput.runIds.length !== waitInput.threadIds.length) {
          throw new ToolInputError('Argument "runIds" must have the same length as "threadIds".');
        }
        const timeoutMs = Math.min(
          waitInput.timeoutMs ?? WAIT_PROGRESS_INTERVAL_MS,
          WAIT_PROGRESS_INTERVAL_MS,
        );
        const deadline = (yield* Clock.currentTimeMillis) + timeoutMs;
        const targets: ProjectionAgentWaitTarget[] = waitInput.threadIds.map((threadId, index) => ({
          threadId,
          turnId: waitInput.runIds?.[index] ?? null,
          pendingMessageId: null,
        }));
        const readPinnedStates = (resolveUnpinned: boolean) =>
          Effect.gen(function* () {
            const snapshots = yield* projectionTurns
              .getManyAgentWaitSnapshots({ targets, resolveUnpinned })
              .pipe(Effect.mapError((error) => new ToolInputError(errorText(error))));
            return yield* Effect.forEach(targets, (target, index) => {
              const snapshot = snapshots[index];
              if (!snapshot) {
                return Effect.fail(
                  new GatewayToolError(
                    "thread_not_found",
                    `Thread "${target.threadId}" was not found.`,
                  ),
                );
              }
              const runId = target.turnId ?? snapshot.turnId;
              const pendingMessageId =
                runId === null ? (target.pendingMessageId ?? snapshot.pendingMessageId) : null;
              targets[index] = { ...target, turnId: runId, pendingMessageId };
              // A pending request that disappeared without creating its own turn
              // was cancelled or superseded. Do not switch to unrelated work.
              const unresolvedState =
                runId !== null ? "pending" : pendingMessageId !== null ? "interrupted" : "idle";
              const state = snapshot.state ?? unresolvedState;
              return Effect.succeed({
                threadId: target.threadId,
                runId,
                state,
                terminal: state !== "pending" && state !== "running",
                timedOut: false,
                summary: null as string | null,
                summaryTruncated: false,
                error: state === "error" ? (snapshot.error ?? "Turn failed.") : null,
                readThread: {
                  tool: "synara_read_thread" as const,
                  arguments: { threadId: target.threadId },
                },
              });
            });
          });

        let results = yield* readPinnedStates(true);
        let pollDelayMs = 200;
        while (results.some((result) => !result.terminal)) {
          const remainingMs = deadline - (yield* Clock.currentTimeMillis);
          if (remainingMs <= 0) break;
          yield* Effect.sleep(Math.min(pollDelayMs, remainingMs));
          results = yield* readPinnedStates(false);
          pollDelayMs = Math.min(1_000, Math.ceil(pollDelayMs * 1.5));
        }
        const timedOut = results.some((result) => !result.terminal);
        const summaryDeadline = (yield* Clock.currentTimeMillis) + WAIT_SUMMARY_BUDGET_MS;
        const finalResults = yield* Effect.forEach(results, (result) =>
          Effect.gen(function* () {
            if (!result.terminal || result.runId === null) {
              return { ...result, timedOut: !result.terminal && timedOut };
            }
            const remainingMs = summaryDeadline - (yield* Clock.currentTimeMillis);
            if (remainingMs <= 0) return result;
            const detail = yield* snapshotQuery.getThreadDetailById(result.threadId).pipe(
              Effect.mapError((error) => new ToolInputError(errorText(error))),
              Effect.flatMap(
                Option.match({
                  onNone: () =>
                    Effect.fail(
                      new GatewayToolError(
                        "thread_not_found",
                        `Thread "${result.threadId}" was not found.`,
                      ),
                    ),
                  onSome: Effect.succeed,
                }),
              ),
              Effect.timeoutOrElse({
                duration: remainingMs,
                onTimeout: () => Effect.succeed(null),
              }),
            );
            if (detail === null) return result;
            const assistantMessage = detail.messages.findLast(
              (message) => message.role === "assistant" && message.turnId === result.runId,
            );
            const summary = summarizeWaitThreadText(assistantMessage?.text);
            return {
              ...result,
              summary: summary.summary,
              summaryTruncated: summary.truncated,
              error: result.state === "error" ? (detail.session?.lastError ?? result.error) : null,
            };
          }),
        );
        return mcpToolResultJson({
          callerThreadId: context.callerThreadId,
          runIds: finalResults.map((result) => result.runId),
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

  return [contextTool, capabilitiesTool, listProjects, listThreads, readThread, waitForThreads];
}
