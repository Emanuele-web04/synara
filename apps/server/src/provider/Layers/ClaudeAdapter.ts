/**
 * ClaudeAdapterLive - Scoped live implementation for the Claude Agent provider adapter.
 *
 * Wraps `@anthropic-ai/claude-agent-sdk` query sessions behind the generic
 * provider adapter contract and emits canonical runtime events.
 *
 * @module ClaudeAdapterLive
 */
import {
  type AgentInfo,
  type CanUseTool,
  type AgentDefinition,
  query,
  type Options as ClaudeQueryOptions,
  type ModelInfo,
  type PermissionMode,
  type PermissionResult,
  type PermissionUpdate,
  type SDKMessage,
  type SDKResultMessage,
  type SettingSource,
  type SDKUserMessage,
  type SlashCommand,
} from "@anthropic-ai/claude-agent-sdk";
import {
  ApprovalRequestId,
  type CanonicalItemType,
  type CanonicalRequestType,
  EventId,
  type ProviderApprovalDecision,
  ProviderItemId,
  type ProviderRuntimeEvent,
  type ProviderRuntimeTurnStatus,
  type ProviderSendTurnInput,
  type ProviderSession,
  type ThreadTokenUsageSnapshot,
  type ProviderUserInputAnswers,
  RuntimeItemId,
  RuntimeRequestId,
  RuntimeTaskId,
  ThreadId,
  TurnId,
  type UserInputQuestion,
  type ClaudeApiEffort,
  type ClaudeCodeEffort,
  type ProviderComposerCapabilities,
  type ProviderListCommandsInput,
  type ProviderListCommandsResult,
  type ProviderListSkillsInput,
  type ProviderListSkillsResult,
  type ProviderListAgentsResult,
  type ProviderListModelsResult,
  getAgentMentionAliases,
} from "@t3tools/contracts";
import {
  hasEffortLevel,
  applyClaudePromptEffortPrefix,
  getModelCapabilities,
  resolveApiModelId,
  trimOrNull,
} from "@t3tools/shared/model";
import { buildClaudeSubagentPrompt } from "@t3tools/shared/agentMentions";
import {
  Cause,
  DateTime,
  Deferred,
  Effect,
  Exit,
  FileSystem,
  Fiber,
  Layer,
  Queue,
  Random,
  Ref,
  Stream,
} from "effect";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import { buildFileAttachmentsPromptBlock } from "../attachmentProjection.ts";
import { buildClaudeProcessEnv } from "../claudeProcessEnv.ts";
import {
  CLAUDE_BENIGN_TERMINATION_MESSAGE,
  exitPlanCaptureKey,
  extractAssistantTextBlocks,
  extractContentBlockText,
  extractExitPlanModePlan,
  extractTextContent,
  hasDurableClaudeSessionId,
  interruptionMessageFromClaudeCause,
  isClaudeBenignTerminationCause,
  isClaudeInterruptedCause,
  isReplayedUserMessage,
  messageFromClaudeStreamCause,
  messageParentToolUseId,
  normalizeClaudeUserVisibleErrorMessage,
  readClaudeResumeState,
  sanitizeClaudeDisplayText,
  sdkMessageSubtype,
  sdkMessageType,
  sdkNativeItemId,
  sdkNativeMethod,
  streamKindFromDeltaType,
  toError,
  toMessage,
  toolResultBlocksFromUserMessage,
  tryParseJsonRecord,
  turnStatusFromResult,
} from "../claudeSdkMessages.ts";
import {
  classifyRequestType,
  classifyToolItemType,
  isClientSurfacedClaudeTool,
  normalizeClaudeTodoTasks,
  summarizeToolRequest,
  titleForTool,
  toolInputFingerprint,
  toolLifecycleEventData,
  toolResultStreamKind,
} from "../claudeToolClassification.ts";
import {
  maxClaudeContextWindowFromModelUsage,
  mergeClaudeTokenUsageSnapshot,
  normalizeClaudeTokenUsage,
  resolveEffectiveClaudeContextWindow,
  resolveSelectedClaudeContextWindowMaxTokens,
} from "../claudeTokenUsage.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import { extractProposedPlanMarkdown, withProviderPlanModePrompt } from "../planMode.ts";
import { ClaudeAdapter, type ClaudeAdapterShape } from "../Services/ClaudeAdapter.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";

const PROVIDER = "claudeAgent" as const;

type PromptQueueItem =
  | {
      readonly type: "message";
      readonly message: SDKUserMessage;
    }
  | {
      readonly type: "terminate";
    };

interface ClaudeTurnState {
  readonly turnId: TurnId;
  readonly startedAt: string;
  readonly interactionMode: "default" | "plan";
  // "user" turns are opened by sendTurn and closed by their SDK result message.
  // "synthetic" turns are opened by unsolicited runtime activity (background
  // task continuations) and closed by result or the session_state_changed
  // idle signal, whichever arrives first.
  readonly origin: "user" | "synthetic";
  readonly items: Array<unknown>;
  readonly assistantTextBlocks: Map<number, AssistantTextBlockState>;
  readonly assistantTextBlockOrder: Array<AssistantTextBlockState>;
  readonly capturedProposedPlanKeys: Set<string>;
  readonly sawFileChange: boolean;
  nextSyntheticAssistantBlockIndex: number;
}

interface AssistantTextBlockState {
  readonly itemId: string;
  readonly blockIndex: number;
  emittedTextDelta: boolean;
  fallbackText: string;
  streamClosed: boolean;
  completionEmitted: boolean;
}

interface PendingApproval {
  readonly requestType: CanonicalRequestType;
  readonly detail?: string;
  readonly suggestions?: ReadonlyArray<PermissionUpdate>;
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
}

interface PendingUserInput {
  readonly questions: ReadonlyArray<UserInputQuestion>;
  readonly answers: Deferred.Deferred<ProviderUserInputAnswers>;
}

function coerceClaudeAnswerValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string").join(", ");
  }
  return "";
}

// Claude's AskUserQuestion SDK expects answers keyed by question text; the web UI submits stable ids.
function remapAnswersToClaudeQuestionText(
  questions: ReadonlyArray<UserInputQuestion>,
  answers: ProviderUserInputAnswers,
): Record<string, string> {
  const remapped: Record<string, string> = {};
  for (const [key, value] of Object.entries(answers)) {
    remapped[key] = coerceClaudeAnswerValue(value);
  }

  for (const question of questions) {
    if (Object.hasOwn(remapped, question.question)) {
      continue;
    }

    if (Object.hasOwn(remapped, question.id)) {
      remapped[question.question] = remapped[question.id]!;
      delete remapped[question.id];
    }
  }

  return remapped;
}

interface ToolInFlight {
  readonly itemId: string;
  readonly itemType: CanonicalItemType;
  readonly toolName: string;
  readonly title: string;
  readonly detail?: string;
  readonly input: Record<string, unknown>;
  readonly partialInputJson: string;
  readonly lastEmittedInputFingerprint?: string;
}

interface ClaudeSessionContext {
  session: ProviderSession;
  readonly promptQueue: Queue.Queue<PromptQueueItem>;
  readonly query: ClaudeQueryRuntime;
  streamFiber: Fiber.Fiber<void, Error> | undefined;
  readonly startedAt: string;
  readonly basePermissionMode: PermissionMode | undefined;
  lastInteractionMode: "default" | "plan" | undefined;
  currentApiModelId: string | undefined;
  resumeSessionId: string | undefined;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>;
  readonly turns: Array<{
    id: TurnId;
    items: Array<unknown>;
  }>;
  // Tool_use blocks of the message currently being streamed, keyed by their
  // content-block index. Indices restart at 0 for every streamed message, so
  // this map is cleared on each message_start (see rotateStreamingMessage).
  readonly streamingToolsByIndex: Map<number, ToolInFlight>;
  // Tools whose tool_result has not arrived yet, keyed by tool_use id. Entries
  // survive message boundaries — parallel and backgrounded calls resolve after
  // later messages have started streaming.
  readonly toolsAwaitingResult: Map<string, ToolInFlight>;
  turnState: ClaudeTurnState | undefined;
  interruptRequestedTurnId: TurnId | undefined;
  // Results owed for turns that were force-closed before their SDK result
  // arrived (sendTurn preempting a still-running turn). Each pending entry
  // swallows one incoming result so it cannot complete the wrong turn.
  staleResultsExpected: number;
  lastKnownContextWindow: number | undefined;
  lastKnownTokenUsage: ThreadTokenUsageSnapshot | undefined;
  lastAssistantUuid: string | undefined;
  lastThreadStartedId: string | undefined;
  stopped: boolean;
  // Unrecognized SDK message kinds already surfaced as a runtime warning. Newer
  // Claude SDKs stream high-frequency telemetry (e.g. `thinking_tokens`); de-duping
  // here keeps a single unknown kind from flooding the conversation timeline.
  readonly warnedUnhandledSdkKinds: Set<string>;
  // Task ids flagged skip_transcript by the SDK (ambient/housekeeping tasks).
  // All task lifecycle events for these ids stay off the conversation timeline.
  readonly hiddenTaskIds: Set<string>;
  // Tasks announced via task_started, keyed by the spawning tool_use id. Lets
  // subagent output that arrives after the Task tool_result already resolved
  // (backgrounded subagents) surface as task progress instead of being dropped.
  // turnId is the turn that spawned the task: late background events must carry
  // a turn id or the web work-log filter hides them. Entries are removed when
  // the task reaches a terminal state.
  readonly knownTasksByToolUseId: Map<
    string,
    {
      readonly taskId: string;
      readonly description: string;
      readonly subagentType?: string;
      readonly turnId?: TurnId;
    }
  >;
}

interface ClaudeQueryRuntime extends AsyncIterable<SDKMessage> {
  readonly interrupt: () => Promise<void>;
  readonly setModel: (model?: string) => Promise<void>;
  readonly setPermissionMode: (mode: PermissionMode) => Promise<void>;
  readonly setMaxThinkingTokens: (maxThinkingTokens: number | null) => Promise<void>;
  readonly supportedCommands: () => Promise<SlashCommand[]>;
  readonly supportedModels: () => Promise<ModelInfo[]>;
  readonly supportedAgents: () => Promise<AgentInfo[]>;
  readonly close: () => void;
}

export interface ClaudeAdapterLiveOptions {
  readonly createQuery?: (input: {
    readonly prompt: AsyncIterable<SDKUserMessage>;
    readonly options: ClaudeQueryOptions;
  }) => ClaudeQueryRuntime;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
}

function mapSupportedCommands(commands: SlashCommand[]): ProviderListCommandsResult {
  return {
    commands: commands.map((cmd) => ({
      name: cmd.name,
      description: cmd.description || undefined,
    })),
    source: "claudeAgent",
    cached: false,
  };
}

function neverResolvingUserMessageStream(): AsyncIterable<SDKUserMessage> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
      return {
        next: async () => new Promise<IteratorResult<SDKUserMessage>>(() => {}),
      };
    },
  };
}

function getEffectiveClaudeCodeEffort(
  effort: ClaudeCodeEffort | null | undefined,
): ClaudeApiEffort | null {
  if (!effort) {
    return null;
  }
  if (effort === "ultrathink") {
    return null;
  }
  return effort === "ultracode" ? "xhigh" : effort;
}

function hasPendingUserInterrupt(context: ClaudeSessionContext): boolean {
  const activeTurnId = context.turnState?.turnId;
  return activeTurnId !== undefined && context.interruptRequestedTurnId === activeTurnId;
}

function asRuntimeItemId(value: string): RuntimeItemId {
  return RuntimeItemId.makeUnsafe(value);
}

function asCanonicalTurnId(value: TurnId): TurnId {
  return value;
}

function asRuntimeRequestId(value: ApprovalRequestId): RuntimeRequestId {
  return RuntimeRequestId.makeUnsafe(value);
}

function toPermissionMode(value: unknown): PermissionMode | undefined {
  switch (value) {
    case "default":
    case "acceptEdits":
    case "bypassPermissions":
    case "plan":
    case "dontAsk":
      return value;
    default:
      return undefined;
  }
}

const SUPPORTED_CLAUDE_IMAGE_MIME_TYPES = new Set([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);
const CLAUDE_SETTING_SOURCES = [
  "user",
  "project",
  "local",
] as const satisfies ReadonlyArray<SettingSource>;
const EMBEDDED_CLAUDE_SYSTEM_PROMPT_APPEND = [
  "You are running inside Synara, a coding app that embeds the Claude Agent SDK.",
  "Do not present the host app as Claude Code unless the user is explicitly asking about Claude Code.",
  "Treat the current working directory as the active workspace for the task.",
  "When the user asks about the current project, codebase, or repository, proactively inspect files in the current working directory before asking the user where to look.",
].join("\n");

function buildClaudeSdkSubagents(): Record<string, AgentDefinition> {
  const agents: Record<string, AgentDefinition> = {};

  for (const alias of getAgentMentionAliases("claudeAgent")) {
    if (alias.kind !== "claude-subagent" || agents[alias.agentName]) {
      continue;
    }

    agents[alias.agentName] = {
      description: alias.description,
      prompt: alias.prompt,
      ...(alias.tools ? { tools: [...alias.tools] } : {}),
      ...(alias.disallowedTools ? { disallowedTools: [...alias.disallowedTools] } : {}),
      ...(alias.model ? { model: alias.model } : {}),
    };
  }

  return agents;
}

function buildPromptText(input: ProviderSendTurnInput): string {
  const basePrompt = buildClaudeSubagentPrompt(input.input?.trim() ?? "").prompt;
  const rawEffort =
    input.modelSelection?.provider === "claudeAgent" ? input.modelSelection.options?.effort : null;
  const requestedEffort = trimOrNull(rawEffort);
  const claudeModel =
    input.modelSelection?.provider === "claudeAgent" ? input.modelSelection.model : undefined;
  const caps = getModelCapabilities("claudeAgent", claudeModel);
  const promptEffort =
    requestedEffort === "ultrathink" && caps.promptInjectedEffortLevels.includes("ultrathink")
      ? "ultrathink"
      : requestedEffort && hasEffortLevel(caps, requestedEffort)
        ? requestedEffort
        : null;
  return withProviderPlanModePrompt({
    text: applyClaudePromptEffortPrefix(basePrompt, promptEffort),
    interactionMode: input.interactionMode,
  });
}

function buildUserMessage(input: {
  readonly sdkContent: Array<Record<string, unknown>>;
}): SDKUserMessage {
  return {
    type: "user",
    session_id: "",
    parent_tool_use_id: null,
    message: {
      role: "user",
      content: input.sdkContent,
    },
  } as unknown as SDKUserMessage;
}

function buildClaudeImageContentBlock(input: {
  readonly mimeType: string;
  readonly bytes: Uint8Array;
}): Record<string, unknown> {
  return {
    type: "image",
    source: {
      type: "base64",
      media_type: input.mimeType,
      data: Buffer.from(input.bytes).toString("base64"),
    },
  };
}

function buildUserMessageEffect(
  input: ProviderSendTurnInput,
  dependencies: {
    readonly fileSystem: FileSystem.FileSystem;
    readonly attachmentsDir: string;
  },
): Effect.Effect<SDKUserMessage, ProviderAdapterRequestError> {
  return Effect.gen(function* () {
    const text = buildPromptText(input);
    const sdkContent: Array<Record<string, unknown>> = [];

    if (text.length > 0) {
      sdkContent.push({ type: "text", text });
    }

    for (const attachment of input.attachments ?? []) {
      if (attachment.type !== "image") {
        continue;
      }

      if (!SUPPORTED_CLAUDE_IMAGE_MIME_TYPES.has(attachment.mimeType)) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "turn/start",
          detail: `Unsupported Claude image attachment type '${attachment.mimeType}'.`,
        });
      }

      const attachmentPath = resolveAttachmentPath({
        attachmentsDir: dependencies.attachmentsDir,
        attachment,
      });
      if (!attachmentPath) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "turn/start",
          detail: `Invalid attachment id '${attachment.id}'.`,
        });
      }

      const bytes = yield* dependencies.fileSystem.readFile(attachmentPath).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "turn/start",
              detail: toMessage(cause, "Failed to read attachment file."),
              cause,
            }),
        ),
      );

      sdkContent.push(
        buildClaudeImageContentBlock({
          mimeType: attachment.mimeType,
          bytes,
        }),
      );
    }

    const fileBlock = buildFileAttachmentsPromptBlock({
      attachments: input.attachments,
      attachmentsDir: dependencies.attachmentsDir,
      include: "all-files",
    });
    if (fileBlock) {
      sdkContent.push({ type: "text", text: fileBlock });
    }

    return buildUserMessage({ sdkContent });
  });
}

function nativeProviderRefs(
  _context: ClaudeSessionContext,
  options?: {
    readonly providerItemId?: string | undefined;
  },
): NonNullable<ProviderRuntimeEvent["providerRefs"]> {
  if (options?.providerItemId) {
    return {
      providerItemId: ProviderItemId.makeUnsafe(options.providerItemId),
    };
  }
  return {};
}

function toSessionError(
  threadId: ThreadId,
  cause: unknown,
): ProviderAdapterSessionNotFoundError | ProviderAdapterSessionClosedError | undefined {
  const normalized = toMessage(cause, "").toLowerCase();
  if (normalized.includes("unknown session") || normalized.includes("not found")) {
    return new ProviderAdapterSessionNotFoundError({
      provider: PROVIDER,
      threadId,
      cause,
    });
  }
  if (normalized.includes("closed")) {
    return new ProviderAdapterSessionClosedError({
      provider: PROVIDER,
      threadId,
      cause,
    });
  }
  return undefined;
}

function toRequestError(threadId: ThreadId, method: string, cause: unknown): ProviderAdapterError {
  const sessionError = toSessionError(threadId, cause);
  if (sessionError) {
    return sessionError;
  }
  return new ProviderAdapterRequestError({
    provider: PROVIDER,
    method,
    detail: toMessage(cause, `${method} failed`),
    cause,
  });
}

function makeClaudeAdapter(options?: ClaudeAdapterLiveOptions) {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const serverConfig = yield* ServerConfig;
    const nativeEventLogger =
      options?.nativeEventLogger ??
      (options?.nativeEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, {
            stream: "native",
          })
        : undefined);

    const createQuery =
      options?.createQuery ??
      ((input: {
        readonly prompt: AsyncIterable<SDKUserMessage>;
        readonly options: ClaudeQueryOptions;
      }) => query({ prompt: input.prompt, options: input.options }) as ClaudeQueryRuntime);

    const sessions = new Map<ThreadId, ClaudeSessionContext>();
    let cachedModels: ProviderListModelsResult | null = null;
    let cachedAgents: ProviderListAgentsResult | null = null;
    const runtimeEventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();

    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const nextEventId = Effect.map(Random.nextUUIDv4, (id) => EventId.makeUnsafe(id));
    const makeEventStamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso });
    const resolveClaudeSdkEnv = Effect.sync(() =>
      buildClaudeProcessEnv({ env: process.env, homeDir: serverConfig.homeDir }),
    );

    const offerRuntimeEvent = (event: ProviderRuntimeEvent): Effect.Effect<void> =>
      Queue.offer(runtimeEventQueue, event).pipe(Effect.asVoid);

    const logNativeSdkMessage = (
      context: ClaudeSessionContext,
      message: SDKMessage,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (!nativeEventLogger) {
          return;
        }

        const observedAt = new Date().toISOString();
        const itemId = sdkNativeItemId(message);

        yield* nativeEventLogger.write(
          {
            observedAt,
            event: {
              id:
                "uuid" in message && typeof message.uuid === "string"
                  ? message.uuid
                  : crypto.randomUUID(),
              kind: "notification",
              provider: PROVIDER,
              createdAt: observedAt,
              method: sdkNativeMethod(message),
              ...(typeof message.session_id === "string"
                ? { providerThreadId: message.session_id }
                : {}),
              ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
              ...(itemId ? { itemId: ProviderItemId.makeUnsafe(itemId) } : {}),
              payload: message,
            },
          },
          context.session.threadId,
        );
      });

    const snapshotThread = (
      context: ClaudeSessionContext,
    ): Effect.Effect<
      {
        threadId: ThreadId;
        turns: ReadonlyArray<{
          id: TurnId;
          items: ReadonlyArray<unknown>;
        }>;
      },
      ProviderAdapterValidationError
    > =>
      Effect.gen(function* () {
        const threadId = context.session.threadId;
        if (!threadId) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "readThread",
            issue: "Session thread id is not initialized yet.",
          });
        }
        return {
          threadId,
          turns: context.turns.map((turn) => ({
            id: turn.id,
            items: [...turn.items],
          })),
        };
      });

    const updateResumeCursor = (context: ClaudeSessionContext): Effect.Effect<void> =>
      Effect.gen(function* () {
        const threadId = context.session.threadId;
        if (!threadId) return;

        const resumeCursor = {
          threadId,
          ...(context.resumeSessionId ? { resume: context.resumeSessionId } : {}),
          ...(context.lastAssistantUuid ? { resumeSessionAt: context.lastAssistantUuid } : {}),
          turnCount: context.turns.length,
        };

        context.session = {
          ...context.session,
          resumeCursor,
          updatedAt: yield* nowIso,
        };
      });

    const ensureAssistantTextBlock = (
      context: ClaudeSessionContext,
      blockIndex: number,
      options?: {
        readonly fallbackText?: string;
        readonly streamClosed?: boolean;
      },
    ): Effect.Effect<
      | {
          readonly blockIndex: number;
          readonly block: AssistantTextBlockState;
        }
      | undefined
    > =>
      Effect.gen(function* () {
        const turnState = context.turnState;
        if (!turnState) {
          return undefined;
        }

        const existing = turnState.assistantTextBlocks.get(blockIndex);
        if (existing && !existing.completionEmitted) {
          if (existing.fallbackText.length === 0 && options?.fallbackText) {
            existing.fallbackText = options.fallbackText;
          }
          if (options?.streamClosed) {
            existing.streamClosed = true;
          }
          return { blockIndex, block: existing };
        }

        const block: AssistantTextBlockState = {
          itemId: yield* Random.nextUUIDv4,
          blockIndex,
          emittedTextDelta: false,
          fallbackText: options?.fallbackText ?? "",
          streamClosed: options?.streamClosed ?? false,
          completionEmitted: false,
        };
        turnState.assistantTextBlocks.set(blockIndex, block);
        turnState.assistantTextBlockOrder.push(block);
        return { blockIndex, block };
      });

    const createSyntheticAssistantTextBlock = (
      context: ClaudeSessionContext,
      fallbackText: string,
    ): Effect.Effect<
      | {
          readonly blockIndex: number;
          readonly block: AssistantTextBlockState;
        }
      | undefined
    > =>
      Effect.gen(function* () {
        const turnState = context.turnState;
        if (!turnState) {
          return undefined;
        }

        const blockIndex = turnState.nextSyntheticAssistantBlockIndex;
        turnState.nextSyntheticAssistantBlockIndex -= 1;
        return yield* ensureAssistantTextBlock(context, blockIndex, {
          fallbackText,
          streamClosed: true,
        });
      });

    const completeAssistantTextBlock = (
      context: ClaudeSessionContext,
      block: AssistantTextBlockState,
      options?: {
        readonly force?: boolean;
        readonly rawMethod?: string;
        readonly rawPayload?: unknown;
      },
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const turnState = context.turnState;
        if (!turnState || block.completionEmitted) {
          return;
        }

        if (!options?.force && !block.streamClosed) {
          return;
        }

        if (!block.emittedTextDelta && block.fallbackText.length > 0) {
          const deltaStamp = yield* makeEventStamp();
          yield* offerRuntimeEvent({
            type: "content.delta",
            eventId: deltaStamp.eventId,
            provider: PROVIDER,
            createdAt: deltaStamp.createdAt,
            threadId: context.session.threadId,
            turnId: turnState.turnId,
            itemId: asRuntimeItemId(block.itemId),
            payload: {
              streamKind: "assistant_text",
              delta: block.fallbackText,
            },
            providerRefs: nativeProviderRefs(context),
            ...(options?.rawMethod || options?.rawPayload
              ? {
                  raw: {
                    source: "claude.sdk.message" as const,
                    ...(options.rawMethod ? { method: options.rawMethod } : {}),
                    payload: options?.rawPayload,
                  },
                }
              : {}),
          });
        }

        block.completionEmitted = true;
        if (turnState.assistantTextBlocks.get(block.blockIndex) === block) {
          turnState.assistantTextBlocks.delete(block.blockIndex);
        }

        const stamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "item.completed",
          eventId: stamp.eventId,
          provider: PROVIDER,
          createdAt: stamp.createdAt,
          itemId: asRuntimeItemId(block.itemId),
          threadId: context.session.threadId,
          turnId: turnState.turnId,
          payload: {
            itemType: "assistant_message",
            status: "completed",
            title: "Assistant message",
            ...(block.fallbackText.length > 0 ? { detail: block.fallbackText } : {}),
          },
          providerRefs: nativeProviderRefs(context),
          ...(options?.rawMethod || options?.rawPayload
            ? {
                raw: {
                  source: "claude.sdk.message" as const,
                  ...(options.rawMethod ? { method: options.rawMethod } : {}),
                  payload: options?.rawPayload,
                },
              }
            : {}),
        });
      });

    const backfillAssistantTextBlocksFromSnapshot = (
      context: ClaudeSessionContext,
      message: SDKMessage,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const turnState = context.turnState;
        if (!turnState) {
          return;
        }

        const snapshotTextBlocks = extractAssistantTextBlocks(message);
        if (snapshotTextBlocks.length === 0) {
          return;
        }

        const orderedBlocks = turnState.assistantTextBlockOrder.map((block) => ({
          blockIndex: block.blockIndex,
          block,
        }));

        for (const [position, text] of snapshotTextBlocks.entries()) {
          const existingEntry = orderedBlocks[position];
          const entry =
            existingEntry ??
            (yield* createSyntheticAssistantTextBlock(context, text).pipe(
              Effect.map((created) => {
                if (!created) {
                  return undefined;
                }
                orderedBlocks.push(created);
                return created;
              }),
            ));
          if (!entry) {
            continue;
          }

          if (entry.block.fallbackText.length === 0) {
            entry.block.fallbackText = text;
          }

          if (entry.block.streamClosed && !entry.block.completionEmitted) {
            yield* completeAssistantTextBlock(context, entry.block, {
              rawMethod: "claude/assistant",
              rawPayload: message,
            });
          }
        }
      });

    const ensureThreadId = (
      context: ClaudeSessionContext,
      message: SDKMessage,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (typeof message.session_id !== "string" || message.session_id.length === 0) {
          return;
        }
        if (!hasDurableClaudeSessionId(message)) {
          return;
        }
        const nextThreadId = message.session_id;
        context.resumeSessionId = message.session_id;
        yield* updateResumeCursor(context);

        if (context.lastThreadStartedId !== nextThreadId) {
          context.lastThreadStartedId = nextThreadId;
          const stamp = yield* makeEventStamp();
          yield* offerRuntimeEvent({
            type: "thread.started",
            eventId: stamp.eventId,
            provider: PROVIDER,
            createdAt: stamp.createdAt,
            threadId: context.session.threadId,
            payload: {
              providerThreadId: nextThreadId,
            },
            providerRefs: {},
            raw: {
              source: "claude.sdk.message",
              method: "claude/thread/started",
              payload: {
                session_id: message.session_id,
              },
            },
          });
        }
      });

    const emitRuntimeError = (
      context: ClaudeSessionContext,
      message: string,
      cause?: unknown,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (cause !== undefined) {
          void cause;
        }
        const turnState = context.turnState;
        const stamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "runtime.error",
          eventId: stamp.eventId,
          provider: PROVIDER,
          createdAt: stamp.createdAt,
          threadId: context.session.threadId,
          ...(turnState ? { turnId: asCanonicalTurnId(turnState.turnId) } : {}),
          payload: {
            message,
            class: "provider_error",
            ...(cause !== undefined ? { detail: cause } : {}),
          },
          providerRefs: nativeProviderRefs(context),
        });
      });

    const emitRuntimeWarning = (
      context: ClaudeSessionContext,
      message: string,
      detail?: unknown,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const turnState = context.turnState;
        const stamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "runtime.warning",
          eventId: stamp.eventId,
          provider: PROVIDER,
          createdAt: stamp.createdAt,
          threadId: context.session.threadId,
          ...(turnState ? { turnId: asCanonicalTurnId(turnState.turnId) } : {}),
          payload: {
            message,
            ...(detail !== undefined ? { detail } : {}),
          },
          providerRefs: nativeProviderRefs(context),
        });
      });

    // Surfaces each distinct unrecognized SDK message kind at most once per session.
    // Without this, high-frequency telemetry the adapter doesn't model (notably the
    // `thinking_tokens` system subtype streamed on every reasoning tick) turns into a
    // "Runtime warning" timeline entry per message and floods the conversation.
    const warnUnhandledSdkKind = (
      context: ClaudeSessionContext,
      kind: string,
      message: string,
      detail: unknown,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (context.warnedUnhandledSdkKinds.has(kind)) {
          return;
        }
        context.warnedUnhandledSdkKinds.add(kind);
        yield* emitRuntimeWarning(context, message, detail);
      });

    const emitProposedPlanCompleted = (
      context: ClaudeSessionContext,
      input: {
        readonly planMarkdown: string;
        readonly toolUseId?: string | undefined;
        readonly rawSource: "claude.sdk.message" | "claude.sdk.permission";
        readonly rawMethod: string;
        readonly rawPayload: unknown;
      },
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const turnState = context.turnState;
        const planMarkdown = input.planMarkdown.trim();
        if (!turnState || planMarkdown.length === 0) {
          return;
        }

        const captureKey = exitPlanCaptureKey({
          toolUseId: input.toolUseId,
          planMarkdown,
        });
        if (turnState.capturedProposedPlanKeys.has(captureKey)) {
          return;
        }
        turnState.capturedProposedPlanKeys.add(captureKey);

        const stamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "turn.proposed.completed",
          eventId: stamp.eventId,
          provider: PROVIDER,
          createdAt: stamp.createdAt,
          threadId: context.session.threadId,
          turnId: turnState.turnId,
          payload: {
            planMarkdown,
          },
          providerRefs: nativeProviderRefs(context, {
            providerItemId: input.toolUseId,
          }),
          raw: {
            source: input.rawSource,
            method: input.rawMethod,
            payload: input.rawPayload,
          },
        });
      });

    // Normalizes Claude TodoWrite tool calls into the shared runtime task-list event.
    const emitTodoTasksUpdated = (
      context: ClaudeSessionContext,
      input: {
        readonly toolInput: Record<string, unknown>;
        readonly toolUseId?: string | undefined;
        readonly rawMethod: string;
        readonly rawPayload: unknown;
      },
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const turnState = context.turnState;
        if (!turnState) {
          return;
        }

        const tasksPayload = normalizeClaudeTodoTasks(input.toolInput);
        if (!tasksPayload) {
          return;
        }

        const stamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "turn.tasks.updated",
          eventId: stamp.eventId,
          provider: PROVIDER,
          createdAt: stamp.createdAt,
          threadId: context.session.threadId,
          turnId: turnState.turnId,
          payload: tasksPayload,
          providerRefs: nativeProviderRefs(context, {
            providerItemId: input.toolUseId,
          }),
          raw: {
            source: "claude.sdk.message",
            method: input.rawMethod,
            payload: input.rawPayload,
          },
        });
      });

    // Background continuations (task notifications, held-back results) start
    // producing stream events without a user-initiated turn. Open a synthetic
    // turn on the first activity so the continuation streams into the timeline
    // instead of being dropped until the buffered assistant message lands.
    const ensureActiveTurn = (
      context: ClaudeSessionContext,
      rawMethod: string,
    ): Effect.Effect<ClaudeTurnState> =>
      Effect.gen(function* () {
        const existing = context.turnState;
        if (existing) {
          return existing;
        }

        const turnId = TurnId.makeUnsafe(yield* Random.nextUUIDv4);
        const startedAt = yield* nowIso;
        const turnState: ClaudeTurnState = {
          turnId,
          startedAt,
          interactionMode: "default",
          origin: "synthetic",
          items: [],
          assistantTextBlocks: new Map(),
          assistantTextBlockOrder: [],
          capturedProposedPlanKeys: new Set(),
          sawFileChange: false,
          nextSyntheticAssistantBlockIndex: -1,
        };
        context.turnState = turnState;
        context.session = {
          ...context.session,
          status: "running",
          activeTurnId: turnId,
          updatedAt: startedAt,
        };

        const stamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "turn.started",
          eventId: stamp.eventId,
          provider: PROVIDER,
          createdAt: stamp.createdAt,
          threadId: context.session.threadId,
          turnId,
          payload: {},
          providerRefs: {
            ...nativeProviderRefs(context),
            providerTurnId: turnId,
          },
          raw: {
            source: "claude.sdk.message",
            method: rawMethod,
            payload: {},
          },
        });
        return turnState;
      });

    // The SDK result.usage contains *accumulated* totals across all API calls
    // (input_tokens, cache_read_input_tokens, etc. summed over every request).
    // This does NOT represent the current context window size. Instead, use the
    // last known context-window-accurate usage from task_progress events and
    // treat the accumulated total as totalProcessedTokens.
    const captureResultTokenUsage = (
      context: ClaudeSessionContext,
      result: SDKResultMessage | undefined,
    ): Effect.Effect<ThreadTokenUsageSnapshot | undefined> =>
      Effect.sync(() => {
        const resultContextWindow = maxClaudeContextWindowFromModelUsage(result?.modelUsage);
        const effectiveContextWindow = resolveEffectiveClaudeContextWindow({
          reportedContextWindow: resultContextWindow,
          lastKnownContextWindow: context.lastKnownContextWindow,
          currentApiModelId: context.currentApiModelId,
        });
        if (effectiveContextWindow !== undefined) {
          context.lastKnownContextWindow = effectiveContextWindow;
        }

        const accumulatedSnapshot = normalizeClaudeTokenUsage(
          result?.usage,
          effectiveContextWindow,
        );
        const lastGoodUsage = context.lastKnownTokenUsage;
        return lastGoodUsage
          ? mergeClaudeTokenUsageSnapshot(
              lastGoodUsage,
              accumulatedSnapshot,
              effectiveContextWindow,
            )
          : accumulatedSnapshot;
      });

    const emitThreadTokenUsage = (
      context: ClaudeSessionContext,
      usageSnapshot: ThreadTokenUsageSnapshot,
      turnId?: TurnId,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const usageStamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "thread.token-usage.updated",
          eventId: usageStamp.eventId,
          provider: PROVIDER,
          createdAt: usageStamp.createdAt,
          threadId: context.session.threadId,
          ...(turnId !== undefined ? { turnId: asCanonicalTurnId(turnId) } : {}),
          payload: {
            usage: usageSnapshot,
          },
          providerRefs: turnId !== undefined ? nativeProviderRefs(context) : {},
        });
      });

    const completeTurn = (
      context: ClaudeSessionContext,
      status: ProviderRuntimeTurnStatus,
      errorMessage?: string,
      result?: SDKResultMessage,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const usageSnapshot = yield* captureResultTokenUsage(context, result);

        const turnState = context.turnState;
        if (!turnState) {
          // No turn is open — the work this result belongs to was already
          // completed (idle signal or an earlier result). Keep the usage but
          // do not emit a turn.completed for a turn that no longer exists.
          if (usageSnapshot) {
            yield* emitThreadTokenUsage(context, usageSnapshot);
          }
          return;
        }

        for (const tool of context.toolsAwaitingResult.values()) {
          const toolStamp = yield* makeEventStamp();
          yield* offerRuntimeEvent({
            type: "item.completed",
            eventId: toolStamp.eventId,
            provider: PROVIDER,
            createdAt: toolStamp.createdAt,
            threadId: context.session.threadId,
            turnId: turnState.turnId,
            itemId: asRuntimeItemId(tool.itemId),
            payload: {
              itemType: tool.itemType,
              status: status === "completed" ? "completed" : "failed",
              title: tool.title,
              ...(tool.detail ? { detail: tool.detail } : {}),
              data: toolLifecycleEventData(tool),
            },
            providerRefs: nativeProviderRefs(context, { providerItemId: tool.itemId }),
            raw: {
              source: "claude.sdk.message",
              method: "claude/result",
              payload: result ?? { status },
            },
          });
          if (tool.itemType === "file_change") {
            context.turnState = {
              ...turnState,
              sawFileChange: true,
            };
          }
        }
        context.toolsAwaitingResult.clear();
        context.streamingToolsByIndex.clear();

        for (const block of turnState.assistantTextBlockOrder) {
          yield* completeAssistantTextBlock(context, block, {
            force: true,
            rawMethod: "claude/result",
            rawPayload: result ?? { status },
          });
        }

        context.turns.push({
          id: turnState.turnId,
          items: [...turnState.items],
        });

        if (usageSnapshot) {
          yield* emitThreadTokenUsage(context, usageSnapshot, turnState.turnId);
        }

        // Feed Claude edits into the same placeholder checkpoint flow used by Codex.
        if (status === "completed" && turnState.sawFileChange) {
          const diffStamp = yield* makeEventStamp();
          yield* offerRuntimeEvent({
            type: "turn.diff.updated",
            eventId: diffStamp.eventId,
            provider: PROVIDER,
            createdAt: diffStamp.createdAt,
            threadId: context.session.threadId,
            turnId: turnState.turnId,
            payload: {
              unifiedDiff: "",
            },
            providerRefs: nativeProviderRefs(context),
            raw: {
              source: "claude.sdk.message",
              method: "claude/result",
              payload: result ?? { status },
            },
          });
        }

        const stamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "turn.completed",
          eventId: stamp.eventId,
          provider: PROVIDER,
          createdAt: stamp.createdAt,
          threadId: context.session.threadId,
          turnId: turnState.turnId,
          payload: {
            state: status,
            ...(result?.stop_reason !== undefined ? { stopReason: result.stop_reason } : {}),
            ...(result?.usage ? { usage: result.usage } : {}),
            ...(result?.modelUsage ? { modelUsage: result.modelUsage } : {}),
            ...(typeof result?.total_cost_usd === "number"
              ? { totalCostUsd: result.total_cost_usd }
              : {}),
            ...(errorMessage ? { errorMessage } : {}),
          },
          providerRefs: nativeProviderRefs(context),
        });

        const updatedAt = yield* nowIso;
        if (context.interruptRequestedTurnId === turnState.turnId) {
          context.interruptRequestedTurnId = undefined;
        }
        context.lastInteractionMode = turnState.interactionMode;
        context.turnState = undefined;
        context.session = {
          ...context.session,
          status: "ready",
          activeTurnId: undefined,
          updatedAt,
          ...(status === "failed" && errorMessage ? { lastError: errorMessage } : {}),
        };
        yield* updateResumeCursor(context);
      });

    const handleStreamEvent = (
      context: ClaudeSessionContext,
      message: SDKMessage,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (message.type !== "stream_event") {
          return;
        }

        const { event } = message;

        // Background continuations stream without a user turn; open a synthetic
        // one as soon as real content arrives so deltas and tool items are not
        // dropped or orphaned. content_block_stop alone never opens a turn.
        if (event.type === "content_block_start" || event.type === "content_block_delta") {
          yield* ensureActiveTurn(context, "claude/stream_event/synthetic-turn-start");
        }

        // Content-block indices restart at 0 for every streamed message. Rotate
        // the per-message state so blocks of the next message cannot collide
        // with blocks of the previous one: force-close any text block the prior
        // message left open and drop its index-keyed tool entries (tools still
        // awaiting results remain tracked by id in toolsAwaitingResult).
        if (event.type === "message_start") {
          if (context.turnState) {
            for (const block of context.turnState.assistantTextBlocks.values()) {
              block.streamClosed = true;
              yield* completeAssistantTextBlock(context, block, {
                rawMethod: "claude/stream_event/message_start",
                rawPayload: message,
              });
            }
          }
          context.streamingToolsByIndex.clear();
          return;
        }

        if (event.type === "content_block_delta") {
          if (
            (event.delta.type === "text_delta" || event.delta.type === "thinking_delta") &&
            context.turnState
          ) {
            const deltaText =
              event.delta.type === "text_delta"
                ? event.delta.text
                : typeof event.delta.thinking === "string"
                  ? event.delta.thinking
                  : "";
            if (deltaText.length === 0) {
              return;
            }
            const streamKind = streamKindFromDeltaType(event.delta.type);
            const assistantBlockEntry =
              event.delta.type === "text_delta"
                ? yield* ensureAssistantTextBlock(context, event.index)
                : context.turnState.assistantTextBlocks.get(event.index)
                  ? {
                      blockIndex: event.index,
                      block: context.turnState.assistantTextBlocks.get(
                        event.index,
                      ) as AssistantTextBlockState,
                    }
                  : undefined;
            if (assistantBlockEntry?.block && event.delta.type === "text_delta") {
              assistantBlockEntry.block.emittedTextDelta = true;
            }
            const stamp = yield* makeEventStamp();
            yield* offerRuntimeEvent({
              type: "content.delta",
              eventId: stamp.eventId,
              provider: PROVIDER,
              createdAt: stamp.createdAt,
              threadId: context.session.threadId,
              turnId: context.turnState.turnId,
              ...(assistantBlockEntry?.block
                ? { itemId: asRuntimeItemId(assistantBlockEntry.block.itemId) }
                : {}),
              payload: {
                streamKind,
                delta: deltaText,
              },
              providerRefs: nativeProviderRefs(context),
              raw: {
                source: "claude.sdk.message",
                method: "claude/stream_event/content_block_delta",
                payload: message,
              },
            });
            return;
          }

          if (event.delta.type === "input_json_delta") {
            const tool = context.streamingToolsByIndex.get(event.index);
            if (!tool || typeof event.delta.partial_json !== "string") {
              return;
            }

            const partialInputJson = tool.partialInputJson + event.delta.partial_json;
            const parsedInput = tryParseJsonRecord(partialInputJson);
            const detail = parsedInput
              ? summarizeToolRequest(tool.toolName, parsedInput)
              : tool.detail;
            let nextTool: ToolInFlight = {
              ...tool,
              partialInputJson,
              ...(parsedInput ? { input: parsedInput } : {}),
              ...(detail ? { detail } : {}),
            };

            const nextFingerprint =
              parsedInput && Object.keys(parsedInput).length > 0
                ? toolInputFingerprint(parsedInput)
                : undefined;
            const trackStreamingTool = (updated: ToolInFlight) => {
              context.streamingToolsByIndex.set(event.index, updated);
              context.toolsAwaitingResult.set(updated.itemId, updated);
            };
            trackStreamingTool(nextTool);

            if (
              !parsedInput ||
              !nextFingerprint ||
              tool.lastEmittedInputFingerprint === nextFingerprint
            ) {
              return;
            }

            nextTool = {
              ...nextTool,
              lastEmittedInputFingerprint: nextFingerprint,
            };
            trackStreamingTool(nextTool);

            const stamp = yield* makeEventStamp();
            yield* offerRuntimeEvent({
              type: "item.updated",
              eventId: stamp.eventId,
              provider: PROVIDER,
              createdAt: stamp.createdAt,
              threadId: context.session.threadId,
              ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
              itemId: asRuntimeItemId(nextTool.itemId),
              payload: {
                itemType: nextTool.itemType,
                status: "inProgress",
                title: nextTool.title,
                ...(nextTool.detail ? { detail: nextTool.detail } : {}),
                data: toolLifecycleEventData(nextTool),
              },
              providerRefs: nativeProviderRefs(context, { providerItemId: nextTool.itemId }),
              raw: {
                source: "claude.sdk.message",
                method: "claude/stream_event/content_block_delta/input_json_delta",
                payload: message,
              },
            });
            if (nextTool.toolName === "TodoWrite") {
              yield* emitTodoTasksUpdated(context, {
                toolInput: nextTool.input,
                toolUseId: nextTool.itemId,
                rawMethod: "claude/stream_event/content_block_delta/input_json_delta",
                rawPayload: message,
              });
            }
          }
          return;
        }

        if (event.type === "content_block_start") {
          const { index, content_block: block } = event;
          if (block.type === "text") {
            yield* ensureAssistantTextBlock(context, index, {
              fallbackText: extractContentBlockText(block),
            });
            return;
          }
          if (
            block.type !== "tool_use" &&
            block.type !== "server_tool_use" &&
            block.type !== "mcp_tool_use"
          ) {
            return;
          }
          const toolName = block.name;
          // AskUserQuestion / ExitPlanMode are rendered by their own runtime channels;
          // emitting a generic tool item here would duplicate them as a raw row.
          if (isClientSurfacedClaudeTool(toolName)) {
            return;
          }
          const itemType = classifyToolItemType(toolName);
          const toolInput =
            typeof block.input === "object" && block.input !== null
              ? (block.input as Record<string, unknown>)
              : {};
          const itemId = block.id;
          const detail = summarizeToolRequest(toolName, toolInput);
          const inputFingerprint =
            Object.keys(toolInput).length > 0 ? toolInputFingerprint(toolInput) : undefined;

          const tool: ToolInFlight = {
            itemId,
            itemType,
            toolName,
            title: titleForTool(itemType),
            detail,
            input: toolInput,
            partialInputJson: "",
            ...(inputFingerprint ? { lastEmittedInputFingerprint: inputFingerprint } : {}),
          };
          context.streamingToolsByIndex.set(index, tool);
          context.toolsAwaitingResult.set(tool.itemId, tool);

          const stamp = yield* makeEventStamp();
          yield* offerRuntimeEvent({
            type: "item.started",
            eventId: stamp.eventId,
            provider: PROVIDER,
            createdAt: stamp.createdAt,
            threadId: context.session.threadId,
            ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
            itemId: asRuntimeItemId(tool.itemId),
            payload: {
              itemType: tool.itemType,
              status: "inProgress",
              title: tool.title,
              ...(tool.detail ? { detail: tool.detail } : {}),
              data: toolLifecycleEventData(tool),
            },
            providerRefs: nativeProviderRefs(context, { providerItemId: tool.itemId }),
            raw: {
              source: "claude.sdk.message",
              method: "claude/stream_event/content_block_start",
              payload: message,
            },
          });
          if (toolName === "TodoWrite") {
            yield* emitTodoTasksUpdated(context, {
              toolInput,
              toolUseId: tool.itemId,
              rawMethod: "claude/stream_event/content_block_start",
              rawPayload: message,
            });
          }
          return;
        }

        if (event.type === "content_block_stop") {
          const assistantBlock = context.turnState?.assistantTextBlocks.get(event.index);
          if (assistantBlock) {
            assistantBlock.streamClosed = true;
            yield* completeAssistantTextBlock(context, assistantBlock, {
              rawMethod: "claude/stream_event/content_block_stop",
              rawPayload: message,
            });
          }
          // Tool blocks stay tracked past their stop event — completion is
          // driven by the matching tool_result (or turn end), not by the block
          // finishing its input stream.
        }
      });

    const handleUserMessage = (
      context: ClaudeSessionContext,
      message: SDKMessage,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (message.type !== "user") {
          return;
        }

        if (context.turnState) {
          context.turnState.items.push(message.message);
        }

        for (const toolResult of toolResultBlocksFromUserMessage(message)) {
          const tool = context.toolsAwaitingResult.get(toolResult.toolUseId);
          if (!tool) {
            continue;
          }

          const itemStatus = toolResult.isError ? "failed" : "completed";
          const toolData = toolLifecycleEventData(tool, { result: toolResult.block });

          const updatedStamp = yield* makeEventStamp();
          yield* offerRuntimeEvent({
            type: "item.updated",
            eventId: updatedStamp.eventId,
            provider: PROVIDER,
            createdAt: updatedStamp.createdAt,
            threadId: context.session.threadId,
            ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
            itemId: asRuntimeItemId(tool.itemId),
            payload: {
              itemType: tool.itemType,
              status: toolResult.isError ? "failed" : "inProgress",
              title: tool.title,
              ...(tool.detail ? { detail: tool.detail } : {}),
              data: toolData,
            },
            providerRefs: nativeProviderRefs(context, { providerItemId: tool.itemId }),
            raw: {
              source: "claude.sdk.message",
              method: "claude/user",
              payload: message,
            },
          });

          const streamKind = toolResultStreamKind(tool.itemType);
          if (streamKind && toolResult.text.length > 0 && context.turnState) {
            const deltaStamp = yield* makeEventStamp();
            yield* offerRuntimeEvent({
              type: "content.delta",
              eventId: deltaStamp.eventId,
              provider: PROVIDER,
              createdAt: deltaStamp.createdAt,
              threadId: context.session.threadId,
              turnId: context.turnState.turnId,
              itemId: asRuntimeItemId(tool.itemId),
              payload: {
                streamKind,
                delta: toolResult.text,
              },
              providerRefs: nativeProviderRefs(context, { providerItemId: tool.itemId }),
              raw: {
                source: "claude.sdk.message",
                method: "claude/user",
                payload: message,
              },
            });
          }

          const completedStamp = yield* makeEventStamp();
          yield* offerRuntimeEvent({
            type: "item.completed",
            eventId: completedStamp.eventId,
            provider: PROVIDER,
            createdAt: completedStamp.createdAt,
            threadId: context.session.threadId,
            ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
            itemId: asRuntimeItemId(tool.itemId),
            payload: {
              itemType: tool.itemType,
              status: itemStatus,
              title: tool.title,
              ...(tool.detail ? { detail: tool.detail } : {}),
              data: toolData,
            },
            providerRefs: nativeProviderRefs(context, { providerItemId: tool.itemId }),
            raw: {
              source: "claude.sdk.message",
              method: "claude/user",
              payload: message,
            },
          });

          if (tool.itemType === "file_change" && context.turnState) {
            context.turnState = {
              ...context.turnState,
              sawFileChange: true,
            };
          }
          context.toolsAwaitingResult.delete(toolResult.toolUseId);
          for (const [index, streamingTool] of context.streamingToolsByIndex) {
            if (streamingTool.itemId === toolResult.toolUseId) {
              context.streamingToolsByIndex.delete(index);
              break;
            }
          }
        }
      });

    const handleAssistantMessage = (
      context: ClaudeSessionContext,
      message: SDKMessage,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (message.type !== "assistant") {
          return;
        }

        // Auto-start a synthetic turn for assistant messages that arrive without
        // an active turn (e.g., background task continuations between user prompts).
        yield* ensureActiveTurn(context, "claude/synthetic-turn-start");
        const content = message.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (!block || typeof block !== "object") {
              continue;
            }
            const toolUse = block as {
              type?: unknown;
              id?: unknown;
              name?: unknown;
              input?: unknown;
            };
            if (toolUse.type !== "tool_use" || toolUse.name !== "ExitPlanMode") {
              continue;
            }
            const planMarkdown = extractExitPlanModePlan(toolUse.input);
            if (!planMarkdown) {
              continue;
            }
            yield* emitProposedPlanCompleted(context, {
              planMarkdown,
              toolUseId: typeof toolUse.id === "string" ? toolUse.id : undefined,
              rawSource: "claude.sdk.message",
              rawMethod: "claude/assistant",
              rawPayload: message,
            });
          }

          const taggedPlanMarkdown =
            context.turnState?.interactionMode === "plan"
              ? extractProposedPlanMarkdown(extractTextContent(content))
              : undefined;
          if (taggedPlanMarkdown) {
            yield* emitProposedPlanCompleted(context, {
              planMarkdown: taggedPlanMarkdown,
              rawSource: "claude.sdk.message",
              rawMethod: "claude/assistant/proposed-plan-block",
              rawPayload: message,
            });
          }
        }

        if (context.turnState) {
          context.turnState.items.push(message.message);
          yield* backfillAssistantTextBlocksFromSnapshot(context, message);
        }

        // Capture per-API-call usage from the assistant response for accurate
        // context window tracking. Unlike task_progress (accumulated per-task),
        // this reflects the actual prompt + output size for this single API call.
        const perCallUsage = (message.message as { usage?: unknown } | undefined)?.usage;
        if (perCallUsage) {
          const normalizedPerCallUsage = normalizeClaudeTokenUsage(
            perCallUsage as Record<string, unknown>,
            context.lastKnownContextWindow,
          );
          if (normalizedPerCallUsage) {
            context.lastKnownTokenUsage = normalizedPerCallUsage;
            const usageStamp = yield* makeEventStamp();
            yield* offerRuntimeEvent({
              type: "thread.token-usage.updated",
              eventId: usageStamp.eventId,
              provider: PROVIDER,
              createdAt: usageStamp.createdAt,
              threadId: context.session.threadId,
              ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
              payload: { usage: normalizedPerCallUsage },
              providerRefs: nativeProviderRefs(context),
              raw: {
                source: "claude.sdk.message",
                method: "claude/assistant-usage",
                payload: perCallUsage,
              },
            });
          }
        }

        context.lastAssistantUuid = message.uuid;
        yield* updateResumeCursor(context);
      });

    // Subagent assistant text is not part of the main conversation. While the
    // spawning Task tool call is still awaiting its result (foreground
    // subagent), reflect the text as live progress on that tool item. Once the
    // tool_result has resolved the item (backgrounded subagent), the item row
    // is closed — the web refuses to merge into completed rows — so route the
    // text through the task.progress channel instead.
    const handleSubagentAssistantMessage = (
      context: ClaudeSessionContext,
      message: SDKMessage,
      parentToolUseId: string,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (message.type !== "assistant") {
          return;
        }

        const textBlocks = extractAssistantTextBlocks(message);
        const latestText = textBlocks[textBlocks.length - 1]?.trim().slice(0, 2000) ?? "";
        if (latestText.length === 0) {
          return;
        }

        const messageSubagentType = (message as { subagent_type?: unknown }).subagent_type;
        const subagentType =
          typeof messageSubagentType === "string" && messageSubagentType.length > 0
            ? messageSubagentType
            : undefined;

        const toolEntry = context.toolsAwaitingResult.get(parentToolUseId);
        if (toolEntry) {
          const stamp = yield* makeEventStamp();
          yield* offerRuntimeEvent({
            type: "item.updated",
            eventId: stamp.eventId,
            provider: PROVIDER,
            createdAt: stamp.createdAt,
            threadId: context.session.threadId,
            ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
            itemId: asRuntimeItemId(toolEntry.itemId),
            payload: {
              itemType: toolEntry.itemType,
              status: "inProgress",
              title: toolEntry.title,
              ...(toolEntry.detail ? { detail: toolEntry.detail } : {}),
              // `output` is the field the web's collab work-log extraction
              // renders; `subagentText` rides along for richer clients.
              data: toolLifecycleEventData(toolEntry, {
                output: latestText,
                subagentText: latestText,
                ...(subagentType ? { subagentType } : {}),
              }),
            },
            providerRefs: nativeProviderRefs(context, { providerItemId: toolEntry.itemId }),
            raw: {
              source: "claude.sdk.message",
              method: "claude/assistant/subagent",
              payload: message,
            },
          });
          return;
        }

        const taskInfo = context.knownTasksByToolUseId.get(parentToolUseId);
        if (!taskInfo) {
          return;
        }

        // Late background progress belongs to the turn that spawned the task,
        // not whatever turn happens to be open when it arrives — and it must
        // carry a turn id at all, or the web work-log filter hides it. Fall
        // back to the active turn only when the spawning turn is unknown.
        const progressTurnId = taskInfo.turnId ?? context.turnState?.turnId;
        const stamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "task.progress",
          eventId: stamp.eventId,
          provider: PROVIDER,
          createdAt: stamp.createdAt,
          threadId: context.session.threadId,
          ...(progressTurnId ? { turnId: asCanonicalTurnId(progressTurnId) } : {}),
          payload: {
            taskId: RuntimeTaskId.makeUnsafe(taskInfo.taskId),
            description: taskInfo.description,
            summary: latestText,
            toolUseId: parentToolUseId,
            ...((subagentType ?? taskInfo.subagentType)
              ? { subagentType: subagentType ?? taskInfo.subagentType }
              : {}),
          },
          providerRefs: nativeProviderRefs(context, { providerItemId: parentToolUseId }),
          raw: {
            source: "claude.sdk.message",
            method: "claude/assistant/subagent",
            payload: message,
          },
        });
      });

    const handleResultMessage = (
      context: ClaudeSessionContext,
      message: SDKMessage,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (message.type !== "result") {
          return;
        }

        // A turn that was force-closed by a newer sendTurn still owes its SDK
        // result. Swallow it here — completing the freshly started turn with a
        // result that belongs to preempted work would end the new turn before
        // the model even saw its prompt. Usage still counts.
        if (context.staleResultsExpected > 0) {
          context.staleResultsExpected -= 1;
          const usageSnapshot = yield* captureResultTokenUsage(context, message);
          if (usageSnapshot) {
            yield* emitThreadTokenUsage(context, usageSnapshot);
          }
          return;
        }

        const status =
          hasPendingUserInterrupt(context) && message.subtype === "error_during_execution"
            ? "interrupted"
            : turnStatusFromResult(message);
        const errorMessage =
          message.subtype === "success"
            ? undefined
            : normalizeClaudeUserVisibleErrorMessage(message.errors[0], status);

        if (status === "failed") {
          yield* emitRuntimeError(context, errorMessage ?? "Claude turn failed.");
        }

        yield* completeTurn(context, status, errorMessage, message);
      });

    const handleSystemMessage = (
      context: ClaudeSessionContext,
      message: SDKMessage,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (message.type !== "system") {
          return;
        }

        // Benign telemetry we intentionally don't project. `thinking_tokens` streams on
        // every reasoning tick while extended thinking is active; `api_retry` is
        // transient transport chatter; `permission_denied` is already surfaced through
        // the is_error tool_result; `memory_recall` and `elicitation_complete` have no
        // timeline representation. Short-circuit before allocating an event stamp so
        // they can't flood the timeline (or churn allocations) with "Runtime warning"
        // entries.
        if (
          message.subtype === "thinking_tokens" ||
          message.subtype === "api_retry" ||
          message.subtype === "permission_denied" ||
          message.subtype === "memory_recall" ||
          message.subtype === "elicitation_complete"
        ) {
          return;
        }

        // Incremental task patches stay off the timeline — they're covered by
        // task_started/progress/notification. Per-task bookkeeping is
        // deliberately NOT cleaned here either: a terminal patch can precede
        // the task_notification, and the notification needs both the
        // skip_transcript tombstone (it does not always repeat the flag) and
        // the spawning-turn metadata (to attribute the completion). The
        // notification is the sole consumer of both; the occasional entry
        // leaked by a never-notifying task is a few strings per session.
        if (message.subtype === "task_updated") {
          return;
        }

        if (message.subtype === "session_state_changed") {
          // Authoritative turn-over signal: `idle` fires only after held-back
          // results flush and background agents settle. Any turn still open at
          // this point — a synthetic continuation whose result never arrived as
          // a standalone message, or a user turn whose result was swallowed by
          // an over-counted stale-result debt — is by definition finished, so
          // close it rather than leaving the thread stuck in a phantom turn.
          if (message.state === "idle") {
            // All owed results have flushed by the time idle fires; drop any
            // remaining stale-result debt so future results are never swallowed.
            context.staleResultsExpected = 0;
            if (context.turnState) {
              yield* completeTurn(context, "completed");
            }
          }
          const stateStamp = yield* makeEventStamp();
          yield* offerRuntimeEvent({
            type: "session.state.changed",
            eventId: stateStamp.eventId,
            provider: PROVIDER,
            createdAt: stateStamp.createdAt,
            threadId: context.session.threadId,
            ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
            payload: {
              state:
                message.state === "idle"
                  ? "ready"
                  : message.state === "requires_action"
                    ? "waiting"
                    : "running",
              reason: `session_state:${message.state}`,
            },
            providerRefs: nativeProviderRefs(context),
            raw: {
              source: "claude.sdk.message",
              method: sdkNativeMethod(message),
              messageType: `${message.type}:${message.subtype}`,
              payload: message,
            },
          });
          return;
        }

        const stamp = yield* makeEventStamp();
        const base = {
          eventId: stamp.eventId,
          provider: PROVIDER,
          createdAt: stamp.createdAt,
          threadId: context.session.threadId,
          ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
          providerRefs: nativeProviderRefs(context),
          raw: {
            source: "claude.sdk.message" as const,
            method: sdkNativeMethod(message),
            messageType: `${message.type}:${message.subtype}`,
            payload: message,
          },
        };

        switch (message.subtype) {
          case "init":
            yield* offerRuntimeEvent({
              ...base,
              type: "session.configured",
              payload: {
                config: message as Record<string, unknown>,
              },
            });
            return;
          case "status":
            yield* offerRuntimeEvent({
              ...base,
              type: "session.state.changed",
              payload: {
                state: message.status === "compacting" ? "waiting" : "running",
                reason: `status:${message.status ?? "active"}`,
                detail: message,
              },
            });
            return;
          case "compact_boundary":
            yield* offerRuntimeEvent({
              ...base,
              type: "thread.state.changed",
              payload: {
                state: "compacted",
                detail: message,
              },
            });
            return;
          case "hook_started":
            yield* offerRuntimeEvent({
              ...base,
              type: "hook.started",
              payload: {
                hookId: message.hook_id,
                hookName: message.hook_name,
                hookEvent: message.hook_event,
              },
            });
            return;
          case "hook_progress":
            yield* offerRuntimeEvent({
              ...base,
              type: "hook.progress",
              payload: {
                hookId: message.hook_id,
                output: message.output,
                stdout: message.stdout,
                stderr: message.stderr,
              },
            });
            return;
          case "hook_response":
            yield* offerRuntimeEvent({
              ...base,
              type: "hook.completed",
              payload: {
                hookId: message.hook_id,
                outcome: message.outcome,
                output: message.output,
                stdout: message.stdout,
                stderr: message.stderr,
                ...(typeof message.exit_code === "number" ? { exitCode: message.exit_code } : {}),
              },
            });
            return;
          case "task_started":
            // Ambient/housekeeping tasks are flagged skip_transcript; keep their
            // whole lifecycle off the conversation timeline.
            if (message.skip_transcript === true) {
              context.hiddenTaskIds.add(message.task_id);
              return;
            }
            if (message.tool_use_id) {
              context.knownTasksByToolUseId.set(message.tool_use_id, {
                taskId: message.task_id,
                description:
                  message.description.trim().length > 0 ? message.description : "Subagent task",
                ...(message.subagent_type ? { subagentType: message.subagent_type } : {}),
                ...(context.turnState ? { turnId: context.turnState.turnId } : {}),
              });
            }
            yield* offerRuntimeEvent({
              ...base,
              type: "task.started",
              payload: {
                taskId: RuntimeTaskId.makeUnsafe(message.task_id),
                description: message.description,
                ...(message.task_type ? { taskType: message.task_type } : {}),
                ...(message.tool_use_id ? { toolUseId: message.tool_use_id } : {}),
                ...(message.subagent_type ? { subagentType: message.subagent_type } : {}),
                ...(message.workflow_name ? { workflowName: message.workflow_name } : {}),
              },
            });
            return;
          case "task_progress": {
            if (context.hiddenTaskIds.has(message.task_id)) {
              return;
            }
            // Task progress belongs to the turn that spawned the task — not
            // whatever turn happens to be open when it arrives, and not no turn
            // at all (the web work-log filter hides turn-less activities once
            // turn-stamped messages exist).
            const progressTurnId = message.tool_use_id
              ? context.knownTasksByToolUseId.get(message.tool_use_id)?.turnId
              : undefined;
            if (message.usage) {
              const normalizedUsage = normalizeClaudeTokenUsage(
                message.usage,
                context.lastKnownContextWindow,
              );
              if (normalizedUsage) {
                context.lastKnownTokenUsage = normalizedUsage;
                const usageStamp = yield* makeEventStamp();
                yield* offerRuntimeEvent({
                  ...base,
                  eventId: usageStamp.eventId,
                  createdAt: usageStamp.createdAt,
                  ...(progressTurnId ? { turnId: asCanonicalTurnId(progressTurnId) } : {}),
                  type: "thread.token-usage.updated",
                  payload: {
                    usage: normalizedUsage,
                  },
                });
              }
            }
            yield* offerRuntimeEvent({
              ...base,
              ...(progressTurnId ? { turnId: asCanonicalTurnId(progressTurnId) } : {}),
              type: "task.progress",
              payload: {
                taskId: RuntimeTaskId.makeUnsafe(message.task_id),
                description: message.description,
                ...(message.summary ? { summary: message.summary } : {}),
                ...(message.usage ? { usage: message.usage } : {}),
                ...(message.last_tool_name ? { lastToolName: message.last_tool_name } : {}),
                ...(message.tool_use_id ? { toolUseId: message.tool_use_id } : {}),
                ...(message.subagent_type ? { subagentType: message.subagent_type } : {}),
              },
            });
            // While the spawning Task tool call is still awaiting its result,
            // mirror the progress onto its tool item so the "Subagent task"
            // row shows live activity instead of a frozen request summary.
            const spawningTool = message.tool_use_id
              ? context.toolsAwaitingResult.get(message.tool_use_id)
              : undefined;
            if (spawningTool) {
              const progressStamp = yield* makeEventStamp();
              yield* offerRuntimeEvent({
                ...base,
                eventId: progressStamp.eventId,
                createdAt: progressStamp.createdAt,
                type: "item.updated",
                itemId: asRuntimeItemId(spawningTool.itemId),
                payload: {
                  itemType: spawningTool.itemType,
                  status: "inProgress",
                  title: spawningTool.title,
                  ...(spawningTool.detail ? { detail: spawningTool.detail } : {}),
                  data: toolLifecycleEventData(spawningTool, {
                    taskId: message.task_id,
                    // `output` is the field the web's collab work-log extraction
                    // renders; the named fields ride along for richer clients.
                    ...(message.summary
                      ? { output: message.summary, taskSummary: message.summary }
                      : {}),
                    ...(message.last_tool_name ? { lastToolName: message.last_tool_name } : {}),
                    ...(message.subagent_type ? { subagentType: message.subagent_type } : {}),
                  }),
                },
                providerRefs: nativeProviderRefs(context, {
                  providerItemId: spawningTool.itemId,
                }),
              });
            }
            return;
          }
          case "task_notification": {
            let notifiedTask = message.tool_use_id
              ? context.knownTasksByToolUseId.get(message.tool_use_id)
              : undefined;
            if (message.tool_use_id) {
              context.knownTasksByToolUseId.delete(message.tool_use_id);
            } else {
              // Notifications may omit the tool id; match by task id instead so
              // the entry cannot leak — keeping its spawning-turn metadata for
              // the completion event below.
              for (const [toolUseId, taskInfo] of context.knownTasksByToolUseId) {
                if (taskInfo.taskId === message.task_id) {
                  notifiedTask = taskInfo;
                  context.knownTasksByToolUseId.delete(toolUseId);
                  break;
                }
              }
            }
            if (context.hiddenTaskIds.delete(message.task_id) || message.skip_transcript === true) {
              return;
            }
            // The completion belongs to the turn that spawned the task, even if
            // an unrelated turn is open when the notification arrives.
            const notificationTurnId = notifiedTask?.turnId;
            if (message.usage) {
              const normalizedUsage = normalizeClaudeTokenUsage(
                message.usage,
                context.lastKnownContextWindow,
              );
              if (normalizedUsage) {
                context.lastKnownTokenUsage = normalizedUsage;
                const usageStamp = yield* makeEventStamp();
                yield* offerRuntimeEvent({
                  ...base,
                  eventId: usageStamp.eventId,
                  createdAt: usageStamp.createdAt,
                  ...(notificationTurnId ? { turnId: asCanonicalTurnId(notificationTurnId) } : {}),
                  type: "thread.token-usage.updated",
                  payload: {
                    usage: normalizedUsage,
                  },
                });
              }
            }
            yield* offerRuntimeEvent({
              ...base,
              ...(notificationTurnId ? { turnId: asCanonicalTurnId(notificationTurnId) } : {}),
              type: "task.completed",
              payload: {
                taskId: RuntimeTaskId.makeUnsafe(message.task_id),
                status: message.status,
                ...(message.summary ? { summary: message.summary } : {}),
                ...(message.usage ? { usage: message.usage } : {}),
                ...(message.tool_use_id ? { toolUseId: message.tool_use_id } : {}),
              },
            });
            return;
          }
          case "files_persisted":
            yield* offerRuntimeEvent({
              ...base,
              type: "files.persisted",
              payload: {
                files: Array.isArray(message.files)
                  ? message.files.map((file: { filename: string; file_id: string }) => ({
                      filename: file.filename,
                      fileId: file.file_id,
                    }))
                  : [],
                ...(Array.isArray(message.failed)
                  ? {
                      failed: message.failed.map((entry: { filename: string; error: string }) => ({
                        filename: entry.filename,
                        error: entry.error,
                      })),
                    }
                  : {}),
              },
            });
            return;
          case "notification":
            // Loop-side notifications mirror the REPL notification queue; only
            // urgent ones warrant a timeline entry.
            if (message.priority === "high" || message.priority === "immediate") {
              yield* emitRuntimeWarning(context, message.text, {
                key: message.key,
                priority: message.priority,
              });
            }
            return;
          case "mirror_error":
            // Transcript-mirror batches were dropped after retries — surface it
            // so history loss isn't silent.
            yield* emitRuntimeWarning(
              context,
              "Claude transcript mirror write failed; some session history may be missing.",
              message,
            );
            return;
          case "plugin_install":
            if (message.status === "failed") {
              yield* emitRuntimeWarning(
                context,
                `Claude plugin install failed${message.name ? ` (${message.name})` : ""}.`,
                message,
              );
            }
            return;
          case "local_command_output": {
            // Output of local slash commands (e.g. /usage) renders as
            // assistant-style text in the transcript.
            const localCommandText = sanitizeClaudeDisplayText(message.content ?? "");
            if (localCommandText.trim().length === 0) {
              return;
            }
            const entry = yield* createSyntheticAssistantTextBlock(context, localCommandText);
            if (entry) {
              yield* completeAssistantTextBlock(context, entry.block, {
                force: true,
                rawMethod: sdkNativeMethod(message),
                rawPayload: message,
              });
            }
            return;
          }
          // All subtypes known to this SDK version are handled above; this is a
          // runtime safety net for kinds introduced by newer SDKs.
          default: {
            const unknownSubtype = sdkMessageSubtype(message) ?? "unknown";
            yield* warnUnhandledSdkKind(
              context,
              `system:${unknownSubtype}`,
              `Unhandled Claude system message subtype '${unknownSubtype}'.`,
              message,
            );
            return;
          }
        }
      });

    const handleSdkTelemetryMessage = (
      context: ClaudeSessionContext,
      message: SDKMessage,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const stamp = yield* makeEventStamp();
        const base = {
          eventId: stamp.eventId,
          provider: PROVIDER,
          createdAt: stamp.createdAt,
          threadId: context.session.threadId,
          ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
          providerRefs: nativeProviderRefs(context),
          raw: {
            source: "claude.sdk.message" as const,
            method: sdkNativeMethod(message),
            messageType: message.type,
            payload: message,
          },
        };

        if (message.type === "tool_progress") {
          yield* offerRuntimeEvent({
            ...base,
            type: "tool.progress",
            payload: {
              toolUseId: message.tool_use_id,
              toolName: message.tool_name,
              elapsedSeconds: message.elapsed_time_seconds,
              ...(message.task_id ? { summary: `task:${message.task_id}` } : {}),
            },
          });
          return;
        }

        if (message.type === "tool_use_summary") {
          yield* offerRuntimeEvent({
            ...base,
            type: "tool.summary",
            payload: {
              summary: message.summary,
              ...(message.preceding_tool_use_ids.length > 0
                ? { precedingToolUseIds: message.preceding_tool_use_ids }
                : {}),
            },
          });
          return;
        }

        if (message.type === "auth_status") {
          yield* offerRuntimeEvent({
            ...base,
            type: "auth.status",
            payload: {
              isAuthenticating: message.isAuthenticating,
              output: message.output,
              ...(message.error ? { error: message.error } : {}),
            },
          });
          return;
        }

        if (message.type === "rate_limit_event") {
          yield* offerRuntimeEvent({
            ...base,
            type: "account.rate-limits.updated",
            payload: {
              rateLimits: message,
            },
          });
          return;
        }
      });

    const handleSdkMessage = (
      context: ClaudeSessionContext,
      message: SDKMessage,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        yield* logNativeSdkMessage(context, message);
        yield* ensureThreadId(context, message);

        const parentToolUseId = messageParentToolUseId(message);

        switch (message.type) {
          case "stream_event":
            // Subagent stream events reuse content-block indices concurrently
            // with the main stream; feeding them into the block-index-keyed
            // turn state clobbers in-flight tools and interleaves text.
            if (parentToolUseId !== undefined) {
              return;
            }
            yield* handleStreamEvent(context, message);
            return;
          case "user":
            if (parentToolUseId !== undefined || isReplayedUserMessage(message)) {
              return;
            }
            yield* handleUserMessage(context, message);
            return;
          case "assistant":
            if (parentToolUseId !== undefined) {
              yield* handleSubagentAssistantMessage(context, message, parentToolUseId);
              return;
            }
            yield* handleAssistantMessage(context, message);
            return;
          case "result":
            yield* handleResultMessage(context, message);
            return;
          case "system":
            yield* handleSystemMessage(context, message);
            return;
          case "tool_progress":
            // Progress for tools running inside a subagent stays with the
            // parent Task (task_progress covers it); leaking it here would put
            // subagent-internal tool rows in the main turn's work log.
            if (parentToolUseId !== undefined) {
              return;
            }
            yield* handleSdkTelemetryMessage(context, message);
            return;
          case "tool_use_summary":
          case "auth_status":
          case "rate_limit_event":
            yield* handleSdkTelemetryMessage(context, message);
            return;
          // Predicted next-prompt suggestions are a REPL affordance we don't render.
          case "prompt_suggestion":
            return;
          // All types known to this SDK version are handled above; this is a
          // runtime safety net for kinds introduced by newer SDKs.
          default: {
            const unknownType = sdkMessageType(message) ?? "unknown";
            yield* warnUnhandledSdkKind(
              context,
              `type:${unknownType}`,
              `Unhandled Claude SDK message type '${unknownType}'.`,
              message,
            );
            return;
          }
        }
      });

    const runSdkStream = (context: ClaudeSessionContext): Effect.Effect<void, Error> =>
      Stream.fromAsyncIterable(context.query, (cause) =>
        toError(cause, "Claude runtime stream failed."),
      ).pipe(
        Stream.takeWhile(() => !context.stopped),
        Stream.runForEach((message) => handleSdkMessage(context, message)),
      );

    const handleStreamExit = (
      context: ClaudeSessionContext,
      exit: Exit.Exit<void, Error>,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (context.stopped) {
          return;
        }

        if (Exit.isFailure(exit)) {
          if (hasPendingUserInterrupt(context) || isClaudeInterruptedCause(exit.cause)) {
            if (context.turnState) {
              yield* completeTurn(
                context,
                "interrupted",
                interruptionMessageFromClaudeCause(exit.cause),
              );
            }
          } else if (isClaudeBenignTerminationCause(exit.cause)) {
            // External SIGTERM/SIGINT: a graceful stop, not a crash. Suspend the turn
            // without an error toast so the session resumes on the next message.
            yield* Effect.logInfo("claude.session.benign_termination", {
              threadId: context.session.threadId,
              detail: messageFromClaudeStreamCause(exit.cause, "Claude runtime terminated."),
            });
            if (context.turnState) {
              yield* completeTurn(context, "interrupted", CLAUDE_BENIGN_TERMINATION_MESSAGE);
            }
          } else {
            const message = messageFromClaudeStreamCause(
              exit.cause,
              "Claude runtime stream failed.",
            );
            yield* emitRuntimeError(context, message, Cause.pretty(exit.cause));
            yield* completeTurn(context, "failed", message);
          }
        } else if (context.turnState) {
          yield* completeTurn(context, "interrupted", "Claude runtime stream ended.");
        }

        yield* stopSessionInternal(context, {
          emitExitEvent: true,
        });
      });

    const stopSessionInternal = (
      context: ClaudeSessionContext,
      options?: { readonly emitExitEvent?: boolean },
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (context.stopped) return;

        context.stopped = true;

        for (const [requestId, pending] of context.pendingApprovals) {
          yield* Deferred.succeed(pending.decision, "cancel");
          const stamp = yield* makeEventStamp();
          yield* offerRuntimeEvent({
            type: "request.resolved",
            eventId: stamp.eventId,
            provider: PROVIDER,
            createdAt: stamp.createdAt,
            threadId: context.session.threadId,
            ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
            requestId: asRuntimeRequestId(requestId),
            payload: {
              requestType: pending.requestType,
              decision: "cancel",
            },
            providerRefs: nativeProviderRefs(context),
          });
        }
        context.pendingApprovals.clear();

        if (context.turnState) {
          yield* completeTurn(context, "interrupted", "Session stopped.");
        }

        yield* Queue.shutdown(context.promptQueue);

        const streamFiber = context.streamFiber;
        context.streamFiber = undefined;
        if (streamFiber && streamFiber.pollUnsafe() === undefined) {
          yield* Fiber.interrupt(streamFiber);
        }

        // @effect-diagnostics-next-line tryCatchInEffectGen:off
        try {
          context.query.close();
        } catch (cause) {
          yield* emitRuntimeError(context, "Failed to close Claude runtime query.", cause);
        }

        const updatedAt = yield* nowIso;
        context.session = {
          ...context.session,
          status: "closed",
          activeTurnId: undefined,
          updatedAt,
        };

        if (options?.emitExitEvent !== false) {
          const stamp = yield* makeEventStamp();
          yield* offerRuntimeEvent({
            type: "session.exited",
            eventId: stamp.eventId,
            provider: PROVIDER,
            createdAt: stamp.createdAt,
            threadId: context.session.threadId,
            payload: {
              reason: "Session stopped",
              exitKind: "graceful",
            },
            providerRefs: {},
          });
        }

        sessions.delete(context.session.threadId);
      });

    const requireSession = (
      threadId: ThreadId,
    ): Effect.Effect<ClaudeSessionContext, ProviderAdapterError> => {
      const context = sessions.get(threadId);
      if (!context) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            threadId,
          }),
        );
      }
      if (context.stopped || context.session.status === "closed") {
        return Effect.fail(
          new ProviderAdapterSessionClosedError({
            provider: PROVIDER,
            threadId,
          }),
        );
      }
      return Effect.succeed(context);
    };

    const startSession: ClaudeAdapterShape["startSession"] = (input) =>
      Effect.gen(function* () {
        if (input.provider !== undefined && input.provider !== PROVIDER) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
          });
        }

        const startedAt = yield* nowIso;
        const resumeState = readClaudeResumeState(input.resumeCursor);
        const threadId = input.threadId;
        const existingResumeSessionId = resumeState?.resume;
        const newSessionId =
          existingResumeSessionId === undefined ? yield* Random.nextUUIDv4 : undefined;
        const sessionId = existingResumeSessionId ?? newSessionId;

        const promptQueue = yield* Queue.unbounded<PromptQueueItem>();
        const prompt = Stream.fromQueue(promptQueue).pipe(
          Stream.filter((item) => item.type === "message"),
          Stream.map((item) => item.message),
          Stream.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause) ? Stream.empty : Stream.failCause(cause),
          ),
          Stream.toAsyncIterable,
        );

        const pendingApprovals = new Map<ApprovalRequestId, PendingApproval>();
        const pendingUserInputs = new Map<ApprovalRequestId, PendingUserInput>();

        const contextRef = yield* Ref.make<ClaudeSessionContext | undefined>(undefined);

        /**
         * Handle AskUserQuestion tool calls by emitting a `user-input.requested`
         * runtime event and waiting for the user to respond via `respondToUserInput`.
         */
        const handleAskUserQuestion = (
          context: ClaudeSessionContext,
          toolInput: Record<string, unknown>,
          callbackOptions: { readonly signal: AbortSignal; readonly toolUseID?: string },
        ) =>
          Effect.gen(function* () {
            const requestId = ApprovalRequestId.makeUnsafe(yield* Random.nextUUIDv4);

            // Parse questions from the SDK's AskUserQuestion input.
            const rawQuestions = Array.isArray(toolInput.questions) ? toolInput.questions : [];
            const questions: Array<UserInputQuestion> = rawQuestions.map(
              (q: Record<string, unknown>, idx: number) => ({
                id: typeof q.header === "string" ? q.header : `q-${idx}`,
                header: typeof q.header === "string" ? q.header : `Question ${idx + 1}`,
                question: typeof q.question === "string" ? q.question : "",
                options: Array.isArray(q.options)
                  ? q.options.map((opt: Record<string, unknown>) => ({
                      label: typeof opt.label === "string" ? opt.label : "",
                      description: typeof opt.description === "string" ? opt.description : "",
                    }))
                  : [],
                multiSelect: typeof q.multiSelect === "boolean" ? q.multiSelect : false,
              }),
            );

            const answersDeferred = yield* Deferred.make<ProviderUserInputAnswers>();
            let aborted = false;
            const pendingInput: PendingUserInput = {
              questions,
              answers: answersDeferred,
            };

            // Emit user-input.requested so the UI can present the questions.
            const requestedStamp = yield* makeEventStamp();
            yield* offerRuntimeEvent({
              type: "user-input.requested",
              eventId: requestedStamp.eventId,
              provider: PROVIDER,
              createdAt: requestedStamp.createdAt,
              threadId: context.session.threadId,
              ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
              requestId: asRuntimeRequestId(requestId),
              payload: { questions },
              providerRefs: nativeProviderRefs(context, {
                providerItemId: callbackOptions.toolUseID,
              }),
              raw: {
                source: "claude.sdk.permission",
                method: "canUseTool/AskUserQuestion",
                payload: { toolName: "AskUserQuestion", input: toolInput },
              },
            });

            pendingUserInputs.set(requestId, pendingInput);

            // Handle abort (e.g. turn interrupted while waiting for user input).
            const onAbort = () => {
              if (!pendingUserInputs.has(requestId)) {
                return;
              }
              aborted = true;
              pendingUserInputs.delete(requestId);
              Effect.runFork(Deferred.succeed(answersDeferred, {} as ProviderUserInputAnswers));
            };
            callbackOptions.signal.addEventListener("abort", onAbort, { once: true });

            // Block until the user provides answers.
            const answers = remapAnswersToClaudeQuestionText(
              questions,
              yield* Deferred.await(answersDeferred).pipe(
                Effect.ensuring(
                  Effect.sync(() => {
                    callbackOptions.signal.removeEventListener("abort", onAbort);
                  }),
                ),
              ),
            );
            pendingUserInputs.delete(requestId);

            // Emit user-input.resolved so the UI knows the interaction completed.
            const resolvedStamp = yield* makeEventStamp();
            yield* offerRuntimeEvent({
              type: "user-input.resolved",
              eventId: resolvedStamp.eventId,
              provider: PROVIDER,
              createdAt: resolvedStamp.createdAt,
              threadId: context.session.threadId,
              ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
              requestId: asRuntimeRequestId(requestId),
              payload: { answers },
              providerRefs: nativeProviderRefs(context, {
                providerItemId: callbackOptions.toolUseID,
              }),
              raw: {
                source: "claude.sdk.permission",
                method: "canUseTool/AskUserQuestion/resolved",
                payload: { answers },
              },
            });

            if (aborted) {
              return {
                behavior: "deny",
                message: "User cancelled tool execution.",
              } satisfies PermissionResult;
            }

            // Return the answers to the SDK in the expected format:
            // { questions: [...], answers: { questionText: selectedLabel } }
            return {
              behavior: "allow",
              updatedInput: {
                questions: toolInput.questions,
                answers,
              },
            } satisfies PermissionResult;
          });

        const canUseTool: CanUseTool = (toolName, toolInput, callbackOptions) =>
          Effect.runPromise(
            Effect.gen(function* () {
              const context = yield* Ref.get(contextRef);
              if (!context) {
                return {
                  behavior: "deny",
                  message: "Claude session context is unavailable.",
                } satisfies PermissionResult;
              }

              // Handle AskUserQuestion: surface clarifying questions to the
              // user via the user-input runtime event channel, regardless of
              // runtime mode (plan mode relies on this heavily).
              if (toolName === "AskUserQuestion") {
                return yield* handleAskUserQuestion(context, toolInput, callbackOptions);
              }

              if (toolName === "ExitPlanMode") {
                const planMarkdown = extractExitPlanModePlan(toolInput);
                if (planMarkdown) {
                  yield* emitProposedPlanCompleted(context, {
                    planMarkdown,
                    toolUseId: callbackOptions.toolUseID,
                    rawSource: "claude.sdk.permission",
                    rawMethod: "canUseTool/ExitPlanMode",
                    rawPayload: {
                      toolName,
                      input: toolInput,
                    },
                  });
                }

                return {
                  behavior: "deny",
                  message:
                    "The client captured your proposed plan. Stop here and wait for the user's feedback or implementation request in a later turn.",
                } satisfies PermissionResult;
              }

              const runtimeMode = input.runtimeMode ?? "full-access";
              if (runtimeMode === "full-access") {
                return {
                  behavior: "allow",
                  updatedInput: toolInput,
                } satisfies PermissionResult;
              }

              const requestId = ApprovalRequestId.makeUnsafe(yield* Random.nextUUIDv4);
              const requestType = classifyRequestType(toolName);
              const detail = summarizeToolRequest(toolName, toolInput);
              const decisionDeferred = yield* Deferred.make<ProviderApprovalDecision>();
              const pendingApproval: PendingApproval = {
                requestType,
                detail,
                decision: decisionDeferred,
                ...(callbackOptions.suggestions
                  ? { suggestions: callbackOptions.suggestions }
                  : {}),
              };

              const requestedStamp = yield* makeEventStamp();
              yield* offerRuntimeEvent({
                type: "request.opened",
                eventId: requestedStamp.eventId,
                provider: PROVIDER,
                createdAt: requestedStamp.createdAt,
                threadId: context.session.threadId,
                ...(context.turnState
                  ? { turnId: asCanonicalTurnId(context.turnState.turnId) }
                  : {}),
                requestId: asRuntimeRequestId(requestId),
                payload: {
                  requestType,
                  detail,
                  args: {
                    toolName,
                    input: toolInput,
                    ...(callbackOptions.toolUseID ? { toolUseId: callbackOptions.toolUseID } : {}),
                  },
                },
                providerRefs: nativeProviderRefs(context, {
                  providerItemId: callbackOptions.toolUseID,
                }),
                raw: {
                  source: "claude.sdk.permission",
                  method: "canUseTool/request",
                  payload: {
                    toolName,
                    input: toolInput,
                  },
                },
              });

              pendingApprovals.set(requestId, pendingApproval);

              const onAbort = () => {
                if (!pendingApprovals.has(requestId)) {
                  return;
                }
                pendingApprovals.delete(requestId);
                Effect.runFork(Deferred.succeed(decisionDeferred, "cancel"));
              };

              callbackOptions.signal.addEventListener("abort", onAbort, {
                once: true,
              });

              const decision = yield* Deferred.await(decisionDeferred).pipe(
                Effect.ensuring(
                  Effect.sync(() => {
                    callbackOptions.signal.removeEventListener("abort", onAbort);
                  }),
                ),
              );
              pendingApprovals.delete(requestId);

              const resolvedStamp = yield* makeEventStamp();
              yield* offerRuntimeEvent({
                type: "request.resolved",
                eventId: resolvedStamp.eventId,
                provider: PROVIDER,
                createdAt: resolvedStamp.createdAt,
                threadId: context.session.threadId,
                ...(context.turnState
                  ? { turnId: asCanonicalTurnId(context.turnState.turnId) }
                  : {}),
                requestId: asRuntimeRequestId(requestId),
                payload: {
                  requestType,
                  decision,
                },
                providerRefs: nativeProviderRefs(context, {
                  providerItemId: callbackOptions.toolUseID,
                }),
                raw: {
                  source: "claude.sdk.permission",
                  method: "canUseTool/decision",
                  payload: {
                    decision,
                  },
                },
              });

              if (decision === "accept" || decision === "acceptForSession") {
                return {
                  behavior: "allow",
                  updatedInput: toolInput,
                  ...(decision === "acceptForSession" && pendingApproval.suggestions
                    ? { updatedPermissions: [...pendingApproval.suggestions] }
                    : {}),
                } satisfies PermissionResult;
              }

              return {
                behavior: "deny",
                message:
                  decision === "cancel"
                    ? "User cancelled tool execution."
                    : "User declined tool execution.",
              } satisfies PermissionResult;
            }),
          );

        const providerOptions = input.providerOptions?.claudeAgent;
        const modelSelection =
          input.modelSelection?.provider === "claudeAgent" ? input.modelSelection : undefined;
        const requestedEffort = trimOrNull(modelSelection?.options?.effort ?? null);
        const requestedContextWindow = trimOrNull(modelSelection?.options?.contextWindow ?? null);
        const caps = getModelCapabilities("claudeAgent", modelSelection?.model);
        const apiModelId = modelSelection ? resolveApiModelId(modelSelection) : undefined;
        const effort =
          requestedEffort && hasEffortLevel(caps, requestedEffort) ? requestedEffort : null;
        const fastMode = modelSelection?.options?.fastMode === true && caps.supportsFastMode;
        const thinking =
          typeof modelSelection?.options?.thinking === "boolean" && caps.supportsThinkingToggle
            ? modelSelection.options.thinking
            : undefined;
        const effectiveEffort = getEffectiveClaudeCodeEffort(effort);
        const ultracode = effort === "ultracode" && hasEffortLevel(caps, "xhigh");
        const permissionMode =
          toPermissionMode(providerOptions?.permissionMode) ??
          (input.runtimeMode === "full-access" ? "bypassPermissions" : undefined);
        const settings = {
          ...(typeof thinking === "boolean" ? { alwaysThinkingEnabled: thinking } : {}),
          ...(fastMode ? { fastMode: true } : {}),
          ...(ultracode ? { ultracode: true } : {}),
        };
        const claudeSubagents = buildClaudeSdkSubagents();
        const claudeSdkEnv = yield* resolveClaudeSdkEnv;

        const queryOptions: ClaudeQueryOptions = {
          ...(input.cwd ? { cwd: input.cwd } : {}),
          // Keep Claude context-window selection model-driven so session start
          // and in-session switches both use the same API model contract.
          ...(apiModelId ? { model: apiModelId } : {}),
          pathToClaudeCodeExecutable: providerOptions?.binaryPath ?? "claude",
          settingSources: [...CLAUDE_SETTING_SOURCES],
          systemPrompt: {
            type: "preset",
            preset: "claude_code",
            append: EMBEDDED_CLAUDE_SYSTEM_PROMPT_APPEND,
          },
          ...(Object.keys(claudeSubagents).length > 0 ? { agents: claudeSubagents } : {}),
          // Keep the runtime value explicit so Opus 4.7 can pass xhigh through to the SDK.
          ...(effectiveEffort
            ? { effort: effectiveEffort as "low" | "medium" | "high" | "xhigh" | "max" }
            : {}),
          ...(permissionMode ? { permissionMode } : {}),
          ...(permissionMode === "bypassPermissions"
            ? { allowDangerouslySkipPermissions: true }
            : {}),
          ...(providerOptions?.maxThinkingTokens !== undefined
            ? { maxThinkingTokens: providerOptions.maxThinkingTokens }
            : {}),
          ...(Object.keys(settings).length > 0 ? { settings } : {}),
          ...(existingResumeSessionId ? { resume: existingResumeSessionId } : {}),
          ...(newSessionId ? { sessionId: newSessionId } : {}),
          includePartialMessages: true,
          canUseTool,
          env: claudeSdkEnv,
          ...(input.cwd ? { additionalDirectories: [input.cwd] } : {}),
        };

        const queryRuntime = yield* Effect.try({
          try: () =>
            createQuery({
              prompt,
              options: queryOptions,
            }),
          catch: (cause) =>
            new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId,
              detail: toMessage(cause, "Failed to start Claude runtime session."),
              cause,
            }),
        });

        // Populate model cache in background from first session
        if (!cachedModels) {
          queryRuntime
            .supportedModels()
            .then((models) => {
              cachedModels = {
                models: models.map((m) => ({ slug: m.value, name: m.displayName })),
                source: "sdk",
                cached: false,
              };
            })
            .catch(() => {
              /* ignore discovery failures */
            });
        }

        // Populate agent cache in background from first session
        if (!cachedAgents) {
          queryRuntime
            .supportedAgents()
            .then((agents) => {
              cachedAgents = {
                agents: agents.map((a) => ({
                  name: a.name,
                  displayName: a.name,
                  ...(a.description ? { description: a.description } : {}),
                  ...(a.model ? { model: a.model } : {}),
                })),
                source: "sdk",
                cached: false,
              };
            })
            .catch(() => {
              /* ignore discovery failures */
            });
        }

        const session: ProviderSession = {
          threadId,
          provider: PROVIDER,
          status: "ready",
          runtimeMode: input.runtimeMode,
          ...(input.cwd ? { cwd: input.cwd } : {}),
          ...(modelSelection?.model ? { model: modelSelection.model } : {}),
          ...(threadId ? { threadId } : {}),
          resumeCursor: {
            ...(threadId ? { threadId } : {}),
            ...(sessionId ? { resume: sessionId } : {}),
            ...(resumeState?.resumeSessionAt
              ? { resumeSessionAt: resumeState.resumeSessionAt }
              : {}),
            turnCount: resumeState?.turnCount ?? 0,
          },
          createdAt: startedAt,
          updatedAt: startedAt,
        };

        const context: ClaudeSessionContext = {
          session,
          promptQueue,
          query: queryRuntime,
          streamFiber: undefined,
          startedAt,
          basePermissionMode: permissionMode,
          lastInteractionMode: undefined,
          currentApiModelId: apiModelId,
          resumeSessionId: sessionId,
          pendingApprovals,
          pendingUserInputs,
          turns: [],
          streamingToolsByIndex: new Map(),
          toolsAwaitingResult: new Map(),
          turnState: undefined,
          interruptRequestedTurnId: undefined,
          staleResultsExpected: 0,
          lastKnownContextWindow: undefined,
          lastKnownTokenUsage: undefined,
          lastAssistantUuid: resumeState?.resumeSessionAt,
          lastThreadStartedId: undefined,
          stopped: false,
          warnedUnhandledSdkKinds: new Set(),
          hiddenTaskIds: new Set(),
          knownTasksByToolUseId: new Map(),
        };
        yield* Ref.set(contextRef, context);
        sessions.set(threadId, context);

        const sessionStartedStamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "session.started",
          eventId: sessionStartedStamp.eventId,
          provider: PROVIDER,
          createdAt: sessionStartedStamp.createdAt,
          threadId,
          payload: input.resumeCursor !== undefined ? { resume: input.resumeCursor } : {},
          providerRefs: {},
        });

        const configuredStamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "session.configured",
          eventId: configuredStamp.eventId,
          provider: PROVIDER,
          createdAt: configuredStamp.createdAt,
          threadId,
          payload: {
            config: {
              ...(modelSelection?.model ? { model: modelSelection.model } : {}),
              ...(apiModelId ? { apiModelId } : {}),
              ...(requestedContextWindow ? { contextWindow: requestedContextWindow } : {}),
              ...(input.cwd ? { cwd: input.cwd } : {}),
              ...(effectiveEffort ? { effort: effectiveEffort } : {}),
              ...(permissionMode ? { permissionMode } : {}),
              ...(providerOptions?.maxThinkingTokens !== undefined
                ? { maxThinkingTokens: providerOptions.maxThinkingTokens }
                : {}),
              ...(fastMode ? { fastMode: true } : {}),
              ...(ultracode ? { ultracode: true } : {}),
            },
          },
          providerRefs: {},
        });

        const readyStamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "session.state.changed",
          eventId: readyStamp.eventId,
          provider: PROVIDER,
          createdAt: readyStamp.createdAt,
          threadId,
          payload: {
            state: "ready",
          },
          providerRefs: {},
        });

        const streamFiber = Effect.runFork(runSdkStream(context));
        context.streamFiber = streamFiber;
        streamFiber.addObserver((exit) => {
          if (context.stopped) {
            return;
          }
          if (context.streamFiber === streamFiber) {
            context.streamFiber = undefined;
          }
          Effect.runFork(handleStreamExit(context, exit));
        });

        return {
          ...session,
        };
      });

    const sendTurn: ClaudeAdapterShape["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const context = yield* requireSession(input.threadId);
        const modelSelection =
          input.modelSelection?.provider === "claudeAgent" ? input.modelSelection : undefined;
        const requestedContextWindowMaxTokens = resolveSelectedClaudeContextWindowMaxTokens(
          modelSelection?.model,
          modelSelection?.options?.contextWindow,
        );

        if (context.turnState) {
          // Auto-close a still-open turn so it cannot block the user's next
          // turn. Only user-origin turns provably owe an SDK result (their
          // prompt is queued and will run to completion), so only they arm the
          // stale-result debt. A synthetic background continuation may fold its
          // result into the idle signal instead — arming debt for it risks
          // swallowing (and mislabeling) the new user turn's own result.
          if (context.turnState.origin === "user") {
            context.staleResultsExpected += 1;
          }
          yield* completeTurn(context, "completed");
        }

        if (modelSelection?.model) {
          const apiModelId = resolveApiModelId(modelSelection);
          yield* Effect.tryPromise({
            try: () => context.query.setModel(apiModelId),
            catch: (cause) => toRequestError(input.threadId, "turn/setModel", cause),
          });
          context.currentApiModelId = apiModelId;
          if (requestedContextWindowMaxTokens !== undefined) {
            context.lastKnownContextWindow = requestedContextWindowMaxTokens;
          }
        }

        // Apply interaction mode on every turn so sticky SDK permission state
        // cannot leak plan mode across service/recovery paths that omit it.
        const effectiveInteractionMode = input.interactionMode ?? "default";
        if (effectiveInteractionMode === "plan") {
          yield* Effect.tryPromise({
            try: () => context.query.setPermissionMode("plan"),
            catch: (cause) => toRequestError(input.threadId, "turn/setPermissionMode", cause),
          });
        } else if (
          context.basePermissionMode !== undefined ||
          context.lastInteractionMode === "plan"
        ) {
          yield* Effect.tryPromise({
            try: () => context.query.setPermissionMode(context.basePermissionMode ?? "default"),
            catch: (cause) => toRequestError(input.threadId, "turn/setPermissionMode", cause),
          });
        }

        const turnId = TurnId.makeUnsafe(yield* Random.nextUUIDv4);
        const turnState: ClaudeTurnState = {
          turnId,
          startedAt: yield* nowIso,
          interactionMode: effectiveInteractionMode,
          origin: "user",
          items: [],
          assistantTextBlocks: new Map(),
          assistantTextBlockOrder: [],
          capturedProposedPlanKeys: new Set(),
          sawFileChange: false,
          nextSyntheticAssistantBlockIndex: -1,
        };

        const updatedAt = yield* nowIso;
        context.turnState = turnState;
        context.session = {
          ...context.session,
          status: "running",
          activeTurnId: turnId,
          updatedAt,
        };

        const turnStartedStamp = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "turn.started",
          eventId: turnStartedStamp.eventId,
          provider: PROVIDER,
          createdAt: turnStartedStamp.createdAt,
          threadId: context.session.threadId,
          turnId,
          payload: modelSelection?.model ? { model: modelSelection.model } : {},
          providerRefs: {},
        });

        const message = yield* buildUserMessageEffect(input, {
          fileSystem,
          attachmentsDir: serverConfig.attachmentsDir,
        });

        yield* Queue.offer(context.promptQueue, {
          type: "message",
          message,
        }).pipe(Effect.mapError((cause) => toRequestError(input.threadId, "turn/start", cause)));

        return {
          threadId: context.session.threadId,
          turnId,
          ...(context.session.resumeCursor !== undefined
            ? { resumeCursor: context.session.resumeCursor }
            : {}),
        };
      });

    const interruptTurn: ClaudeAdapterShape["interruptTurn"] = (threadId, _turnId) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        if (context.turnState) {
          context.interruptRequestedTurnId = context.turnState.turnId;
        }
        yield* Effect.tryPromise({
          try: () => context.query.interrupt(),
          catch: (cause) => toRequestError(threadId, "turn/interrupt", cause),
        });
      });

    const readThread: ClaudeAdapterShape["readThread"] = (threadId) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        return yield* snapshotThread(context);
      });

    const rollbackThread: ClaudeAdapterShape["rollbackThread"] = (threadId, numTurns) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        const nextLength = Math.max(0, context.turns.length - numTurns);
        context.turns.splice(nextLength);
        yield* updateResumeCursor(context);
        return yield* snapshotThread(context);
      });

    const respondToRequest: ClaudeAdapterShape["respondToRequest"] = (
      threadId,
      requestId,
      decision,
    ) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        const pending = context.pendingApprovals.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "item/requestApproval/decision",
            detail: `Unknown pending approval request: ${requestId}`,
          });
        }

        context.pendingApprovals.delete(requestId);
        yield* Deferred.succeed(pending.decision, decision);
      });

    const respondToUserInput: ClaudeAdapterShape["respondToUserInput"] = (
      threadId,
      requestId,
      answers,
    ) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        const pending = context.pendingUserInputs.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "item/tool/respondToUserInput",
            detail: `Unknown pending user-input request: ${requestId}`,
          });
        }

        context.pendingUserInputs.delete(requestId);
        yield* Deferred.succeed(pending.answers, answers);
      });

    const stopSession: ClaudeAdapterShape["stopSession"] = (threadId) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        yield* stopSessionInternal(context, {
          emitExitEvent: true,
        });
      });

    const listSessions: ClaudeAdapterShape["listSessions"] = () =>
      Effect.sync(() => Array.from(sessions.values(), ({ session }) => ({ ...session })));

    const hasSession: ClaudeAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => {
        const context = sessions.get(threadId);
        return context !== undefined && !context.stopped;
      });

    // Native command discovery cache — avoids spawning a process per query.
    let commandsCache: { result: ProviderListCommandsResult; cwd: string } | null = null;
    let pendingCommandDiscovery: Promise<ProviderListCommandsResult> | null = null;

    async function discoverCommandsViaTemporaryProcess(
      cwd: string,
      env: NodeJS.ProcessEnv,
    ): Promise<ProviderListCommandsResult> {
      // Spawn a lightweight Claude Code process for native command discovery.
      // The SDK's supportedCommands() awaits an internal initialization promise
      // that only resolves when the async generator is iterated (driving the
      // subprocess handshake). We iterate in the background to unblock it.
      const tempQuery = createQuery({
        prompt: neverResolvingUserMessageStream(),
        options: {
          cwd,
          pathToClaudeCodeExecutable: "claude",
          settingSources: [...CLAUDE_SETTING_SOURCES],
          permissionMode: "plan" as PermissionMode,
          persistSession: false,
          env,
        },
      });

      try {
        // Drive the iterator so the subprocess completes its init handshake.
        // This runs in the background; close() in the finally block stops it.
        void (async () => {
          for await (const message of tempQuery) {
            void message;
            /* consume until closed */
          }
        })().catch(() => undefined);

        const commands = await tempQuery.supportedCommands();
        return mapSupportedCommands(commands);
      } finally {
        tempQuery.close();
      }
    }

    const listCommands: NonNullable<ClaudeAdapterShape["listCommands"]> = (
      input: ProviderListCommandsInput,
    ) =>
      Effect.gen(function* () {
        // 1. Try an active session first (cheapest path).
        const context = input.threadId
          ? sessions.get(ThreadId.makeUnsafe(input.threadId))
          : [...sessions.values()].find((s) => !s.stopped);

        if (context && !context.stopped) {
          const commands = yield* Effect.tryPromise({
            try: () => context.query.supportedCommands(),
            catch: (cause) => toRequestError(context.session.threadId, "listCommands", cause),
          });
          const result = mapSupportedCommands(commands);
          commandsCache = { result, cwd: input.cwd };
          return result;
        }

        // 2. Return from cache if valid and not force-reloading.
        if (commandsCache && commandsCache.cwd === input.cwd && !input.forceReload) {
          return { ...commandsCache.result, cached: true } satisfies ProviderListCommandsResult;
        }

        // 3. Spawn a temporary process for discovery (deduplicating concurrent requests).
        const claudeSdkEnv = yield* resolveClaudeSdkEnv;
        const discoveryPromise =
          pendingCommandDiscovery ?? discoverCommandsViaTemporaryProcess(input.cwd, claudeSdkEnv);
        pendingCommandDiscovery = discoveryPromise;

        const result = yield* Effect.tryPromise({
          try: () => discoveryPromise,
          catch: (cause) =>
            new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId: ThreadId.makeUnsafe("discovery"),
              detail: toMessage(cause, "Failed to discover Claude commands."),
              cause,
            }),
        }).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              pendingCommandDiscovery = null;
            }),
          ),
          Effect.tapError(() =>
            Effect.sync(() => {
              pendingCommandDiscovery = null;
            }),
          ),
        );

        commandsCache = { result, cwd: input.cwd };
        return result;
      });

    const listSkills: NonNullable<ClaudeAdapterShape["listSkills"]> = (
      _input: ProviderListSkillsInput,
    ) =>
      Effect.succeed({
        skills: [],
        source: "unsupported",
        cached: false,
      } satisfies ProviderListSkillsResult);

    const stopAll: ClaudeAdapterShape["stopAll"] = () =>
      Effect.forEach(
        sessions,
        ([, context]) =>
          stopSessionInternal(context, {
            emitExitEvent: true,
          }),
        { discard: true },
      );

    yield* Effect.addFinalizer(() =>
      Effect.forEach(
        sessions,
        ([, context]) =>
          stopSessionInternal(context, {
            emitExitEvent: false,
          }),
        { discard: true },
      ).pipe(Effect.tap(() => Queue.shutdown(runtimeEventQueue))),
    );

    const composerCapabilities: ProviderComposerCapabilities = {
      provider: PROVIDER,
      supportsSkillMentions: false,
      supportsSkillDiscovery: false,
      supportsNativeSlashCommandDiscovery: true,
      supportsPluginMentions: false,
      supportsPluginDiscovery: false,
      supportsRuntimeModelList: true,
      supportsThreadCompaction: false,
      supportsThreadImport: true,
    };

    const getComposerCapabilities: NonNullable<
      ClaudeAdapterShape["getComposerCapabilities"]
    > = () => Effect.succeed(composerCapabilities);

    const listModels: NonNullable<ClaudeAdapterShape["listModels"]> = (_input) =>
      Effect.sync(() => {
        if (cachedModels) {
          return { ...cachedModels, cached: true };
        }
        // Fallback: try to get models from any active session
        for (const [, context] of sessions) {
          if (!context.stopped && context.query) {
            // Trigger async cache population
            context.query
              .supportedModels()
              .then((models) => {
                cachedModels = {
                  models: models.map((m) => ({ slug: m.value, name: m.displayName })),
                  source: "sdk",
                  cached: false,
                };
              })
              .catch(() => {});
            break;
          }
        }
        // Return empty while waiting for cache
        return { models: [], source: "pending", cached: false };
      });

    const listAgents: NonNullable<ClaudeAdapterShape["listAgents"]> = (_input) =>
      Effect.sync(() => {
        if (cachedAgents) {
          return { ...cachedAgents, cached: true };
        }
        for (const [, context] of sessions) {
          if (!context.stopped && context.query) {
            context.query
              .supportedAgents()
              .then((agents) => {
                cachedAgents = {
                  agents: agents.map((a) => ({
                    name: a.name,
                    displayName: a.name,
                    ...(a.description ? { description: a.description } : {}),
                    ...(a.model ? { model: a.model } : {}),
                  })),
                  source: "sdk",
                  cached: false,
                };
              })
              .catch(() => {});
            break;
          }
        }
        return { agents: [], source: "pending", cached: false };
      });

    return {
      provider: PROVIDER,
      capabilities: {
        sessionModelSwitch: "in-session",
        supportsSkillMentions: false,
        supportsSkillDiscovery: false,
        supportsNativeSlashCommandDiscovery: true,
        supportsPluginMentions: false,
        supportsPluginDiscovery: false,
        supportsRuntimeModelList: true,
        supportsLiveTurnDiffPatch: false,
      },
      startSession,
      sendTurn,
      interruptTurn,
      readThread,
      rollbackThread,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      stopAll,
      getComposerCapabilities,
      listCommands,
      listSkills,
      listModels,
      listAgents,
      streamEvents: Stream.fromQueue(runtimeEventQueue),
    } satisfies ClaudeAdapterShape;
  });
}

export const ClaudeAdapterLive = Layer.effect(ClaudeAdapter, makeClaudeAdapter());

export function makeClaudeAdapterLive(options?: ClaudeAdapterLiveOptions) {
  return Layer.effect(ClaudeAdapter, makeClaudeAdapter(options));
}
