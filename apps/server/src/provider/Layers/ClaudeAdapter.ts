import { claudeTurnResultUsage, type ClaudeResultUsageBaseline } from "../claudeResultUsage.ts";
import { restoreClaudeImportedCopyDates } from "../claudeImportedCopyDates.ts";
import { execProcessFile, spawnProcess } from "@synara/shared/processRuntime";
import type {
  AgentInfo,
  CanUseTool,
  AgentDefinition,
  HookInput,
  HookJSONOutput,
  Options as ClaudeQueryOptions,
  ModelInfo,
  PermissionMode,
  PermissionResult,
  PermissionUpdate,
  SDKAssistantMessageError,
  SDKMessage,
  SDKResultMessage,
  SDKControlGetContextUsageResponse,
  Settings,
  SettingSource,
  SDKUserMessage,
  SlashCommand,
  SpawnOptions as ClaudeSpawnOptions,
  SpawnedProcess as ClaudeSpawnedProcess,
  SessionMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  ApprovalRequestId,
  type CanonicalItemType,
  type ClaudeApiEffort,
  ClaudeCacheObservation,
  type CanonicalRequestType,
  EventId,
  type ProviderApprovalDecision,
  type ProviderInteractionMode,
  ProviderItemId,
  type ProviderRuntimeEvent,
  type ProviderRuntimeTurnStatus,
  type ProviderSendTurnInput,
  type ProviderSession,
  type ThreadTokenUsageSnapshot,
  type ProviderUserInputAnswers,
  type RuntimeContentStreamKind,
  type RuntimeSessionState,
  RuntimeItemId,
  RuntimeRequestId,
  RuntimeTaskId,
  ThreadId,
  TurnId,
  type UserInputQuestion,
  type ProviderComposerCapabilities,
  type ProviderListCommandsInput,
  type ProviderArtifactsState,
  type ProviderListCommandsResult,
  type ProviderListSkillsInput,
  type ProviderListSkillsResult,
  type ProviderListAgentsResult,
  type ProviderListModelsResult,
  getAgentMentionAliases,
} from "@synara/contracts";
import {
  applyClaudePromptEffortPrefix,
  getClaudeContextWindowSuffix,
  getDefaultModel,
  getEffectiveClaudeCodeEffort,
  getModelCapabilities,
  getProviderOptionDescriptors,
  hasEffortLevel,
  normalizeClaudeModelOptions,
  resolveApiModelId,
  stripClaudeContextWindowSuffix,
  trimOrNull,
} from "@synara/shared/model";
import { buildClaudeSubagentPrompt } from "@synara/shared/agentMentions";
import { assessClaudeCache } from "@synara/shared/claudeCache";
import {
  claudeCacheContextTokens,
  claudeCacheFromRequest,
  claudeCacheFromSessionStart,
  claudeCacheForModel,
} from "../claudeCacheObservation.ts";
import { compareSemverVersions } from "../providerMaintenance.ts";
import {
  Cause,
  DateTime,
  Clock,
  Deferred,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Fiber,
  Layer,
  Option,
  Queue,
  Random,
  Schema,
  Ref,
  Stream,
} from "effect";

import { buildClaudeMcpServers } from "../../agentGateway/mcpInjection.ts";
import { renderSynaraHarnessPolicy } from "../../agentGateway/harnessPolicy.ts";
import { AgentGatewayCredentials } from "../../agentGateway/Services/AgentGatewayCredentials.ts";
import { PROVIDER_ADAPTER_RUNTIME_EVENT_BUFFER_CAPACITY } from "../Services/ProviderAdapter.ts";
import {
  acquireAgentGatewaySessionLease,
  cancelAgentGatewayTurn,
  type AgentGatewaySessionLease,
  withAgentGatewayTurnCancellation,
} from "../../agentGateway/sessionLease.ts";
import { resolveProviderAttachmentPath } from "../providerAttachmentPaths.ts";
import { settleConcurrentTeardowns } from "../settleConcurrentTeardowns.ts";
import { ServerConfig } from "../../config.ts";
import { buildFileAttachmentsPromptBlock } from "../attachmentProjection.ts";
import { loadClaudeAgentSdk } from "../claudeAgentSdk.ts";
import { buildClaudeProcessEnv, withClaudeArtifactOptIn } from "../claudeProcessEnv.ts";
import { ClaudeRequestUsage } from "../claudeRequestUsage.ts";
import {
  CLAUDE_CONTEXT_WINDOW_MAX_TOKENS,
  decideClaudeContextUsageWarnings,
  maxClaudeContextWindowFromModelUsage,
  mergeClaudeTokenUsageSnapshot,
  normalizeClaudeTokenUsage,
  resolveClaudeApiModelIdContextWindowMaxTokens,
  resolveClaudeEffectiveContextBudget,
  resolveEffectiveClaudeContextWindow,
  resolveSelectedClaudeAutoCompactWindow,
  snapshotFromClaudeContextUsage,
} from "../claudeTokenUsage.ts";
import {
  applyClaudeTaskToolResult,
  claudeTrackedTasksPayload,
  hasOnlyCompletedClaudeTasks,
  hasUnfinishedClaudeTasks,
  normalizeClaudeTodoTasks,
  parseClaudeTrackedTasks,
  type ClaudeTrackedTask,
} from "../claudeTaskTracker.ts";
import {
  extractClaudeWorkflowAgentPhases,
  extractClaudeWorkflowAgentPlans,
  parseClaudeWorkflowLaunch,
  parseClaudeWorkflowLaunchFromText,
  parseClaudeWorkflowProgressAgents,
  parseClaudeWorkflowScriptMeta,
} from "../claudeWorkflowScript.ts";
import {
  claudeWorkflowRuntimeSnapshots,
  collectClaudeWorkflowRuntime,
  makeClaudeWorkflowRuntimeState,
  readClaudeWorkflowOutputText,
  type ClaudeWorkflowRuntimeState,
} from "../claudeWorkflowRuntime.ts";
import { positiveFiniteNumber } from "../tokenUsage.ts";
import {
  isClaudeAutoModeCliVersionSupported,
  MINIMUM_CLAUDE_AUTO_MODE_CLI_VERSION,
} from "../claudeCliVersion.ts";
import { parseGenericCliVersion } from "../providerMaintenance.ts";
import { makeKeyedLock } from "../keyedLock.ts";
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
import {
  teardownChildProcessTree,
  teardownProviderProcessTree,
  type ProcessExitHandle,
} from "../supervisedProcessTeardown.ts";

const PROVIDER = "claudeAgent" as const;
const CLAUDE_DISCOVERY_THREAD_ID = ThreadId.makeUnsafe("claude:discovery");
type ClaudeTextStreamKind = Extract<RuntimeContentStreamKind, "assistant_text" | "reasoning_text">;
type ClaudeToolResultStreamKind = Extract<
  RuntimeContentStreamKind,
  "command_output" | "file_change_output"
>;

type PromptQueueItem =
  | {
      readonly type: "message";
      readonly message: SDKUserMessage;
    }
  | {
      readonly type: "terminate";
    };

interface ClaudeResumeState {
  readonly claudeCache?: ClaudeCacheObservation;
  readonly threadId?: ThreadId;
  readonly resume?: string;
  readonly resumeSessionAt?: string;
  readonly turnCount?: number;
  readonly trackedTasks?: ReadonlyArray<ClaudeTrackedTask>;
  readonly processedTokenTotal?: number;
  readonly tokenAccountingVersion?: 1;
}

interface ClaudeTurnState {
  readonly turnId: TurnId;
  readonly startedAt: string;
  readonly interactionMode: ProviderInteractionMode;
  // synthetic turns (assistant output with no active turn) are never steered: sendTurn auto-closes them, steerTurn dispatches normally
  readonly synthetic?: true;
  readonly explicitCompaction?: { readonly nativeSessionId: string; boundaryObserved: boolean };
  compactionInProgress?: boolean;
  readonly items: Array<unknown>;
  readonly assistantTextBlocks: Map<number, AssistantTextBlockState>;
  readonly assistantTextBlockOrder: Array<AssistantTextBlockState>;
  readonly capturedProposedPlanKeys: Set<string>;
  readonly sawFileChange: boolean;
  readonly assistantError?: {
    readonly code: SDKAssistantMessageError;
    readonly message: string;
  };
  nextSyntheticAssistantBlockIndex: number;
  // block offset aligns within a single API message; a turn spans many (tool-use round trips, whole subagent conversations)
  assistantMessageBlockBase: number;
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
  readonly settled: Deferred.Deferred<ProviderApprovalDecision>;
  readonly turnId?: TurnId;
  readonly providerItemId?: string;
  readonly agentId?: string;
  settlementStarted: boolean;
}

interface PendingUserInputResult {
  readonly answers: ProviderUserInputAnswers;
  readonly cancelled: boolean;
}

interface PendingUserInput {
  readonly questions: ReadonlyArray<UserInputQuestion>;
  readonly result: Deferred.Deferred<PendingUserInputResult>;
  readonly settled: Deferred.Deferred<PendingUserInputResult>;
  readonly turnId?: TurnId;
  readonly providerItemId?: string;
  readonly agentId?: string;
  settlementStarted: boolean;
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

// subagent traffic keys on the Task tool_use_id; the task_id needed by query.stopTask arrives later via task_started
interface ClaudeSubagentRun {
  readonly toolUseId: string;
  taskId: string | undefined;
  readonly context: ClaudeSessionContext;
}

type ClaudeTokenUsageState = "current" | "skip-compaction-call" | "awaiting-fresh-assistant";

interface ClaudeSessionContext {
  resultUsageBaseline?: ClaudeResultUsageBaseline;
  readonly gatewaySessionLease?: AgentGatewaySessionLease;
  session: ProviderSession;
  readonly lifecycleGeneration?: string;
  readonly promptQueue: Queue.Queue<PromptQueueItem>;
  readonly query: ClaudeQueryRuntime;
  // Spawn-fixed: the Artifact opt-in is an environment variable of this process.
  readonly artifactsEnabled: boolean;
  initToolNames?: ReadonlySet<string>;
  readonly messageStream?: AsyncIterable<SDKMessage>;
  readonly processOwner: ClaudeProcessOwner;
  stopDeferred?: Deferred.Deferred<void, ProviderAdapterProcessError>;
  pendingDispatches?: number;
  streamFiber: Fiber.Fiber<void, Error> | undefined;
  readonly startedAt: string;
  readonly basePermissionMode: PermissionMode | undefined;
  // spawnPermissionMode is the ONLY provable CLI mode — canUseTool is shadowed under bypassPermissions so once any prompt runs the mode is opaque; only the pre-first-prompt skip is safe
  readonly spawnPermissionMode: PermissionMode;
  firstTurnSpawnModeAuthoritative: boolean;
  lastInteractionMode: ProviderInteractionMode | undefined;
  currentApiModelId: string | undefined;
  resumeSessionId: string | undefined;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  // supervised "always allow" covers this live session only; Auto must still route every SDK "ask" through the reviewer/user boundary
  approvalsAlwaysAllowedForSession: boolean;
  readonly pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>;
  readonly turns: Array<{
    id: TurnId;
    items: Array<unknown>;
  }>;
  readonly inFlightTools: Map<number, ToolInFlight>;
  readonly trackedTasks: Map<string, ClaudeTrackedTask>;
  turnState: ClaudeTurnState | undefined;
  // survives turnState being cleared so a terminal result still names its turn — an id-less turn.completed is dropped by ingestion and strands the projection running
  lastTurnId: TurnId | undefined;
  interruptRequestedTurnId: TurnId | undefined;
  lastKnownContextWindow: number | undefined;
  currentAutoCompactWindow: number | undefined;
  currentAlwaysThinkingEnabled: boolean | undefined;
  currentEffort: ClaudeApiEffort | null;
  currentUltracode: boolean;
  currentFastMode: boolean;
  lastKnownAutoCompactThreshold: number | undefined;
  contextUsageControlEnabled: boolean;
  lastKnownTokenUsage: ThreadTokenUsageSnapshot | undefined;
  cacheObservation?: ClaudeCacheObservation | undefined;
  cacheRequestStartedAt?: { messageId: string; at: string };
  hasObservedCacheRequest?: boolean;
  tokenUsageState: ClaudeTokenUsageState;
  compactionMessageId: string | undefined;
  processedTokenTotal: number;
  processedTokenTurnBaseline: number;
  // a synthetic UI turn can close before its result, so every logical completion must advance the baseline
  processedTokenResultBaseline: number;
  processedTokenBaselineKnown: boolean;
  readonly requestUsage: ClaudeRequestUsage;
  lastResultUuid: string | undefined;
  lastAssistantUuid: string | undefined;
  lastThreadStartedId: string | undefined;
  // safeguard-reroute fallback: tracks the in-flight turn only; completion restores the user model so the fallback can't pin later turns
  rerouteOriginalApiModelId: string | undefined;
  // Context-size warnings already emitted for this session (once per threshold).
  readonly emittedContextUsageWarnings: Set<string>;
  stopped: boolean;
  // dedupe unknown SDK message kinds — high-frequency telemetry (thinking_tokens) would otherwise flood the timeline
  readonly warnedUnhandledSdkKinds: Set<string>;
  // Task spawns keyed by tool_use_id; scoped context events carry subagentRefs so ingestion routes to the child thread
  readonly subagentRuns: Map<string, ClaudeSubagentRun>;
  // mid-task user messages queued per tool_use_id, drained by the PreToolUse hook on the subagent's next tool call
  readonly pendingSubagentSteers: Map<string, Array<string>>;
  // stops arriving before task_started maps tool_use_id→task id; fired the moment the mapping lands
  readonly pendingSubagentStops: Set<string>;
  // background_tasks_changed is REPLACE semantics — diff so only newly backgrounded work is announced; background patches never seed the set (they can race the snapshot and suppress its notice)
  readonly knownBackgroundTaskIds: Set<string>;
  // agent-scoped interactions cancel only on provider-terminal evidence or session stop — never merely because the parent turn completed
  readonly terminalTaskIds: Set<string>;
  // late messages tagged with a settled task must not resurrect it (the synthetic turn never completes, pinning "Running"); the status also corrects the error-shaped stop tool_result to "Stopped"
  readonly settledSubagentToolUseIds: Map<string, "completed" | "failed" | "stopped">;
  // no parent-task linkage in the SDK: agent tasks starting while exactly one workflow is live get tagged; concurrent workflows stay untagged
  readonly liveWorkflowTaskIds: Set<string>;
  // workflow identity survives a terminal task_updated until task_notification supplies the authoritative output file
  readonly knownWorkflowTaskIds: Set<string>;
  readonly workflowTaskIdByMemberTaskId: Map<string, string>;
  // agent labels in first-seen order from "<phase>: <label>" progress descriptions; the poller zips them against journal start order
  readonly workflowRuntimePollers: Map<string, Fiber.Fiber<void>>;
  readonly workflowAgentLabels: Map<string, Array<string>>;
  // poller state kept reachable so settle can backfill runtime-only fields (effort) into output-file snapshots
  readonly workflowRuntimeStates: Map<string, ClaudeWorkflowRuntimeState>;
  // subagent-scoped contexts stamp providerThreadId (Task tool_use_id) + providerParentThreadId on every event
  readonly subagentRefs?: {
    readonly providerThreadId: string;
    readonly providerParentThreadId: string;
  };
}

interface ClaudeStopSessionOptions {
  readonly emitExitEvent?: boolean;
  // a terminal message on the stream fiber must close the query and let the stream finish — interrupting that fiber aborts teardown before the session is removed
  readonly interruptStream?: boolean;
}

interface ClaudeQueryRuntime extends AsyncIterable<SDKMessage> {
  readonly interrupt: () => Promise<void>;
  readonly stopTask: (taskId: string) => Promise<void>;
  readonly backgroundTasks: (toolUseId?: string) => Promise<boolean>;
  readonly setModel: (model?: string) => Promise<void>;
  readonly setPermissionMode: (mode: PermissionMode) => Promise<void>;
  readonly setMaxThinkingTokens: (maxThinkingTokens: number | null) => Promise<void>;
  readonly applyFlagSettings: (settings: {
    [K in keyof Settings]?: Settings[K] | null;
  }) => Promise<void>;
  readonly getContextUsage: (options?: {
    readonly detail?: "summary" | "full";
  }) => Promise<SDKControlGetContextUsageResponse>;
  readonly supportedCommands: () => Promise<SlashCommand[]>;
  readonly supportedModels: () => Promise<ModelInfo[]>;
  readonly supportedAgents: () => Promise<AgentInfo[]>;
  readonly close: () => void;
}

function prestartClaudeMessageStream(queryRuntime: ClaudeQueryRuntime): AsyncIterable<SDKMessage> {
  // SDK discovery awaits a handshake that only starts on first iterator read; keep that read for the real consumer while cancellation wins the race
  const iterator = queryRuntime[Symbol.asyncIterator]();
  const firstResult = iterator.next();
  void firstResult.catch(() => undefined);
  const doneResult: IteratorResult<SDKMessage> = { done: true, value: undefined };
  let resolveClosed!: (result: IteratorResult<SDKMessage>) => void;
  const closedResult = new Promise<IteratorResult<SDKMessage>>((resolve) => {
    resolveClosed = resolve;
  });
  let firstResultPending = true;
  let closed = false;

  const raceWithClose = (
    result: Promise<IteratorResult<SDKMessage>>,
  ): Promise<IteratorResult<SDKMessage>> => {
    void result.catch(() => undefined);
    return Promise.race([result, closedResult]);
  };

  const messageIterator: AsyncIterableIterator<SDKMessage> = {
    next: () => {
      if (closed) {
        return Promise.resolve(doneResult);
      }
      const result = firstResultPending ? firstResult : iterator.next();
      firstResultPending = false;
      return raceWithClose(result);
    },
    return: async () => {
      if (!closed) {
        closed = true;
        resolveClosed(doneResult);
        const returnResult = iterator.return?.();
        if (returnResult) {
          void returnResult.catch(() => undefined);
        }
      }
      return doneResult;
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };
  return messageIterator;
}

export type ClaudeOwnedProcess = ClaudeSpawnedProcess & ProcessExitHandle;

interface ClaudeProcessOwner {
  process?: ClaudeOwnedProcess;
}

function spawnOwnedClaudeCodeProcess(options: ClaudeSpawnOptions): ClaudeOwnedProcess {
  return spawnProcess(options.command, options.args, {
    requireExecutable: true,
    ...(options.cwd ? { cwd: options.cwd } : {}),
    env: options.env,
    signal: options.signal,
    stdio: ["pipe", "pipe", "inherit"],
  }) as unknown as ClaudeOwnedProcess;
}

async function readInstalledClaudeCliVersion(input: {
  readonly binaryPath: string;
  readonly cwd?: string;
  readonly env: NodeJS.ProcessEnv;
}): Promise<string | null> {
  return new Promise((resolve, reject) => {
    execProcessFile(
      input.binaryPath,
      ["--version"],
      {
        requireExecutable: true,
        ...(input.cwd ? { cwd: input.cwd } : {}),
        env: input.env,
        timeout: 10_000,
        maxBuffer: 64 * 1024,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(parseGenericCliVersion(`${stdout}\n${stderr}`));
      },
    );
  });
}

export interface ClaudeAdapterLiveOptions {
  readonly createQuery?: (input: {
    readonly prompt: AsyncIterable<SDKUserMessage>;
    readonly options: ClaudeQueryOptions;
  }) => ClaudeQueryRuntime | Promise<ClaudeQueryRuntime>;
  readonly forkNativeSession?: (
    sessionId: string,
    options?: { readonly dir?: string; readonly upToMessageId?: string },
  ) => Promise<{ sessionId: string }>;
  readonly readNativeSessionMessages?: (
    sessionId: string,
    options?: { readonly dir?: string },
  ) => Promise<ReadonlyArray<SessionMessage>>;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
  readonly workflowRuntimePollIntervalMs?: number;
  readonly spawnClaudeCodeProcess?: (options: ClaudeSpawnOptions) => ClaudeOwnedProcess;
  readonly teardownProcessTree?: typeof teardownProviderProcessTree;
  readonly readClaudeCliVersion?: (input: {
    readonly binaryPath: string;
    readonly cwd?: string;
    readonly env: NodeJS.ProcessEnv;
  }) => Promise<string | null>;
}

const CLAUDE_NATIVE_COMMAND_LOOKUP_TIMEOUT_MS = 2_000;
const CLAUDE_ARTIFACT_TOOL_NAME = "Artifact";
// /slides registers only while the Artifact tool is live; used until a session reports its real tool list
const CLAUDE_ARTIFACT_PROBE_COMMAND = "slides";

function resolveClaudeArtifactsState(input: {
  readonly artifactsEnabled: boolean;
  readonly commands: readonly SlashCommand[];
  readonly initToolNames?: ReadonlySet<string> | undefined;
}): ProviderArtifactsState {
  if (!input.artifactsEnabled) return "disabled";
  const available = input.initToolNames
    ? input.initToolNames.has(CLAUDE_ARTIFACT_TOOL_NAME)
    : input.commands.some((command) => command.name === CLAUDE_ARTIFACT_PROBE_COMMAND);
  return available ? "available" : "unavailable";
}

// Claude drops /design+/slides while Artifacts are off — list them so the composer can explain why, only when Claude didn't
const CLAUDE_ARTIFACT_COMMANDS = [
  { name: "design", description: "Make a new Design artifact from a brief" },
  { name: "slides", description: "Make a new Slides deck artifact from a brief" },
] as const;

function mapSupportedCommands(
  commands: SlashCommand[],
  artifacts: ProviderArtifactsState,
): ProviderListCommandsResult {
  const missingArtifactCommands =
    artifacts === "available"
      ? []
      : CLAUDE_ARTIFACT_COMMANDS.filter(
          (known) => !commands.some((command) => command.name === known.name),
        );
  return {
    commands: [
      ...commands.map((cmd) => ({
        name: cmd.name,
        description: cmd.description || undefined,
      })),
      ...missingArtifactCommands,
    ],
    artifacts,
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

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isSyntheticClaudeThreadId(value: string): boolean {
  return value.startsWith("claude-thread-");
}

// hook system messages can carry transient session ids; only durable conversation messages advance the resumable cursor
function hasDurableClaudeSessionId(message: SDKMessage): boolean {
  if (message.type !== "system") {
    return true;
  }

  return (
    message.subtype !== "hook_started" &&
    message.subtype !== "hook_progress" &&
    message.subtype !== "hook_response"
  );
}

function toMessage(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message.length > 0) {
    return cause.message;
  }
  return fallback;
}

type ClaudeAutoModeModelResolution =
  | { readonly status: "matched"; readonly model: ModelInfo }
  | { readonly status: "absent" }
  | { readonly status: "conflicting" };

function stripSupportedClaudeContextWindowQualifier(modelId: string): string {
  const qualifier = getClaudeContextWindowSuffix(modelId);
  return qualifier && Object.hasOwn(CLAUDE_CONTEXT_WINDOW_MAX_TOKENS, qualifier)
    ? stripClaudeContextWindowSuffix(modelId)
    : modelId;
}

function claudeModelIdentifiers(model: ModelInfo): ReadonlyArray<string> {
  return model.resolvedModel === undefined ? [model.value] : [model.value, model.resolvedModel];
}

function resolveClaudeAutoModeModel(
  discoveredModels: ReadonlyArray<ModelInfo>,
  requestedModelIds: ReadonlySet<string>,
): ClaudeAutoModeModelResolution {
  const exactMatch = discoveredModels.find((model) =>
    claudeModelIdentifiers(model).some((identifier) => requestedModelIds.has(identifier)),
  );
  if (exactMatch) {
    return { status: "matched", model: exactMatch };
  }

  const unqualifiedRequestedModelIds = new Set(
    [...requestedModelIds].filter(
      (modelId) => stripSupportedClaudeContextWindowQualifier(modelId) === modelId,
    ),
  );
  const normalizedMatches = discoveredModels.filter((model) =>
    claudeModelIdentifiers(model).some((identifier) =>
      unqualifiedRequestedModelIds.has(stripSupportedClaudeContextWindowQualifier(identifier)),
    ),
  );
  const firstMatch = normalizedMatches[0];
  if (!firstMatch) {
    return { status: "absent" };
  }
  if (normalizedMatches.some((model) => model.supportsAutoMode !== firstMatch.supportsAutoMode)) {
    return { status: "conflicting" };
  }
  return { status: "matched", model: firstMatch };
}

function toError(cause: unknown, fallback: string): Error {
  return cause instanceof Error ? cause : new Error(toMessage(cause, fallback));
}

function normalizeClaudeStreamMessages(cause: Cause.Cause<Error>): ReadonlyArray<string> {
  const errors = Cause.prettyErrors(cause)
    .map((error) => error.message.trim())
    .filter((message) => message.length > 0);
  if (errors.length > 0) {
    return errors;
  }

  const squashed = toMessage(Cause.squash(cause), "").trim();
  return squashed.length > 0 ? [squashed] : [];
}

function isClaudeInterruptedMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("all fibers interrupted without error") ||
    normalized.includes("request was aborted") ||
    normalized.includes("interrupted by user")
  );
}

function isClaudeInterruptedCause(cause: Cause.Cause<Error>): boolean {
  return (
    Cause.hasInterruptsOnly(cause) ||
    normalizeClaudeStreamMessages(cause).some(isClaudeInterruptedMessage)
  );
}

function messageFromClaudeStreamCause(cause: Cause.Cause<Error>, fallback: string): string {
  return normalizeClaudeStreamMessages(cause)[0] ?? fallback;
}

function interruptionMessageFromClaudeCause(cause: Cause.Cause<Error>): string {
  const message = messageFromClaudeStreamCause(cause, "Claude runtime interrupted.");
  return isClaudeInterruptedMessage(message) ? "Claude runtime interrupted." : message;
}

// external SIGINT/SIGTERM surface as "process exited 143" — treat as suspend-and-resume, not a hard failure; SIGKILL excluded (OOM worth surfacing)
const CLAUDE_BENIGN_TERMINATION_EXIT_CODES = new Set([130, 143]);

const CLAUDE_BENIGN_TERMINATION_MESSAGE =
  "Claude runtime stopped and will resume on your next message.";

function isClaudeBenignTerminationMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  const exitCode = normalized.match(/exited with code (\d+)/)?.[1];
  if (exitCode !== undefined) {
    return CLAUDE_BENIGN_TERMINATION_EXIT_CODES.has(Number.parseInt(exitCode, 10));
  }
  return normalized.includes("signal sigterm") || normalized.includes("signal sigint");
}

function isClaudeBenignTerminationCause(cause: Cause.Cause<Error>): boolean {
  return normalizeClaudeStreamMessages(cause).some(isClaudeBenignTerminationMessage);
}

function isClaudeMissingResumeConversationCause(cause: Cause.Cause<Error>): boolean {
  return normalizeClaudeStreamMessages(cause).some((message) =>
    message.toLowerCase().includes("no conversation found with session id"),
  );
}

function resultErrorsText(result: SDKResultMessage): string {
  return "errors" in result && Array.isArray(result.errors)
    ? result.errors.join(" ").toLowerCase()
    : "";
}

function isInterruptedResult(result: SDKResultMessage): boolean {
  const errors = resultErrorsText(result);
  if (errors.includes("interrupt")) {
    return true;
  }

  return (
    result.subtype === "error_during_execution" &&
    result.is_error === false &&
    (errors.includes("request was aborted") ||
      errors.includes("interrupted by user") ||
      errors.includes("aborted"))
  );
}

function hasPendingUserInterrupt(context: ClaudeSessionContext): boolean {
  const activeTurnId = context.turnState?.turnId;
  return activeTurnId !== undefined && context.interruptRequestedTurnId === activeTurnId;
}

function asRuntimeItemId(value: string): RuntimeItemId {
  return RuntimeItemId.makeUnsafe(value);
}

function claudeEffectiveContextBudget(context: ClaudeSessionContext): number | undefined {
  return resolveClaudeEffectiveContextBudget(
    context.lastKnownAutoCompactThreshold,
    context.currentAutoCompactWindow,
    context.lastKnownContextWindow,
  );
}

// safeguard reroutes stream as untyped system messages — match structurally so SDK type drift stays inert
interface ClaudeModelRefusalFallback {
  readonly originalModel: string;
  readonly fallbackModel: string;
  readonly content?: string;
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function readClaudeModelRefusalFallback(message: unknown): ClaudeModelRefusalFallback | undefined {
  if (!message || typeof message !== "object") {
    return undefined;
  }
  const record = message as {
    type?: unknown;
    subtype?: unknown;
    original_model?: unknown;
    fallback_model?: unknown;
    originalModel?: unknown;
    fallbackModel?: unknown;
    content?: unknown;
  };
  if (record.type !== "system" || record.subtype !== "model_refusal_fallback") {
    return undefined;
  }
  // SDK 0.3.x emits snake_case; accept camelCase too so a typed projection can't silently disable reroute protection
  const originalModel =
    readNonEmptyString(record.original_model) ?? readNonEmptyString(record.originalModel);
  const fallbackModel =
    readNonEmptyString(record.fallback_model) ?? readNonEmptyString(record.fallbackModel);
  if (!originalModel || !fallbackModel) {
    return undefined;
  }
  return {
    originalModel,
    fallbackModel,
    ...(typeof record.content === "string" && record.content.trim().length > 0
      ? { content: record.content }
      : {}),
  };
}

// VCS transitions stream as untyped system messages — match structurally
interface ClaudeVcsStateChange {
  readonly kind?: string;
  readonly cwd?: string;
}

function readClaudeVcsStateChange(message: unknown): ClaudeVcsStateChange | undefined {
  if (!message || typeof message !== "object") {
    return undefined;
  }
  const record = message as {
    type?: unknown;
    subtype?: unknown;
    kind?: unknown;
    cwd?: unknown;
  };
  if (record.type !== "system" || record.subtype !== "vcs_state_changed") {
    return undefined;
  }
  const kind = readNonEmptyString(record.kind);
  const cwd = readNonEmptyString(record.cwd);
  return {
    ...(kind !== undefined ? { kind } : {}),
    ...(cwd !== undefined ? { cwd } : {}),
  };
}

const DEFAULT_WORKFLOW_RUNTIME_POLL_INTERVAL_MS = 2_000;
const WORKFLOW_AGENTS_PROGRESS_DESCRIPTION = "Workflow agents";

function resolveSelectedClaudeThinkingToggle(
  model: string | null | undefined,
  selectedThinking: boolean | null | undefined,
): boolean | undefined {
  if (typeof selectedThinking !== "boolean") {
    return undefined;
  }
  return getModelCapabilities("claudeAgent", model).supportsThinkingToggle
    ? selectedThinking
    : undefined;
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

function mapClaudeModelInfo(model: ModelInfo): ProviderListModelsResult["models"][number] {
  const optionDescriptors = getProviderOptionDescriptors({
    provider: PROVIDER,
    caps: getModelCapabilities(PROVIDER, model.resolvedModel ?? model.value),
  });
  return {
    slug: model.value,
    ...(model.resolvedModel ? { resolvedModel: model.resolvedModel } : {}),
    name: model.displayName,
    ...(optionDescriptors.length > 0 ? { optionDescriptors } : {}),
    ...(typeof model.supportsAutoMode === "boolean"
      ? { supportsAutoMode: model.supportsAutoMode }
      : {}),
  };
}

function readClaudeResumeState(resumeCursor: unknown): ClaudeResumeState | undefined {
  if (!resumeCursor || typeof resumeCursor !== "object") {
    return undefined;
  }
  const cursor = resumeCursor as {
    threadId?: unknown;
    resume?: unknown;
    sessionId?: unknown;
    resumeSessionAt?: unknown;
    turnCount?: unknown;
    trackedTasks?: unknown;
    processedTokenTotal?: unknown;
    tokenAccountingVersion?: unknown;
    claudeCache?: unknown;
  };

  const threadIdCandidate = typeof cursor.threadId === "string" ? cursor.threadId : undefined;
  const threadId =
    threadIdCandidate && !isSyntheticClaudeThreadId(threadIdCandidate)
      ? ThreadId.makeUnsafe(threadIdCandidate)
      : undefined;
  const resumeCandidate =
    typeof cursor.resume === "string"
      ? cursor.resume
      : typeof cursor.sessionId === "string"
        ? cursor.sessionId
        : undefined;
  const resume = resumeCandidate && isUuid(resumeCandidate) ? resumeCandidate : undefined;
  const resumeSessionAt =
    typeof cursor.resumeSessionAt === "string" ? cursor.resumeSessionAt : undefined;
  const turnCountValue = typeof cursor.turnCount === "number" ? cursor.turnCount : undefined;
  const trackedTasks = parseClaudeTrackedTasks(cursor.trackedTasks);
  const processedTokenTotal =
    typeof cursor.processedTokenTotal === "number" &&
    Number.isSafeInteger(cursor.processedTokenTotal) &&
    cursor.processedTokenTotal >= 0
      ? cursor.processedTokenTotal
      : undefined;

  return {
    ...(Schema.is(ClaudeCacheObservation)(cursor.claudeCache) &&
    cursor.claudeCache.nativeSessionId === resume
      ? { claudeCache: cursor.claudeCache }
      : {}),
    ...(threadId ? { threadId } : {}),
    ...(resume ? { resume } : {}),
    ...(resumeSessionAt ? { resumeSessionAt } : {}),
    ...(turnCountValue !== undefined && Number.isInteger(turnCountValue) && turnCountValue >= 0
      ? { turnCount: turnCountValue }
      : {}),
    ...(trackedTasks.length > 0 ? { trackedTasks } : {}),
    ...(processedTokenTotal !== undefined && cursor.tokenAccountingVersion === 1
      ? { processedTokenTotal, tokenAccountingVersion: 1 as const }
      : {}),
  };
}

function withoutProcessedTokenTotal(snapshot: ThreadTokenUsageSnapshot): ThreadTokenUsageSnapshot {
  const { totalProcessedTokens: _totalProcessedTokens, ...contextUsage } = snapshot;
  return contextUsage;
}

function invalidateClaudeCache(context: ClaudeSessionContext): void {
  delete context.cacheObservation;
  delete context.cacheRequestStartedAt;
  context.hasObservedCacheRequest = false;
  if (context.lastKnownTokenUsage?.claudeCache) {
    const { claudeCache: _claudeCache, ...usage } = context.lastKnownTokenUsage;
    context.lastKnownTokenUsage = usage;
  }
}

function syncClaudeCacheResumeCursor(context: ClaudeSessionContext): void {
  const { claudeCache: _previous, ...resumeCursor } = context.session.resumeCursor as Record<
    string,
    unknown
  >;
  // cache observations can precede the first SDK message — preserve saved transcript counters rather than deriving from unloaded turns
  context.session = {
    ...context.session,
    resumeCursor: {
      ...resumeCursor,
      ...(context.cacheObservation ? { claudeCache: context.cacheObservation } : {}),
    },
  };
}

function hasActiveClaudeRuntimeWork(context: ClaudeSessionContext): boolean {
  return (
    context.turnState !== undefined ||
    context.knownBackgroundTaskIds.size > 0 ||
    context.liveWorkflowTaskIds.size > 0 ||
    context.pendingApprovals.size > 0 ||
    context.pendingUserInputs.size > 0 ||
    Array.from(context.subagentRuns.values()).some((run) => run.context.turnState !== undefined)
  );
}

// Persistent TODOs block compaction but survive restart through the resume cursor.
function hasActiveClaudeCompactionWork(context: ClaudeSessionContext): boolean {
  return hasActiveClaudeRuntimeWork(context) || hasUnfinishedClaudeTasks(context.trackedTasks);
}

function classifyToolItemType(toolName: string): CanonicalItemType {
  const normalized = toolName.toLowerCase();
  if (
    normalized === "todowrite" ||
    normalized.includes("todo") ||
    normalized === "taskcreate" ||
    normalized === "taskupdate" ||
    normalized === "taskget" ||
    normalized === "tasklist"
  ) {
    return "plan";
  }
  if (normalized.includes("agent")) {
    return "collab_agent_tool_call";
  }
  if (
    normalized === "task" ||
    normalized === "agent" ||
    normalized.includes("subagent") ||
    normalized.includes("sub-agent")
  ) {
    return "collab_agent_tool_call";
  }
  if (
    normalized.includes("bash") ||
    normalized.includes("command") ||
    normalized.includes("shell") ||
    normalized.includes("terminal")
  ) {
    return "command_execution";
  }
  if (
    normalized.includes("edit") ||
    normalized.includes("write") ||
    normalized.includes("file") ||
    normalized.includes("patch") ||
    normalized.includes("replace") ||
    normalized.includes("create") ||
    normalized.includes("delete")
  ) {
    return "file_change";
  }
  if (normalized.includes("mcp")) {
    return "mcp_tool_call";
  }
  if (normalized.includes("websearch") || normalized.includes("web search")) {
    return "web_search";
  }
  if (normalized.includes("image")) {
    return "image_view";
  }
  return "dynamic_tool_call";
}

function isReadOnlyToolName(toolName: string): boolean {
  const normalized = toolName.toLowerCase();
  return (
    normalized === "read" ||
    normalized.includes("read file") ||
    normalized.includes("view") ||
    normalized.includes("grep") ||
    normalized.includes("glob") ||
    normalized.includes("search")
  );
}

function classifyRequestType(toolName: string): CanonicalRequestType {
  if (isReadOnlyToolName(toolName)) {
    return "file_read_approval";
  }
  const itemType = classifyToolItemType(toolName);
  return itemType === "command_execution"
    ? "command_execution_approval"
    : itemType === "file_change"
      ? "file_change_approval"
      : "dynamic_tool_call";
}

function summarizeToolRequest(
  toolName: string,
  input: Record<string, unknown>,
  serializedInput = JSON.stringify(input),
): string {
  const commandValue = input.command ?? input.cmd;
  const command = typeof commandValue === "string" ? commandValue : undefined;
  if (command && command.trim().length > 0) {
    return `${toolName}: ${command.trim().slice(0, 400).trimEnd()}`;
  }
  if (serializedInput.length <= 400) {
    return `${toolName}: ${serializedInput}`;
  }
  return `${toolName}: ${serializedInput.slice(0, 397)}...`;
}

// tools with a dedicated runtime channel (AskUserQuestion→user-input, ExitPlanMode→proposed-plan) must not also emit a generic lifecycle row
function isClientSurfacedClaudeTool(toolName: string): boolean {
  return toolName === "AskUserQuestion" || toolName === "ExitPlanMode";
}

// stable per-call identity on every lifecycle event so the client collapses/dedupes by tool-call id, not row adjacency
function toolLifecycleEventData(
  tool: Pick<ToolInFlight, "itemId" | "toolName" | "input">,
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    toolCallId: tool.itemId,
    callId: tool.itemId,
    toolName: tool.toolName,
    input: tool.input,
    ...(tool.toolName === "Task" || tool.toolName === "Agent" ? subagentReceiverData(tool) : {}),
    ...extra,
  };
}

function subagentReceiverData(
  tool: Pick<ToolInFlight, "itemId" | "input">,
): Record<string, unknown> {
  const {
    subagent_type: subagentType,
    description,
    prompt,
    model,
    run_in_background: runInBackground,
  } = tool.input;
  const effort =
    typeof subagentType === "string" ? claudeWorkerEffortFromSubagentType(subagentType) : undefined;
  return {
    receiverThreadId: tool.itemId,
    ...(typeof subagentType === "string" ? { agentType: subagentType } : {}),
    ...(typeof description === "string" ? { nickname: description } : {}),
    ...(typeof prompt === "string" ? { prompt } : {}),
    ...(typeof model === "string" ? { model } : {}),
    ...(effort ? { effort } : {}),
    ...(runInBackground === true ? { background: true } : {}),
  };
}

function titleForTool(itemType: CanonicalItemType): string {
  switch (itemType) {
    case "plan":
      return "Plan";
    case "command_execution":
      return "Command run";
    case "file_change":
      return "File change";
    case "mcp_tool_call":
      return "MCP tool call";
    case "collab_agent_tool_call":
      return "Subagent task";
    case "web_search":
      return "Web search";
    case "image_view":
      return "Image view";
    case "dynamic_tool_call":
      return "Tool call";
    default:
      return "Item";
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
const CLAUDE_CONTEXT_USAGE_TIMEOUT_MS = 1_000;
// the SDK interrupt resolves only once the CLI acks — a wedged CLI would stall the caller forever without this bound
const CLAUDE_INTERRUPT_TIMEOUT = Duration.seconds(10);
export const buildEmbeddedClaudeSystemPromptAppend = (gatewayControlAvailable: boolean) =>
  [
    "You are running inside Synara, a coding app that embeds the Claude Agent SDK.",
    "Do not present the host app as Claude Code unless the user is explicitly asking about Claude Code.",
    "Treat the current working directory as the active workspace for the task.",
    "When the user asks about the current project, codebase, or repository, proactively inspect files in the current working directory before asking the user where to look.",
    "When spawning subagents, set the Agent tool's `model` parameter and pick reasoning effort by choosing a worker-<tier> subagent type (worker-low, worker-medium, worker-high, worker-xhigh).",
    "Honor explicit user instructions about a subagent's model or effort verbatim; otherwise match task complexity: mechanical work → haiku or worker-low, standard work → sonnet or worker-medium, hard reasoning → opus or fable with worker-high and above.",
    renderSynaraHarnessPolicy({
      gatewayControlAvailable,
      automationAuthoring: "tool-descriptions",
    }),
  ].join("\n");

const CLAUDE_WORKER_EFFORT_TIERS = ["low", "medium", "high", "xhigh"] as const;
const CLAUDE_WORKER_PROMPT =
  "You are a general-purpose worker agent. Complete the assigned task end to end with the available tools, then return a concise report covering what you did, key findings, and any remaining risks.";

function claudeWorkerEffortFromSubagentType(subagentType: string): string | undefined {
  return (CLAUDE_WORKER_EFFORT_TIERS as readonly string[]).find(
    (tier) => subagentType === `worker-${tier}`,
  );
}

function claudeSubagentSteerContext(message: string): string {
  return `The user sent you a message mid-task: ${message}. Address it and adjust your work accordingly.`;
}

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

  // Agent tool input has `model` but no `effort` — effort is picked via worker type, model stays inherit so the tool input composes
  for (const tier of CLAUDE_WORKER_EFFORT_TIERS) {
    const agentName = `worker-${tier}`;
    if (agents[agentName]) {
      continue;
    }
    agents[agentName] = {
      description: `General-purpose worker at ${tier} reasoning effort; choose per task complexity`,
      prompt: CLAUDE_WORKER_PROMPT,
      effort: tier,
    };
  }

  return agents;
}

function isClaudeCompactionCommand(text: string | undefined): boolean {
  return /^\/compact(?:\s|$)/.test(text?.trim() ?? "");
}

// `/name` + whitespace/end is a command; a path like /Users/me/x stays model input, and without the command list the shape alone decides
function isClaudeNativeSlashCommand(
  text: string | undefined,
  nativeCommandNames?: ReadonlySet<string>,
): boolean {
  const name = /^\/([a-z][\w:-]*)(?:\s|$)/i.exec(text?.trim() ?? "")?.[1];
  if (name === undefined) return false;
  if (nativeCommandNames === undefined || nativeCommandNames.size === 0) return true;
  return nativeCommandNames.has(name) || isClaudeCompactionCommand(text);
}

function buildPromptText(
  input: ProviderSendTurnInput,
  nativeCommandNames?: ReadonlySet<string>,
): string {
  // native slash commands must start the payload — a prefix turns them into uncallable model input
  if (isClaudeNativeSlashCommand(input.input, nativeCommandNames)) return input.input!.trim();
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
    readonly nativeCommandNames?: ReadonlySet<string> | undefined;
  },
): Effect.Effect<SDKUserMessage, ProviderAdapterRequestError> {
  return Effect.gen(function* () {
    const text = buildPromptText(input, dependencies.nativeCommandNames);
    const sdkContent: Array<Record<string, unknown>> = [];

    if (text.length > 0) {
      sdkContent.push({ type: "text", text });
    }

    for (const attachment of input.attachments ?? []) {
      if (attachment.type !== "image") {
        continue;
      }

      if (!SUPPORTED_CLAUDE_IMAGE_MIME_TYPES.has(attachment.mimeType.toLowerCase())) {
        continue;
      }

      const attachmentPath = resolveProviderAttachmentPath({
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
          mimeType: attachment.mimeType.toLowerCase(),
          bytes,
        }),
      );
    }

    const fileBlock = buildFileAttachmentsPromptBlock({
      attachments: input.attachments,
      attachmentsDir: dependencies.attachmentsDir,
      include: "all-files",
      includeImage: (attachment) =>
        !SUPPORTED_CLAUDE_IMAGE_MIME_TYPES.has(attachment.mimeType.toLowerCase()),
    });
    if (fileBlock) {
      sdkContent.push({ type: "text", text: fileBlock });
    }

    return buildUserMessage({ sdkContent });
  });
}

function turnStatusFromResult(result: SDKResultMessage): ProviderRuntimeTurnStatus {
  if (result.subtype === "success") {
    return "completed";
  }

  const errors = resultErrorsText(result);
  if (isInterruptedResult(result)) {
    return "interrupted";
  }
  if (errors.includes("cancel")) {
    return "cancelled";
  }
  return "failed";
}

function streamKindFromDeltaType(deltaType: string): ClaudeTextStreamKind {
  return deltaType.includes("thinking") ? "reasoning_text" : "assistant_text";
}

function nativeProviderRefs(
  context: ClaudeSessionContext,
  options?: {
    readonly providerItemId?: string | undefined;
  },
): NonNullable<ProviderRuntimeEvent["providerRefs"]> {
  return {
    ...context.subagentRefs,
    ...(options?.providerItemId
      ? { providerItemId: ProviderItemId.makeUnsafe(options.providerItemId) }
      : {}),
  };
}

function extractAssistantTextBlocks(message: SDKMessage): Array<string> {
  if (message.type !== "assistant") {
    return [];
  }

  const content = (message.message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) {
    return [];
  }

  const fragments: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const candidate = block as { type?: unknown; text?: unknown };
    const sanitizedText =
      candidate.type === "text" && typeof candidate.text === "string"
        ? sanitizeClaudeDisplayText(candidate.text)
        : "";
    if (candidate.type === "text" && sanitizedText.length > 0) {
      fragments.push(sanitizedText);
    }
  }

  return fragments;
}

function sanitizeClaudeDisplayText(text: string): string {
  if (text.length === 0) {
    return text;
  }

  const lines = text.split(/\r?\n/);
  const filteredLines = lines.filter((line) => {
    const normalized = line.trim().toLowerCase();
    return !(
      normalized.startsWith("[ede_diagnostic]") &&
      normalized.includes("result_type=") &&
      normalized.includes("stop_reason=")
    );
  });

  if (
    filteredLines.length === 0 &&
    lines.some((line) => line.trim().toLowerCase().startsWith("[ede_diagnostic]"))
  ) {
    return "";
  }

  return filteredLines.join("\n");
}

function normalizeClaudeUserVisibleErrorMessage(
  text: string | undefined,
  status: ProviderRuntimeTurnStatus,
): string | undefined {
  if (typeof text !== "string") {
    return undefined;
  }

  const sanitized = sanitizeClaudeDisplayText(text).trim();
  if (sanitized.length === 0) {
    return undefined;
  }

  if (sanitized === "User interrupted response.") {
    return status === "interrupted" ? "Claude runtime interrupted." : undefined;
  }

  if (/^[\]})"'`.,;:!?_-]+$/.test(sanitized)) {
    return status === "interrupted" ? "Claude runtime interrupted." : "Claude turn failed.";
  }

  return sanitized;
}

function claudeAssistantErrorMessage(error: SDKAssistantMessageError): string {
  switch (error) {
    case "authentication_failed":
      return "Claude is not authenticated. Run `claude auth login --claudeai`, then retry.";
    case "oauth_org_not_allowed":
      return "Claude authentication succeeded, but this organization does not allow Claude Code.";
    case "account_on_hold":
      return "The active Claude account is on hold. Resolve the account issue, then retry.";
    case "billing_error":
      return "Claude billing or subscription access failed. Check the active Claude account, then retry.";
    case "rate_limit":
      return "Claude rate limit reached. Wait briefly, then retry.";
    case "overloaded":
      return "Claude is temporarily overloaded. Retry in a moment.";
    case "invalid_request":
      return "Claude rejected the request as invalid.";
    case "model_not_found":
      return "The selected Claude model is unavailable for this account.";
    case "server_error":
      return "Claude returned a server error. Retry in a moment.";
    case "max_output_tokens":
      return "Claude reached the maximum output length before completing the turn.";
    case "unknown":
      return "Claude failed to complete the turn.";
  }
}

function claudeAssistantErrorRequiresProcessRestart(error: SDKAssistantMessageError): boolean {
  return (
    error === "authentication_failed" ||
    error === "oauth_org_not_allowed" ||
    error === "account_on_hold" ||
    error === "billing_error"
  );
}

function extractContentBlockText(block: unknown): string {
  if (!block || typeof block !== "object") {
    return "";
  }

  const candidate = block as { type?: unknown; text?: unknown };
  return candidate.type === "text" && typeof candidate.text === "string"
    ? sanitizeClaudeDisplayText(candidate.text)
    : "";
}

function extractTextContent(value: unknown): string {
  if (typeof value === "string") {
    return sanitizeClaudeDisplayText(value);
  }

  if (Array.isArray(value)) {
    return value.map((entry) => extractTextContent(entry)).join("");
  }

  if (!value || typeof value !== "object") {
    return "";
  }

  const record = value as {
    text?: unknown;
    content?: unknown;
  };

  if (typeof record.text === "string") {
    return sanitizeClaudeDisplayText(record.text);
  }

  return extractTextContent(record.content);
}

function extractExitPlanModePlan(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const record = value as {
    plan?: unknown;
  };
  return typeof record.plan === "string" && record.plan.trim().length > 0
    ? record.plan.trim()
    : undefined;
}

function exitPlanCaptureKey(input: {
  readonly toolUseId?: string | undefined;
  readonly planMarkdown: string;
}): string {
  return input.toolUseId && input.toolUseId.length > 0
    ? `tool:${input.toolUseId}`
    : `plan:${input.planMarkdown}`;
}

interface ParsedJsonRecord {
  readonly value: Record<string, unknown>;
  readonly serialized: string;
}

function tryParseCompleteJsonRecord(value: string): ParsedJsonRecord | undefined {
  if (!value.trimEnd().endsWith("}")) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    return {
      value: parsed as Record<string, unknown>,
      serialized: JSON.stringify(parsed),
    };
  } catch {
    return undefined;
  }
}

function toolInputFingerprint(input: Record<string, unknown>): string | undefined {
  try {
    return JSON.stringify(input);
  } catch {
    return undefined;
  }
}

function toolResultStreamKind(itemType: CanonicalItemType): ClaudeToolResultStreamKind | undefined {
  switch (itemType) {
    case "command_execution":
      return "command_output";
    case "file_change":
      return "file_change_output";
    default:
      return undefined;
  }
}

function toolResultBlocksFromUserMessage(message: SDKMessage): Array<{
  readonly toolUseId: string;
  readonly block: Record<string, unknown>;
  readonly text: string;
  readonly isError: boolean;
  readonly structuredResult: unknown;
}> {
  if (message.type !== "user") {
    return [];
  }

  const content = (message.message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) {
    return [];
  }

  const blocks: Array<{
    readonly toolUseId: string;
    readonly block: Record<string, unknown>;
    readonly text: string;
    readonly isError: boolean;
    readonly structuredResult: unknown;
  }> = [];

  for (const entry of content) {
    if (!entry || typeof entry !== "object") {
      continue;
    }

    const block = entry as Record<string, unknown>;
    if (block.type !== "tool_result") {
      continue;
    }

    const toolUseId = typeof block.tool_use_id === "string" ? block.tool_use_id : undefined;
    if (!toolUseId) {
      continue;
    }

    blocks.push({
      toolUseId,
      block,
      text: extractTextContent(block.content),
      isError: block.is_error === true,
      structuredResult: message.tool_use_result,
    });
  }

  return blocks;
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

function sdkMessageType(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as { type?: unknown };
  return typeof record.type === "string" ? record.type : undefined;
}

function sdkMessageSubtype(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as { subtype?: unknown };
  return typeof record.subtype === "string" ? record.subtype : undefined;
}

function sdkNativeMethod(message: SDKMessage): string {
  const subtype = sdkMessageSubtype(message);
  if (subtype) {
    return `claude/${message.type}/${subtype}`;
  }

  if (message.type === "stream_event") {
    const streamType = sdkMessageType(message.event);
    if (streamType) {
      const deltaType =
        streamType === "content_block_delta"
          ? sdkMessageType((message.event as { delta?: unknown }).delta)
          : undefined;
      if (deltaType) {
        return `claude/${message.type}/${streamType}/${deltaType}`;
      }
      return `claude/${message.type}/${streamType}`;
    }
  }

  return `claude/${message.type}`;
}

function sdkNativeItemId(message: SDKMessage): string | undefined {
  if (message.type === "assistant") {
    const maybeId = (message.message as { id?: unknown }).id;
    if (typeof maybeId === "string") {
      return maybeId;
    }
    return undefined;
  }

  if (message.type === "user") {
    return toolResultBlocksFromUserMessage(message)[0]?.toolUseId;
  }

  if (message.type === "stream_event") {
    const event = message.event as {
      type?: unknown;
      content_block?: { id?: unknown };
    };
    if (event.type === "content_block_start" && typeof event.content_block?.id === "string") {
      return event.content_block.id;
    }
  }

  return undefined;
}

function parentToolUseId(message: SDKMessage): string | undefined {
  if (
    message.type !== "assistant" &&
    message.type !== "user" &&
    message.type !== "stream_event" &&
    message.type !== "tool_progress"
  ) {
    return undefined;
  }
  return typeof message.parent_tool_use_id === "string" && message.parent_tool_use_id.length > 0
    ? message.parent_tool_use_id
    : undefined;
}

function isRecognizedSubagentToolUseId(context: ClaudeSessionContext, toolUseId: string): boolean {
  if (context.subagentRuns.has(toolUseId) || context.settledSubagentToolUseIds.has(toolUseId)) {
    return true;
  }
  for (const tool of context.inFlightTools.values()) {
    if (tool.itemId === toolUseId && tool.itemType === "collab_agent_tool_call") {
      return true;
    }
  }
  return false;
}

function recognizedSubagentParentToolUseId(
  context: ClaudeSessionContext,
  message: SDKMessage,
): string | undefined {
  const toolUseId = parentToolUseId(message);
  return toolUseId && isRecognizedSubagentToolUseId(context, toolUseId) ? toolUseId : undefined;
}

function claudeTaskTurnStatus(
  status: "completed" | "failed" | "stopped",
): ProviderRuntimeTurnStatus {
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "stopped":
      return "interrupted";
  }
}

function runtimeSessionStateFromClaudeTaskStatus(
  status: string | undefined,
): RuntimeSessionState | undefined {
  switch (status) {
    case "pending":
      return "starting";
    case "running":
      return "running";
    case "paused":
      return "waiting";
    case "completed":
      return "ready";
    case "failed":
      return "error";
    case "killed":
      return "stopped";
    default:
      return undefined;
  }
}

function subagentRunForTask(
  context: ClaudeSessionContext,
  toolUseId: string | undefined,
  taskId: string,
): ClaudeSubagentRun | undefined {
  const run = toolUseId ? context.subagentRuns.get(toolUseId) : undefined;
  if (run) {
    run.taskId ??= taskId;
    return run;
  }
  for (const candidate of context.subagentRuns.values()) {
    if (candidate.taskId === taskId) {
      return candidate;
    }
  }
  return undefined;
}

function makeClaudeAdapter(options?: ClaudeAdapterLiveOptions) {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const serverConfig = yield* ServerConfig;
    const agentGatewayCredentials = Option.getOrUndefined(
      yield* Effect.serviceOption(AgentGatewayCredentials),
    );
    const nativeEventLogger =
      options?.nativeEventLogger ??
      (options?.nativeEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, {
            stream: "native",
          })
        : undefined);

    // the Agent SDK is imported on first query construction so boots that never open Claude never pay for it
    const createQuery = async (input: {
      readonly prompt: AsyncIterable<SDKUserMessage>;
      readonly options: ClaudeQueryOptions;
    }): Promise<ClaudeQueryRuntime> => {
      const override = options?.createQuery;
      if (override) {
        return override(input);
      }
      const { query } = await loadClaudeAgentSdk();
      return query({ prompt: input.prompt, options: input.options }) as ClaudeQueryRuntime;
    };
    const forkNativeSession = async (
      sessionId: string,
      forkOptions?: { readonly dir?: string; readonly upToMessageId?: string },
    ): Promise<{ sessionId: string }> => {
      const override = options?.forkNativeSession;
      if (override) {
        return override(sessionId, forkOptions);
      }
      const { forkSession } = await loadClaudeAgentSdk();
      return forkSession(sessionId, forkOptions);
    };
    const spawnClaudeProcess = options?.spawnClaudeCodeProcess ?? spawnOwnedClaudeCodeProcess;
    const teardownProcessTree = options?.teardownProcessTree ?? teardownProviderProcessTree;
    const readClaudeCliVersion = options?.readClaudeCliVersion ?? readInstalledClaudeCliVersion;

    const sessions = new Map<ThreadId, ClaudeSessionContext>();
    const failedStartupProcessOwners = new Map<ThreadId, ClaudeProcessOwner>();
    const failedDiscoveryProcessOwners = new Set<ClaudeProcessOwner>();
    const sessionLifecycleLock = makeKeyedLock<ThreadId>();
    let cachedModels: ProviderListModelsResult | null = null;
    let cachedAgents: ProviderListAgentsResult | null = null;
    const verifyClaudeAutoModelSupport = (input: {
      readonly queryRuntime: ClaudeQueryRuntime;
      readonly selectedModel: string | undefined;
      readonly apiModelId: string | undefined;
      readonly operation: "startSession" | "sendTurn";
    }) =>
      Effect.gen(function* () {
        const requestedModel = input.selectedModel ?? input.apiModelId ?? "selected model";
        const discoveredModels = yield* Effect.tryPromise({
          try: () => input.queryRuntime.supportedModels(),
          catch: (cause) =>
            new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: input.operation,
              issue:
                `Claude model capability discovery failed while verifying Auto mode support for "${requestedModel}": ` +
                toMessage(cause, "unknown discovery error"),
            }),
        }).pipe(
          // cold-start discovery gets nearly the full 60s startup budget; live model switches keep a short bound
          Effect.timeout(Duration.seconds(input.operation === "startSession" ? 55 : 5)),
          Effect.mapError((cause) =>
            cause instanceof ProviderAdapterValidationError
              ? cause
              : new ProviderAdapterValidationError({
                  provider: PROVIDER,
                  operation: input.operation,
                  issue: `Could not verify that Claude model "${requestedModel}" supports Auto mode before the model discovery timeout.`,
                }),
          ),
        );
        cachedModels = {
          models: discoveredModels.map(mapClaudeModelInfo),
          source: "sdk",
          cached: false,
        };
        const requestedModels = new Set(
          [input.selectedModel, input.apiModelId].filter(
            (model): model is string => model !== undefined,
          ),
        );
        const resolution = resolveClaudeAutoModeModel(discoveredModels, requestedModels);
        if (resolution.status === "absent") {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: input.operation,
            issue: `Claude model "${requestedModel}" was not returned by Claude model discovery, so Auto mode support cannot be verified.`,
          });
        }
        if (resolution.status === "conflicting") {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: input.operation,
            issue: `Claude model "${requestedModel}" has conflicting Auto mode capability metadata across context-window variants.`,
          });
        }
        if (resolution.model.supportsAutoMode !== true) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: input.operation,
            issue: `Claude model "${resolution.model.displayName}" does not support Auto mode.`,
          });
        }
      });
    const runtimeEventQueue = yield* Queue.bounded<ProviderRuntimeEvent>(
      PROVIDER_ADAPTER_RUNTIME_EVENT_BUFFER_CAPACITY,
    );

    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const cacheClock = yield* Clock.Clock;
    const nextEventId = Effect.map(Random.nextUUIDv4, (id) => EventId.makeUnsafe(id));
    const makeEventStamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso });
    const withSessionLifecycleLock = sessionLifecycleLock.withLock;
    const resolveClaudeSdkEnv = Effect.sync(() =>
      buildClaudeProcessEnv({ homeDir: serverConfig.homeDir }),
    );

    const bindClaudeProcessOwner =
      (owner: ClaudeProcessOwner) =>
      (spawnOptions: ClaudeSpawnOptions): ClaudeSpawnedProcess => {
        const process = spawnClaudeProcess(spawnOptions);
        owner.process = process;
        return process;
      };

    const teardownClaudeProcess = (
      threadId: ThreadId,
      owner: ClaudeProcessOwner,
    ): Effect.Effect<void, ProviderAdapterProcessError> => {
      const process = owner.process;
      if (!process) {
        return Effect.void;
      }
      return Effect.tryPromise({
        try: () => teardownChildProcessTree(process, teardownProcessTree),
        catch: (cause) =>
          new ProviderAdapterProcessError({
            provider: PROVIDER,
            threadId,
            detail: toMessage(cause, "Failed to prove Claude process-tree exit."),
            cause,
          }),
      }).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            if (owner.process === process) {
              delete owner.process;
            }
          }),
        ),
        Effect.asVoid,
      );
    };
    const teardownFailedStartupProcess = Effect.fnUntraced(function* (
      threadId: ThreadId,
      owner: ClaudeProcessOwner,
    ) {
      yield* teardownClaudeProcess(threadId, owner).pipe(
        Effect.tapError(() =>
          Effect.sync(() => {
            if (owner.process) failedStartupProcessOwners.set(threadId, owner);
          }),
        ),
      );
      if (failedStartupProcessOwners.get(threadId) === owner) {
        failedStartupProcessOwners.delete(threadId);
      }
    });
    const teardownFailedDiscoveryProcesses = () =>
      Effect.forEach(
        failedDiscoveryProcessOwners,
        (owner) =>
          teardownClaudeProcess(CLAUDE_DISCOVERY_THREAD_ID, owner).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                failedDiscoveryProcessOwners.delete(owner);
              }),
            ),
          ),
        { discard: true },
      );
    const teardownDiscoveryProcess = (owner: ClaudeProcessOwner) =>
      teardownClaudeProcess(CLAUDE_DISCOVERY_THREAD_ID, owner).pipe(
        Effect.tapError(() =>
          Effect.sync(() => {
            if (owner.process) {
              failedDiscoveryProcessOwners.add(owner);
            }
          }),
        ),
      );

    const offerRuntimeEvent = (
      context: ClaudeSessionContext,
      event: ProviderRuntimeEvent,
    ): Effect.Effect<void> =>
      Queue.offer(runtimeEventQueue, {
        ...event,
        ...(context.lifecycleGeneration !== undefined
          ? { lifecycleGeneration: context.lifecycleGeneration }
          : {}),
      }).pipe(Effect.asVoid);

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

    const updateResumeCursor = (
      context: ClaudeSessionContext,
      updatedAt?: string,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const timestamp = updatedAt ?? (yield* nowIso);
        const threadId = context.session.threadId;
        if (!threadId) return;

        const resumeCursor = {
          ...(context.cacheObservation ? { claudeCache: context.cacheObservation } : {}),
          threadId,
          ...(context.resumeSessionId ? { resume: context.resumeSessionId } : {}),
          ...(context.lastAssistantUuid ? { resumeSessionAt: context.lastAssistantUuid } : {}),
          turnCount: context.turns.length,
          ...(context.trackedTasks.size > 0
            ? { trackedTasks: Array.from(context.trackedTasks.values()) }
            : {}),
          ...(context.processedTokenBaselineKnown
            ? { processedTokenTotal: context.processedTokenTotal, tokenAccountingVersion: 1 }
            : {}),
        };

        context.session = {
          ...context.session,
          resumeCursor,
          updatedAt: timestamp,
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
          yield* offerRuntimeEvent(context, {
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
                    payload: {},
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
        yield* offerRuntimeEvent(context, {
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

        // align only against the current API message's blocks — from 0 would collide with earlier messages' blocks and silently drop this snapshot's text
        const orderedBlocks = turnState.assistantTextBlockOrder
          .slice(turnState.assistantMessageBlockBase)
          .map((block) => ({
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

        turnState.assistantMessageBlockBase = turnState.assistantTextBlockOrder.length;
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
        if (
          context.cacheObservation?.nativeSessionId !== undefined &&
          context.cacheObservation.nativeSessionId !== nextThreadId
        )
          invalidateClaudeCache(context);
        context.resumeSessionId = message.session_id;
        yield* updateResumeCursor(context);

        if (context.lastThreadStartedId !== nextThreadId) {
          delete context.resultUsageBaseline;
          context.lastThreadStartedId = nextThreadId;
          const stamp = yield* makeEventStamp();
          yield* offerRuntimeEvent(context, {
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
        yield* offerRuntimeEvent(context, {
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
        yield* offerRuntimeEvent(context, {
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

    // Claude reports only the compact boundary, so publish the progress row the transcript shows while native compaction is still running.
    const emitCompactionProgress = (context: ClaudeSessionContext): Effect.Effect<void> =>
      Effect.gen(function* () {
        const turnState = context.turnState;
        if (!turnState || turnState.compactionInProgress) return;
        turnState.compactionInProgress = true;
        const stamp = yield* makeEventStamp();
        yield* offerRuntimeEvent(context, {
          type: "item.updated",
          eventId: stamp.eventId,
          provider: PROVIDER,
          createdAt: stamp.createdAt,
          threadId: context.session.threadId,
          turnId: asCanonicalTurnId(turnState.turnId),
          itemId: asRuntimeItemId(`claude-compaction-${turnState.turnId}`),
          payload: {
            itemType: "context_compaction",
            status: "inProgress",
            title: "Compacting context",
          },
          providerRefs: nativeProviderRefs(context),
        });
      });

    // warn once per threshold; cache reads count toward context but are cheaper than fresh input, so the warning names both
    const maybeEmitContextUsageWarning = (
      context: ClaudeSessionContext,
      rawUsage: Record<string, unknown>,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const warnings = decideClaudeContextUsageWarnings(
          rawUsage,
          claudeEffectiveContextBudget(context),
          context.emittedContextUsageWarnings,
        );
        if (!warnings) {
          return;
        }

        context.emittedContextUsageWarnings.add(warnings.first.key);
        yield* emitRuntimeWarning(context, warnings.first.message);
        if (warnings.second) {
          context.emittedContextUsageWarnings.add(warnings.second.key);
          yield* emitRuntimeWarning(context, warnings.second.message);
        }
      });

    const readClaudeContextUsage = (
      context: ClaudeSessionContext,
    ): Effect.Effect<SDKControlGetContextUsageResponse | undefined> => {
      if (!context.contextUsageControlEnabled) {
        return Effect.succeed(undefined);
      }
      return Effect.tryPromise({
        try: () => context.query.getContextUsage({ detail: "summary" }),
        catch: (cause) => toError(cause, "Failed to read Claude context usage."),
      }).pipe(
        Effect.timeoutOption(CLAUDE_CONTEXT_USAGE_TIMEOUT_MS),
        Effect.map(
          Option.match({
            onNone: () => {
              // A missing control response otherwise blocks every future turn.
              context.contextUsageControlEnabled = false;
              return undefined;
            },
            onSome: (usage) => usage,
          }),
        ),
        Effect.catch(() => Effect.succeed(undefined)),
      );
    };

    const emitClaudeCacheObservation = (context: ClaudeSessionContext): Effect.Effect<void> =>
      Effect.gen(function* () {
        const claudeCache = context.cacheObservation;
        if (!claudeCache || context.stopped || sessions.get(context.session.threadId) !== context)
          return;
        const usedTokens = context.lastKnownTokenUsage?.usedTokens ?? claudeCache.contextTokens;
        if (usedTokens === undefined) return;
        const usage = { ...context.lastKnownTokenUsage, usedTokens, claudeCache };
        context.lastKnownTokenUsage = usage;
        const stamp = yield* makeEventStamp();
        yield* offerRuntimeEvent(context, {
          type: "thread.token-usage.updated",
          eventId: stamp.eventId,
          provider: PROVIDER,
          createdAt: stamp.createdAt,
          threadId: context.session.threadId,
          payload: { usage },
          providerRefs: nativeProviderRefs(context),
        });
      });

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
        yield* offerRuntimeEvent(context, {
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
        yield* offerRuntimeEvent(context, {
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

    const emitTrackedTasksUpdated = (
      context: ClaudeSessionContext,
      input: {
        readonly toolUseId?: string | undefined;
        readonly rawPayload: unknown;
      },
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const turnState = context.turnState;
        if (!turnState) {
          return;
        }

        const stamp = yield* makeEventStamp();
        yield* offerRuntimeEvent(context, {
          type: "turn.tasks.updated",
          eventId: stamp.eventId,
          provider: PROVIDER,
          createdAt: stamp.createdAt,
          threadId: context.session.threadId,
          turnId: turnState.turnId,
          payload: claudeTrackedTasksPayload(context.trackedTasks),
          providerRefs: nativeProviderRefs(context, {
            providerItemId: input.toolUseId,
          }),
          raw: {
            source: "claude.sdk.message",
            method: "claude/user/task-result",
            payload: input.rawPayload,
          },
        });
      });

    const settlePendingApproval = (
      context: ClaudeSessionContext,
      requestId: ApprovalRequestId,
      pending: PendingApproval,
      decision: ProviderApprovalDecision,
    ): Effect.Effect<ProviderApprovalDecision> =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const ownsSettlement = yield* Effect.sync(() => {
            if (context.pendingApprovals.get(requestId) !== pending) {
              return false;
            }
            if (pending.settlementStarted) {
              return false;
            }
            pending.settlementStarted = true;
            return true;
          });
          if (!ownsSettlement) {
            return yield* Deferred.await(pending.settled);
          }

          const stamp = yield* makeEventStamp();
          yield* offerRuntimeEvent(context, {
            type: "request.resolved",
            eventId: stamp.eventId,
            provider: PROVIDER,
            createdAt: stamp.createdAt,
            threadId: context.session.threadId,
            ...(pending.turnId ? { turnId: pending.turnId } : {}),
            requestId: asRuntimeRequestId(requestId),
            payload: {
              requestType: pending.requestType,
              decision,
            },
            providerRefs: nativeProviderRefs(context, {
              providerItemId: pending.providerItemId,
            }),
            raw: {
              source: "claude.sdk.permission",
              method: "canUseTool/decision",
              payload: { decision },
            },
          });
          context.pendingApprovals.delete(requestId);
          yield* Deferred.succeed(pending.decision, decision);
          yield* Deferred.succeed(pending.settled, decision);
          return decision;
        }),
      );

    const settlePendingUserInput = (
      context: ClaudeSessionContext,
      requestId: ApprovalRequestId,
      pending: PendingUserInput,
      result: PendingUserInputResult,
    ): Effect.Effect<PendingUserInputResult> =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const ownsSettlement = yield* Effect.sync(() => {
            if (context.pendingUserInputs.get(requestId) !== pending) {
              return false;
            }
            if (pending.settlementStarted) {
              return false;
            }
            pending.settlementStarted = true;
            return true;
          });
          if (!ownsSettlement) {
            return yield* Deferred.await(pending.settled);
          }

          const answers = remapAnswersToClaudeQuestionText(pending.questions, result.answers);
          const stamp = yield* makeEventStamp();
          yield* offerRuntimeEvent(context, {
            type: "user-input.resolved",
            eventId: stamp.eventId,
            provider: PROVIDER,
            createdAt: stamp.createdAt,
            threadId: context.session.threadId,
            ...(pending.turnId ? { turnId: pending.turnId } : {}),
            requestId: asRuntimeRequestId(requestId),
            payload: { answers },
            providerRefs: nativeProviderRefs(context, {
              providerItemId: pending.providerItemId,
            }),
            raw: {
              source: "claude.sdk.permission",
              method: "canUseTool/AskUserQuestion/resolved",
              payload: { answers, cancelled: result.cancelled },
            },
          });
          context.pendingUserInputs.delete(requestId);
          yield* Deferred.succeed(pending.result, result);
          yield* Deferred.succeed(pending.settled, result);
          return result;
        }),
      );

    type PendingInteractionSettlementScope =
      | { readonly type: "session" }
      | { readonly type: "foregroundTurn"; readonly turnId: TurnId };

    const pendingBelongsToSettlementScope = (
      context: ClaudeSessionContext,
      pending: Pick<PendingApproval, "agentId" | "turnId">,
      scope: PendingInteractionSettlementScope,
    ): boolean =>
      scope.type === "session" ||
      (pending.turnId === scope.turnId &&
        (pending.agentId === undefined || context.terminalTaskIds.has(pending.agentId)));

    const settlePendingHumanInteractions = (
      context: ClaudeSessionContext,
      scope: PendingInteractionSettlementScope,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        for (const [requestId, pending] of context.pendingApprovals) {
          if (!pendingBelongsToSettlementScope(context, pending, scope)) {
            continue;
          }
          yield* settlePendingApproval(context, requestId, pending, "cancel");
        }
        for (const [requestId, pending] of context.pendingUserInputs) {
          if (!pendingBelongsToSettlementScope(context, pending, scope)) {
            continue;
          }
          yield* settlePendingUserInput(context, requestId, pending, {
            answers: {},
            cancelled: true,
          });
        }
      });

    const settlePendingHumanInteractionsForAgent = (
      context: ClaudeSessionContext,
      agentId: string,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        for (const [requestId, pending] of context.pendingApprovals) {
          if (pending.agentId === agentId) {
            yield* settlePendingApproval(context, requestId, pending, "cancel");
          }
        }
        for (const [requestId, pending] of context.pendingUserInputs) {
          if (pending.agentId === agentId) {
            yield* settlePendingUserInput(context, requestId, pending, {
              answers: {},
              cancelled: true,
            });
          }
        }
      });

    const completeTurn = (
      context: ClaudeSessionContext,
      status: ProviderRuntimeTurnStatus,
      errorMessage?: string,
      result?: SDKResultMessage,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        // a terminal foreground turn drops its root callbacks (UI can't answer); agent callbacks stay actionable until provider-terminal evidence or session stop
        if (context.turnState) {
          yield* settlePendingHumanInteractions(context, {
            type: "foregroundTurn",
            turnId: context.turnState.turnId,
          });
        }

        const turnResultUsage = result
          ? claudeTurnResultUsage(result, context.resultUsageBaseline)
          : undefined;
        if (result) context.resultUsageBaseline = result;
        const liveContextUsage = yield* readClaudeContextUsage(context);
        const resultContextWindow = maxClaudeContextWindowFromModelUsage(result?.modelUsage);
        const liveRawContextWindow = positiveFiniteNumber(liveContextUsage?.rawMaxTokens);
        const effectiveContextWindow =
          liveRawContextWindow ??
          resolveEffectiveClaudeContextWindow({
            reportedContextWindow: resultContextWindow,
            lastKnownContextWindow: context.lastKnownContextWindow,
          });
        if (effectiveContextWindow !== undefined) {
          context.lastKnownContextWindow = effectiveContextWindow;
        }
        const liveAutoCompactThreshold = positiveFiniteNumber(
          liveContextUsage?.autoCompactThreshold,
        );
        if (liveAutoCompactThreshold !== undefined) {
          context.lastKnownAutoCompactThreshold = liveAutoCompactThreshold;
        }

        const accumulatedSnapshot = normalizeClaudeTokenUsage(
          result?.usage,
          claudeEffectiveContextBudget(context),
        );
        const reportedZeroUsage =
          result?.usage?.input_tokens === 0 &&
          result.usage.output_tokens === 0 &&
          (result.usage.cache_creation_input_tokens ?? 0) === 0 &&
          (result.usage.cache_read_input_tokens ?? 0) === 0;
        const resultProcessedTokens =
          accumulatedSnapshot?.totalProcessedTokens ??
          accumulatedSnapshot?.usedTokens ??
          (reportedZeroUsage ? 0 : undefined);
        if (resultProcessedTokens !== undefined) {
          const reconciledTotal = context.processedTokenResultBaseline + resultProcessedTokens;
          context.processedTokenTotal =
            status === "completed"
              ? reconciledTotal
              : Math.max(context.processedTokenTotal, reconciledTotal);
        }
        const totalProcessedTokens =
          context.processedTokenTotal > 0 ? context.processedTokenTotal : resultProcessedTokens;
        const accountedAccumulatedSnapshot = accumulatedSnapshot
          ? context.processedTokenBaselineKnown && totalProcessedTokens !== undefined
            ? { ...accumulatedSnapshot, totalProcessedTokens }
            : withoutProcessedTokenTotal(accumulatedSnapshot)
          : undefined;
        const liveSnapshot = liveContextUsage
          ? snapshotFromClaudeContextUsage(
              liveContextUsage,
              context.processedTokenBaselineKnown ? totalProcessedTokens : undefined,
            )
          : undefined;
        const lastGoodUsage = liveSnapshot ?? context.lastKnownTokenUsage;
        const maxTokens = claudeEffectiveContextBudget(context);
        if (context.tokenUsageState === "skip-compaction-call") {
          context.tokenUsageState = "awaiting-fresh-assistant";
        }
        const accountingOnlyUsage =
          context.processedTokenBaselineKnown && totalProcessedTokens !== undefined
            ? { usedTokens: 0, totalProcessedTokens }
            : undefined;
        const mergedUsageSnapshot: ThreadTokenUsageSnapshot | undefined =
          context.tokenUsageState !== "current"
            ? accountingOnlyUsage
            : !context.processedTokenBaselineKnown
              ? (lastGoodUsage ?? accountedAccumulatedSnapshot)
              : lastGoodUsage
                ? mergeClaudeTokenUsageSnapshot(
                    lastGoodUsage,
                    accountedAccumulatedSnapshot,
                    maxTokens,
                  )
                : accountedAccumulatedSnapshot;
        // the context merge preserves context size; accounting has its own final value and must not inherit the provisional max
        let usageSnapshot = mergedUsageSnapshot
          ? {
              ...withoutProcessedTokenTotal(mergedUsageSnapshot),
              ...(context.cacheObservation ? { claudeCache: context.cacheObservation } : {}),
              tokenAccountingVersion: 1 as const,
              ...(context.processedTokenBaselineKnown && totalProcessedTokens !== undefined
                ? { totalProcessedTokens }
                : {}),
            }
          : undefined;
        const mainLoopTokens = Math.max(
          0,
          context.processedTokenTotal -
            (result ? context.processedTokenResultBaseline : context.processedTokenTurnBaseline),
        );
        // a synthetic turn auto-closed before its SDK result still owns final usage — carry it into the baseline and quarantine late snapshots so no later result drops the cumulative below it
        context.processedTokenResultBaseline = context.processedTokenTotal;
        context.requestUsage.settleTurn();

        const reroutedFrom = context.rerouteOriginalApiModelId;
        if (reroutedFrom !== undefined) {
          const restoreExit = yield* Effect.exit(
            Effect.tryPromise({
              try: () => context.query.setModel(reroutedFrom),
              catch: (cause) => toError(cause, "Failed to restore Claude model after reroute."),
            }),
          );
          if (Exit.isSuccess(restoreExit)) {
            context.rerouteOriginalApiModelId = undefined;
            context.currentApiModelId = reroutedFrom;
            context.cacheObservation = claudeCacheForModel(context.cacheObservation, reroutedFrom);
            if (usageSnapshot && context.cacheObservation) {
              usageSnapshot = { ...usageSnapshot, claudeCache: context.cacheObservation };
              context.lastKnownTokenUsage = usageSnapshot;
            }
            context.lastKnownContextWindow =
              resolveClaudeApiModelIdContextWindowMaxTokens(reroutedFrom);
          }
        }

        const turnState = context.turnState;
        if (!turnState) {
          if (usageSnapshot) {
            const usageStamp = yield* makeEventStamp();
            yield* offerRuntimeEvent(context, {
              type: "thread.token-usage.updated",
              eventId: usageStamp.eventId,
              provider: PROVIDER,
              createdAt: usageStamp.createdAt,
              threadId: context.session.threadId,
              payload: {
                usage: usageSnapshot,
              },
              providerRefs: {},
            });
          }

          // ingestion drops a terminal event it can't attribute, stranding the projection — the last owned turn is the only possible owner (a newer one would still have live turn state)
          const settledTurnId = context.lastTurnId;
          if (settledTurnId === undefined) {
            yield* Effect.logWarning("claude turn result arrived with no attributable turn", {
              threadId: context.session.threadId,
              status,
            });
          }
          const stamp = yield* makeEventStamp();
          yield* offerRuntimeEvent(context, {
            type: "turn.completed",
            eventId: stamp.eventId,
            provider: PROVIDER,
            createdAt: stamp.createdAt,
            threadId: context.session.threadId,
            ...(settledTurnId !== undefined ? { turnId: settledTurnId } : {}),
            payload: {
              state: status,
              ...(result?.stop_reason !== undefined ? { stopReason: result.stop_reason } : {}),
              ...(result?.usage ? { usage: result.usage } : {}),
              ...(turnResultUsage ? { modelUsage: turnResultUsage.modelUsage } : {}),
              tokenAccountingVersion: 1,
              mainLoopTokens,
              ...(typeof result?.total_cost_usd === "number"
                ? { totalCostUsd: turnResultUsage?.totalCostUsd ?? result.total_cost_usd }
                : {}),
              ...(errorMessage ? { errorMessage } : {}),
            },
            providerRefs: {},
          });
          return;
        }

        if (context.interruptRequestedTurnId !== turnState.turnId) {
          yield* cancelAgentGatewayTurn(context.gatewaySessionLease, turnState.turnId);
        }

        for (const [index, tool] of context.inFlightTools.entries()) {
          const toolStamp = yield* makeEventStamp();
          yield* offerRuntimeEvent(context, {
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
          context.inFlightTools.delete(index);
        }
        context.inFlightTools.clear();

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
          const usageStamp = yield* makeEventStamp();
          yield* offerRuntimeEvent(context, {
            type: "thread.token-usage.updated",
            eventId: usageStamp.eventId,
            provider: PROVIDER,
            createdAt: usageStamp.createdAt,
            threadId: context.session.threadId,
            turnId: turnState.turnId,
            payload: {
              usage: usageSnapshot,
            },
            providerRefs: nativeProviderRefs(context),
          });
        }

        // Feed Claude edits into the same placeholder checkpoint flow used by Codex.
        if (status === "completed" && turnState.sawFileChange) {
          const diffStamp = yield* makeEventStamp();
          yield* offerRuntimeEvent(context, {
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

        // A compaction that ended without its boundary must not leave a spinner row.
        if (turnState.compactionInProgress) {
          const compactionStamp = yield* makeEventStamp();
          yield* offerRuntimeEvent(context, {
            type: "item.completed",
            eventId: compactionStamp.eventId,
            provider: PROVIDER,
            createdAt: compactionStamp.createdAt,
            threadId: context.session.threadId,
            turnId: asCanonicalTurnId(turnState.turnId),
            itemId: asRuntimeItemId(`claude-compaction-${turnState.turnId}`),
            payload: {
              itemType: "context_compaction",
              status: "failed",
              title: "Context compaction failed",
            },
            providerRefs: nativeProviderRefs(context),
          });
        }

        const stamp = yield* makeEventStamp();
        // settle session+cursor before publishing so terminal consumers can immediately dispatch the next turn
        if (context.interruptRequestedTurnId === turnState.turnId) {
          context.interruptRequestedTurnId = undefined;
        }
        context.lastInteractionMode = turnState.interactionMode;
        context.turnState = undefined;
        context.session = {
          ...context.session,
          status: "ready",
          activeTurnId: undefined,
          updatedAt: stamp.createdAt,
          ...(status === "failed" && errorMessage ? { lastError: errorMessage } : {}),
        };
        yield* updateResumeCursor(context, stamp.createdAt);

        yield* offerRuntimeEvent(context, {
          type: "turn.completed",
          eventId: stamp.eventId,
          provider: PROVIDER,
          createdAt: stamp.createdAt,
          threadId: context.session.threadId,
          turnId: turnState.turnId,
          payload: {
            state: status,
            ...(turnState.explicitCompaction
              ? {
                  contextCompacted:
                    status === "completed" &&
                    turnState.explicitCompaction.boundaryObserved &&
                    result?.session_id === turnState.explicitCompaction.nativeSessionId,
                }
              : {}),
            ...(result?.stop_reason !== undefined ? { stopReason: result.stop_reason } : {}),
            ...(result?.usage ? { usage: result.usage } : {}),
            ...(turnResultUsage ? { modelUsage: turnResultUsage.modelUsage } : {}),
            tokenAccountingVersion: 1,
            mainLoopTokens,
            ...(typeof result?.total_cost_usd === "number"
              ? { totalCostUsd: turnResultUsage?.totalCostUsd ?? result.total_cost_usd }
              : {}),
            ...(errorMessage ? { errorMessage } : {}),
          },
          providerRefs: nativeProviderRefs(context),
        });
      });

    // subagent runs share the parent session/query via a scoped context: events carry subagentRefs so ingestion routes to `subagent:<parent>:<toolUseId>` and interrupt decoding returns the toolUseId
    const ensureSubagentRun = (
      context: ClaudeSessionContext,
      toolUseId: string,
    ): ClaudeSubagentRun => {
      const existing = context.subagentRuns.get(toolUseId);
      if (existing) {
        return existing;
      }
      const run: ClaudeSubagentRun = {
        toolUseId,
        taskId: undefined,
        context: {
          session: context.session,
          ...(context.lifecycleGeneration === undefined
            ? {}
            : { lifecycleGeneration: context.lifecycleGeneration }),
          promptQueue: context.promptQueue,
          query: context.query,
          artifactsEnabled: context.artifactsEnabled,
          processOwner: context.processOwner,
          streamFiber: undefined,
          startedAt: context.startedAt,
          basePermissionMode: context.basePermissionMode,
          spawnPermissionMode: context.spawnPermissionMode,
          // subagent contexts only project events for an already-running CLI — they never dispatch the first prompt, so spawn state isn't theirs to prove
          firstTurnSpawnModeAuthoritative: false,
          lastInteractionMode: undefined,
          currentApiModelId: undefined,
          resumeSessionId: undefined,
          pendingApprovals: new Map(),
          approvalsAlwaysAllowedForSession: false,
          pendingUserInputs: new Map(),
          turns: [],
          inFlightTools: new Map(),
          trackedTasks: new Map(),
          turnState: undefined,
          lastTurnId: undefined,
          interruptRequestedTurnId: undefined,
          lastKnownContextWindow: context.lastKnownContextWindow,
          currentAutoCompactWindow: context.currentAutoCompactWindow,
          currentAlwaysThinkingEnabled: undefined,
          currentEffort: context.currentEffort,
          currentUltracode: context.currentUltracode,
          currentFastMode: context.currentFastMode,
          lastKnownAutoCompactThreshold: context.lastKnownAutoCompactThreshold,
          // session-level usage controls answer for the main conversation only — subagent completion must not poll them
          contextUsageControlEnabled: false,
          lastKnownTokenUsage: undefined,
          tokenUsageState: "current",
          compactionMessageId: undefined,
          processedTokenTotal: 0,
          processedTokenTurnBaseline: 0,
          processedTokenResultBaseline: 0,
          processedTokenBaselineKnown: true,
          requestUsage: new ClaudeRequestUsage(),
          lastResultUuid: undefined,
          lastAssistantUuid: undefined,
          lastThreadStartedId: undefined,
          rerouteOriginalApiModelId: undefined,
          emittedContextUsageWarnings: new Set(),
          stopped: false,
          warnedUnhandledSdkKinds: context.warnedUnhandledSdkKinds,
          subagentRuns: new Map(),
          pendingSubagentSteers: new Map(),
          pendingSubagentStops: new Set(),
          knownBackgroundTaskIds: new Set(),
          terminalTaskIds: new Set(),
          settledSubagentToolUseIds: new Map(),
          liveWorkflowTaskIds: new Set(),
          knownWorkflowTaskIds: new Set(),
          workflowTaskIdByMemberTaskId: new Map(),
          workflowRuntimePollers: new Map(),
          workflowAgentLabels: new Map(),
          workflowRuntimeStates: new Map(),
          subagentRefs: {
            providerThreadId: toolUseId,
            providerParentThreadId: context.session.threadId,
          },
        },
      };
      context.subagentRuns.set(toolUseId, run);
      return run;
    };

    // streaming turns key tool items by block index; complete-message turns (subagents) use synthetic negative keys stream deltas can't reference
    const openInFlightTool = (
      context: ClaudeSessionContext,
      input: {
        readonly blockIndex: number;
        readonly toolName: string;
        readonly itemId: string;
        readonly toolInput: Record<string, unknown>;
        readonly rawMethod: string;
        readonly rawPayload: unknown;
      },
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const itemType = classifyToolItemType(input.toolName);
        const serializedInput = toolInputFingerprint(input.toolInput);
        const inputFingerprint =
          Object.keys(input.toolInput).length > 0 ? serializedInput : undefined;
        const detail = summarizeToolRequest(
          input.toolName,
          input.toolInput,
          serializedInput ?? undefined,
        );

        const tool: ToolInFlight = {
          itemId: input.itemId,
          itemType,
          toolName: input.toolName,
          title: titleForTool(itemType),
          detail,
          input: input.toolInput,
          partialInputJson: "",
          ...(inputFingerprint ? { lastEmittedInputFingerprint: inputFingerprint } : {}),
        };
        context.inFlightTools.set(input.blockIndex, tool);

        const stamp = yield* makeEventStamp();
        yield* offerRuntimeEvent(context, {
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
            method: input.rawMethod,
            payload: input.rawPayload,
          },
        });
        if (tool.toolName === "TodoWrite") {
          yield* emitTodoTasksUpdated(context, {
            toolInput: input.toolInput,
            toolUseId: tool.itemId,
            rawMethod: input.rawMethod,
            rawPayload: input.rawPayload,
          });
        }
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

        if (event.type === "message_start" && !context.subagentRefs) {
          context.cacheRequestStartedAt = { messageId: event.message.id, at: yield* nowIso };
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
            yield* offerRuntimeEvent(context, {
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
                payload: {},
              },
            });
            return;
          }

          if (event.delta.type === "input_json_delta") {
            const tool = context.inFlightTools.get(event.index);
            if (!tool || typeof event.delta.partial_json !== "string") {
              return;
            }

            const partialInputJson = tool.partialInputJson + event.delta.partial_json;
            const parsedInput = tryParseCompleteJsonRecord(partialInputJson);
            const detail = parsedInput
              ? summarizeToolRequest(tool.toolName, parsedInput.value, parsedInput.serialized)
              : tool.detail;
            let nextTool: ToolInFlight = {
              ...tool,
              partialInputJson,
              ...(parsedInput ? { input: parsedInput.value } : {}),
              ...(detail ? { detail } : {}),
            };

            const nextFingerprint =
              parsedInput && Object.keys(parsedInput.value).length > 0
                ? parsedInput.serialized
                : undefined;
            context.inFlightTools.set(event.index, nextTool);

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
            context.inFlightTools.set(event.index, nextTool);

            const stamp = yield* makeEventStamp();
            yield* offerRuntimeEvent(context, {
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
                payload: {},
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
          if (isClientSurfacedClaudeTool(toolName)) {
            return;
          }
          yield* openInFlightTool(context, {
            blockIndex: index,
            toolName,
            itemId: block.id,
            toolInput:
              typeof block.input === "object" && block.input !== null
                ? (block.input as Record<string, unknown>)
                : {},
            rawMethod: "claude/stream_event/content_block_start",
            rawPayload: message,
          });
          return;
        }

        if (event.type === "content_block_stop") {
          const { index } = event;
          const assistantBlock = context.turnState?.assistantTextBlocks.get(index);
          if (assistantBlock) {
            assistantBlock.streamClosed = true;
            yield* completeAssistantTextBlock(context, assistantBlock, {
              rawMethod: "claude/stream_event/content_block_stop",
              rawPayload: message,
            });
            return;
          }
          const tool = context.inFlightTools.get(index);
          if (!tool) {
            return;
          }
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
          const toolEntry = Array.from(context.inFlightTools.entries()).find(
            ([, tool]) => tool.itemId === toolResult.toolUseId,
          );
          if (!toolEntry) {
            continue;
          }

          const [index, tool] = toolEntry;
          const itemStatus = toolResult.isError ? "failed" : "completed";
          // a user-stopped task returns an error-shaped tool_result — settled status stamps per-agent state so the row reads "Stopped", not "Failed"
          const settledStatus =
            tool.toolName === "Task" || tool.toolName === "Agent"
              ? context.settledSubagentToolUseIds.get(tool.itemId)
              : undefined;
          const toolData = toolLifecycleEventData(tool, {
            result: toolResult.block,
            ...(settledStatus === "stopped"
              ? { agentStates: { [tool.itemId]: { status: "stopped" } } }
              : {}),
          });

          const updatedStamp = yield* makeEventStamp();
          yield* offerRuntimeEvent(context, {
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
            yield* offerRuntimeEvent(context, {
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
                payload: {},
              },
            });
          }

          if (
            applyClaudeTaskToolResult(
              context.trackedTasks,
              tool,
              toolResult.block,
              toolResult.structuredResult,
              toolResult.isError,
            )
          ) {
            yield* updateResumeCursor(context);
            yield* emitTrackedTasksUpdated(context, {
              toolUseId: tool.itemId,
              rawPayload: message,
            });
          }

          // the Workflow tool returns async_launched with script path + runId — surfacing them on task.updated enables stop-then-resume
          const workflowLaunch =
            tool.toolName === "Workflow"
              ? (parseClaudeWorkflowLaunch(toolResult.structuredResult) ??
                (toolResult.text.length > 0
                  ? parseClaudeWorkflowLaunchFromText(toolResult.text)
                  : undefined))
              : undefined;
          const workflowLaunchTaskId =
            workflowLaunch?.taskId ??
            (context.liveWorkflowTaskIds.size === 1
              ? Array.from(context.liveWorkflowTaskIds)[0]
              : undefined);
          if (workflowLaunch && workflowLaunchTaskId) {
            const launchStamp = yield* makeEventStamp();
            yield* offerRuntimeEvent(context, {
              type: "task.updated",
              eventId: launchStamp.eventId,
              provider: PROVIDER,
              createdAt: launchStamp.createdAt,
              threadId: context.session.threadId,
              ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
              payload: {
                taskId: RuntimeTaskId.makeUnsafe(workflowLaunchTaskId),
                ...(workflowLaunch.runId ? { workflowRunId: workflowLaunch.runId } : {}),
                ...(workflowLaunch.scriptPath
                  ? { workflowScriptPath: workflowLaunch.scriptPath }
                  : {}),
              },
              providerRefs: nativeProviderRefs(context, { providerItemId: tool.itemId }),
              raw: {
                source: "claude.sdk.message",
                method: "claude/user",
                payload: message,
              },
            });
            if (workflowLaunch.transcriptDir) {
              startWorkflowRuntimePoller(
                context,
                workflowLaunchTaskId,
                workflowLaunch.transcriptDir,
              );
            }
          }

          const completedStamp = yield* makeEventStamp();
          yield* offerRuntimeEvent(context, {
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
          context.inFlightTools.delete(index);
        }
      });

    const ensureSyntheticTurn = (context: ClaudeSessionContext): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (context.turnState) {
          return;
        }
        const turnId = TurnId.makeUnsafe(yield* Random.nextUUIDv4);
        const startedAt = yield* nowIso;
        context.turnState = {
          turnId,
          startedAt,
          interactionMode: "default",
          synthetic: true,
          items: [],
          assistantTextBlocks: new Map(),
          assistantTextBlockOrder: [],
          capturedProposedPlanKeys: new Set(),
          sawFileChange: false,
          nextSyntheticAssistantBlockIndex: -1,
          assistantMessageBlockBase: 0,
        };
        context.processedTokenTurnBaseline = context.processedTokenTotal;
        context.lastTurnId = turnId;
        context.session = {
          ...context.session,
          status: "running",
          activeTurnId: turnId,
          updatedAt: startedAt,
        };
        const turnStartedStamp = yield* makeEventStamp();
        yield* offerRuntimeEvent(context, {
          type: "turn.started",
          eventId: turnStartedStamp.eventId,
          provider: PROVIDER,
          createdAt: turnStartedStamp.createdAt,
          threadId: context.session.threadId,
          turnId,
          payload: {},
          providerRefs: {
            ...nativeProviderRefs(context),
            providerTurnId: turnId,
          },
          raw: {
            source: "claude.sdk.message",
            method: "claude/synthetic-turn-start",
            payload: {},
          },
        });
      });

    // Transcript marker on the child thread, emitted only at actual delivery (the PreToolUse hook fired inside the subagent), never on enqueue.
    const emitSubagentSteerDelivered = (
      run: ClaudeSubagentRun,
      message: string,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        yield* ensureSyntheticTurn(run.context);
        const stamp = yield* makeEventStamp();
        yield* offerRuntimeEvent(run.context, {
          type: "turn.steered",
          eventId: stamp.eventId,
          provider: PROVIDER,
          createdAt: stamp.createdAt,
          threadId: run.context.session.threadId,
          ...(run.context.turnState
            ? { turnId: asCanonicalTurnId(run.context.turnState.turnId) }
            : {}),
          payload: {
            message,
            target: "subagent",
          },
          providerRefs: nativeProviderRefs(run.context),
          raw: {
            source: "claude.sdk.hook",
            method: "hooks/PreToolUse",
            payload: {
              taskId: run.taskId,
              toolUseId: run.toolUseId,
            },
          },
        });
      });

    const handleAssistantMessage = (
      context: ClaudeSessionContext,
      message: SDKMessage,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (message.type !== "assistant") {
          return;
        }

        yield* ensureSyntheticTurn(context);
        if (message.error && context.turnState) {
          context.turnState = {
            ...context.turnState,
            assistantError: {
              code: message.error,
              message: claudeAssistantErrorMessage(message.error),
            },
          };
        }
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
            const isToolUseBlock =
              toolUse.type === "tool_use" ||
              toolUse.type === "server_tool_use" ||
              toolUse.type === "mcp_tool_use";
            if (
              isToolUseBlock &&
              context.subagentRefs !== undefined &&
              typeof toolUse.id === "string" &&
              typeof toolUse.name === "string" &&
              !isClientSurfacedClaudeTool(toolUse.name)
            ) {
              // subagent conversations arrive as complete messages only, so this snapshot is the sole chance to open their tool items; the parent streams via content_block_start — dedupe by tool-use id
              const toolUseId = toolUse.id;
              const alreadyOpen = Array.from(context.inFlightTools.values()).some(
                (tool) => tool.itemId === toolUseId,
              );
              if (!alreadyOpen) {
                let syntheticIndex = -1;
                for (const key of context.inFlightTools.keys()) {
                  if (key <= syntheticIndex) {
                    syntheticIndex = key - 1;
                  }
                }
                yield* openInFlightTool(context, {
                  blockIndex: syntheticIndex,
                  toolName: toolUse.name,
                  itemId: toolUseId,
                  toolInput:
                    typeof toolUse.input === "object" && toolUse.input !== null
                      ? (toolUse.input as Record<string, unknown>)
                      : {},
                  rawMethod: "claude/assistant",
                  rawPayload: message,
                });
              }
            }
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

        const perCallUsage = (message.message as { usage?: unknown } | undefined)?.usage;
        if (perCallUsage) {
          const messageId = message.message.id ?? message.request_id ?? message.uuid;
          const normalizedPerCallUsage = normalizeClaudeTokenUsage(
            perCallUsage as Record<string, unknown>,
            claudeEffectiveContextBudget(context),
          );
          let addedTokens = 0;
          if (normalizedPerCallUsage) {
            addedTokens = context.requestUsage.add(
              messageId,
              normalizedPerCallUsage.totalProcessedTokens ?? normalizedPerCallUsage.usedTokens,
            );
            context.processedTokenTotal += addedTokens;
          }
          if (context.tokenUsageState === "skip-compaction-call") {
            context.compactionMessageId = messageId;
            context.tokenUsageState = "awaiting-fresh-assistant";
          } else if (context.compactionMessageId !== messageId) {
            if (addedTokens > 0 && !context.subagentRefs) {
              context.hasObservedCacheRequest = true;
              context.cacheObservation = claudeCacheFromRequest({
                usage: perCallUsage as Record<string, unknown>,
                messageId,
                observedAt: yield* nowIso,
                ...(context.cacheRequestStartedAt?.messageId === messageId
                  ? { cacheReferenceAt: context.cacheRequestStartedAt.at }
                  : {}),
                ...(context.resumeSessionId ? { nativeSessionId: context.resumeSessionId } : {}),
                ...(context.lifecycleGeneration
                  ? { lifecycleGeneration: context.lifecycleGeneration }
                  : {}),
                ...(context.currentApiModelId ? { model: context.currentApiModelId } : {}),
                ...(context.cacheObservation ? { previous: context.cacheObservation } : {}),
              });
            }
            yield* maybeEmitContextUsageWarning(context, perCallUsage as Record<string, unknown>);
            if (normalizedPerCallUsage) {
              const currentUsage = {
                ...withoutProcessedTokenTotal(normalizedPerCallUsage),
                ...(context.cacheObservation ? { claudeCache: context.cacheObservation } : {}),
                tokenAccountingVersion: 1 as const,
                ...(context.processedTokenBaselineKnown
                  ? { totalProcessedTokens: context.processedTokenTotal }
                  : {}),
              };
              context.lastKnownTokenUsage = currentUsage;
              context.tokenUsageState = "current";
              const usageStamp = yield* makeEventStamp();
              yield* offerRuntimeEvent(context, {
                type: "thread.token-usage.updated",
                eventId: usageStamp.eventId,
                provider: PROVIDER,
                createdAt: usageStamp.createdAt,
                threadId: context.session.threadId,
                ...(context.turnState
                  ? { turnId: asCanonicalTurnId(context.turnState.turnId) }
                  : {}),
                payload: { usage: currentUsage },
                providerRefs: nativeProviderRefs(context),
                raw: {
                  source: "claude.sdk.message",
                  method: "claude/assistant-usage",
                  payload: perCallUsage,
                },
              });
            }
          }
        }

        context.lastAssistantUuid = message.uuid;
        yield* updateResumeCursor(context);
      });

    const handleResultMessage = (
      context: ClaudeSessionContext,
      message: SDKMessage,
    ): Effect.Effect<void, ProviderAdapterProcessError> =>
      Effect.gen(function* () {
        if (message.type !== "result") {
          return;
        }
        if (message.uuid && context.lastResultUuid === message.uuid) return;
        context.lastResultUuid = message.uuid;

        const assistantError = context.turnState?.assistantError;
        let status: ProviderRuntimeTurnStatus;
        if (hasPendingUserInterrupt(context) && message.subtype === "error_during_execution") {
          status = "interrupted";
        } else if (assistantError) {
          status = "failed";
        } else {
          status = turnStatusFromResult(message);
        }

        let errorMessage: string | undefined;
        if (assistantError) {
          errorMessage = assistantError.message;
        } else if (message.subtype !== "success") {
          errorMessage = normalizeClaudeUserVisibleErrorMessage(message.errors[0], status);
        }

        if (status === "failed") {
          yield* emitRuntimeError(context, errorMessage ?? "Claude turn failed.");
        }

        yield* completeTurn(context, status, errorMessage, message);

        // the SDK caches account credentials in the live process — an auth failure can't recover by reusing the query, so retire it after publishing the failed turn
        if (assistantError && claudeAssistantErrorRequiresProcessRestart(assistantError.code)) {
          yield* stopSessionInternal(context, {
            emitExitEvent: true,
            interruptStream: false,
          });
        }
      });

    // task usage belongs to the agent that spent it: subagent tasks feed the child meter and stay off the parent's context snapshot
    const emitTaskUsageSnapshot = (
      context: ClaudeSessionContext,
      message: Extract<SDKMessage, { subtype: "task_progress" | "task_notification" }>,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (!message.usage) {
          return;
        }
        const run = subagentRunForTask(context, message.tool_use_id, message.task_id);
        const target = run?.context ?? context;
        if (target.tokenUsageState !== "current") {
          return;
        }
        const normalizedUsage = normalizeClaudeTokenUsage(
          message.usage,
          claudeEffectiveContextBudget(target),
        );
        if (!normalizedUsage) {
          return;
        }
        target.lastKnownTokenUsage = normalizedUsage;
        const stamp = yield* makeEventStamp();
        yield* offerRuntimeEvent(target, {
          type: "thread.token-usage.updated",
          eventId: stamp.eventId,
          provider: PROVIDER,
          createdAt: stamp.createdAt,
          threadId: target.session.threadId,
          ...(target.turnState ? { turnId: asCanonicalTurnId(target.turnState.turnId) } : {}),
          payload: {
            usage: normalizedUsage,
          },
          providerRefs: nativeProviderRefs(target),
          raw: {
            source: "claude.sdk.message",
            method: sdkNativeMethod(message),
            messageType: `${message.type}:${message.subtype}`,
            payload: message,
          },
        });
      });

    const resolveWorkflowScriptText = (
      context: ClaudeSessionContext,
      message: Extract<SDKMessage, { subtype: "task_started" }>,
    ): Effect.Effect<string | undefined> =>
      Effect.gen(function* () {
        if (typeof message.prompt === "string" && message.prompt.trim().length > 0) {
          return message.prompt;
        }
        const tool = message.tool_use_id
          ? Array.from(context.inFlightTools.values()).find(
              (candidate) => candidate.itemId === message.tool_use_id,
            )
          : undefined;
        if (typeof tool?.input.script === "string" && tool.input.script.trim().length > 0) {
          return tool.input.script;
        }
        if (typeof tool?.input.scriptPath === "string" && tool.input.scriptPath.length > 0) {
          return yield* fileSystem
            .readFileString(tool.input.scriptPath)
            .pipe(Effect.orElseSucceed(() => undefined));
        }
        return undefined;
      });

    const workflowRuntimePollInterval = Duration.millis(
      options?.workflowRuntimePollIntervalMs ?? DEFAULT_WORKFLOW_RUNTIME_POLL_INTERVAL_MS,
    );

    const startWorkflowRuntimePoller = (
      context: ClaudeSessionContext,
      taskId: string,
      transcriptDir: string,
    ): void => {
      if (context.workflowRuntimePollers.has(taskId)) {
        return;
      }
      const state = makeClaudeWorkflowRuntimeState();
      context.workflowRuntimeStates.set(taskId, state);
      let lastEmitted = "";
      const loop = Effect.gen(function* () {
        while (!context.stopped && context.liveWorkflowTaskIds.has(taskId)) {
          yield* Effect.sleep(workflowRuntimePollInterval);
          const changed = yield* collectClaudeWorkflowRuntime(fileSystem, transcriptDir, state);
          if (!changed) {
            continue;
          }
          const snapshots = claudeWorkflowRuntimeSnapshots(
            state,
            context.workflowAgentLabels.get(taskId) ?? [],
          );
          if (snapshots.length === 0) {
            continue;
          }
          const fingerprint = JSON.stringify(snapshots);
          if (fingerprint === lastEmitted) {
            continue;
          }
          lastEmitted = fingerprint;
          const stamp = yield* makeEventStamp();
          yield* offerRuntimeEvent(context, {
            type: "task.progress",
            eventId: stamp.eventId,
            provider: PROVIDER,
            createdAt: stamp.createdAt,
            threadId: context.session.threadId,
            ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
            payload: {
              taskId: RuntimeTaskId.makeUnsafe(taskId),
              description: WORKFLOW_AGENTS_PROGRESS_DESCRIPTION,
              workflowAgents: snapshots,
            },
            providerRefs: nativeProviderRefs(context),
          });
        }
      });
      const fiber = Effect.runFork(loop);
      context.workflowRuntimePollers.set(taskId, fiber);
      fiber.addObserver(() => {
        if (context.workflowRuntimePollers.get(taskId) === fiber) {
          context.workflowRuntimePollers.delete(taskId);
        }
      });
    };

    const stopWorkflowRuntimePoller = (
      context: ClaudeSessionContext,
      taskId: string,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        context.workflowAgentLabels.delete(taskId);
        // workflowRuntimeStates survives poller teardown: terminal task_updated stops the poller before task_notification backfills effort
        const fiber = context.workflowRuntimePollers.get(taskId);
        if (!fiber) {
          return;
        }
        context.workflowRuntimePollers.delete(taskId);
        yield* Fiber.interrupt(fiber);
      });

    const handleSystemMessage = (
      context: ClaudeSessionContext,
      message: SDKMessage,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (message.type !== "system") {
          return;
        }

        // thinking_tokens streams every reasoning tick — short-circuit before allocating an event stamp so it can't flood the timeline
        if (message.subtype === "thinking_tokens") {
          return;
        }

        // task_updated status surfaces as task.updated on the parent; tracked subagent runs also keep the child truthful via session.state.changed; non-status patches stay dropped
        if (message.subtype === "task_updated") {
          const patch = message.patch;
          const status = patch?.status;
          const isBackgrounded = patch?.is_backgrounded;
          if (status === undefined && isBackgrounded === undefined) {
            return;
          }
          const isTerminalStatus =
            status === "completed" || status === "failed" || status === "killed";
          if (isTerminalStatus) {
            context.terminalTaskIds.add(message.task_id);
            yield* settlePendingHumanInteractionsForAgent(context, message.task_id);
          }
          // a foreground/terminal patch may evict a background id, but never add on `true` — that patch can arrive before the snapshot whose notice we still owe
          if (isTerminalStatus || isBackgrounded === false) {
            context.knownBackgroundTaskIds.delete(message.task_id);
          }
          const isSettledRuntimeStatus = isTerminalStatus || status === "paused";
          if (isSettledRuntimeStatus && context.liveWorkflowTaskIds.has(message.task_id)) {
            context.liveWorkflowTaskIds.delete(message.task_id);
            yield* stopWorkflowRuntimePoller(context, message.task_id);
          }
          const workflowTaskId = context.workflowTaskIdByMemberTaskId.get(message.task_id);
          const run = subagentRunForTask(context, undefined, message.task_id);
          const raw = {
            source: "claude.sdk.message" as const,
            method: sdkNativeMethod(message),
            messageType: `${message.type}:${message.subtype}`,
            payload: message,
          };
          const taskStamp = yield* makeEventStamp();
          yield* offerRuntimeEvent(context, {
            type: "task.updated",
            eventId: taskStamp.eventId,
            provider: PROVIDER,
            createdAt: taskStamp.createdAt,
            threadId: context.session.threadId,
            ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
            payload: {
              taskId: RuntimeTaskId.makeUnsafe(message.task_id),
              ...(status !== undefined ? { status } : {}),
              ...(patch?.error ? { error: patch.error } : {}),
              ...(isBackgrounded !== undefined ? { isBackgrounded } : {}),
              ...(run ? { toolUseId: run.toolUseId } : {}),
              ...(workflowTaskId
                ? { workflowTaskId: RuntimeTaskId.makeUnsafe(workflowTaskId) }
                : {}),
            },
            providerRefs: nativeProviderRefs(context),
            raw,
          });
          const state =
            status !== undefined ? runtimeSessionStateFromClaudeTaskStatus(status) : undefined;
          if (!run || state === undefined) {
            return;
          }
          const stamp = yield* makeEventStamp();
          yield* offerRuntimeEvent(run.context, {
            type: "session.state.changed",
            eventId: stamp.eventId,
            provider: PROVIDER,
            createdAt: stamp.createdAt,
            threadId: run.context.session.threadId,
            ...(run.context.turnState
              ? { turnId: asCanonicalTurnId(run.context.turnState.turnId) }
              : {}),
            payload: {
              state,
              reason: `task:${status}`,
              detail: message,
            },
            providerRefs: nativeProviderRefs(run.context),
            raw,
          });
          if (isTerminalStatus) {
            context.subagentRuns.delete(run.toolUseId);
            context.pendingSubagentSteers.delete(run.toolUseId);
            context.pendingSubagentStops.delete(run.toolUseId);
            context.settledSubagentToolUseIds.set(
              run.toolUseId,
              status === "completed" ? "completed" : status === "failed" ? "failed" : "stopped",
            );
            if (run.context.turnState) {
              yield* completeTurn(
                run.context,
                status === "completed"
                  ? "completed"
                  : status === "failed"
                    ? "failed"
                    : "interrupted",
              );
            }
          }
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

        const refusalFallback = readClaudeModelRefusalFallback(message);
        if (refusalFallback) {
          context.rerouteOriginalApiModelId ??= refusalFallback.originalModel;
          context.currentApiModelId = refusalFallback.fallbackModel;
          context.cacheObservation = claudeCacheForModel(
            context.cacheObservation,
            refusalFallback.fallbackModel,
          );
          context.lastKnownContextWindow = resolveClaudeApiModelIdContextWindowMaxTokens(
            refusalFallback.fallbackModel,
          );
          yield* updateResumeCursor(context);
          yield* offerRuntimeEvent(context, {
            ...base,
            type: "model.rerouted",
            payload: {
              fromModel: refusalFallback.originalModel,
              toModel: refusalFallback.fallbackModel,
              reason: refusalFallback.content ?? "Model safeguards rerouted this request.",
            },
          });
          return;
        }

        // VCS transitions let the git-metadata reactor refresh branch/PR mid-turn instead of waiting for the turn boundary
        const vcsStateChange = readClaudeVcsStateChange(message);
        if (vcsStateChange) {
          yield* offerRuntimeEvent(context, {
            ...base,
            type: "vcs.state.changed",
            payload: vcsStateChange,
          });
          return;
        }

        switch (message.subtype) {
          case "init":
            if (Array.isArray(message.tools)) {
              context.initToolNames = new Set(message.tools);
            }
            yield* offerRuntimeEvent(context, {
              ...base,
              type: "session.configured",
              payload: {
                config: message as Record<string, unknown>,
              },
            });
            return;
          case "permission_denied": {
            const reason =
              message.decision_reason?.trim() ||
              message.message?.trim() ||
              "Claude's automatic permission reviewer denied this action.";
            yield* emitRuntimeWarning(
              context,
              `${message.tool_name} was denied: ${reason}`,
              message,
            );
            return;
          }
          case "status":
            if (message.status === "compacting") yield* emitCompactionProgress(context);
            yield* offerRuntimeEvent(context, {
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
            if (context.turnState?.explicitCompaction?.nativeSessionId === message.session_id) {
              context.turnState.explicitCompaction.boundaryObserved = true;
            }
            if (context.turnState) context.turnState.compactionInProgress = false;
            invalidateClaudeCache(context);
            context.lastKnownTokenUsage = undefined;
            context.tokenUsageState = "skip-compaction-call";
            yield* updateResumeCursor(context);
            yield* offerRuntimeEvent(context, {
              ...base,
              type: "thread.state.changed",
              payload: {
                state: "compacted",
                detail: message,
              },
            });
            return;
          case "hook_started":
            yield* offerRuntimeEvent(context, {
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
            yield* offerRuntimeEvent(context, {
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
            yield* offerRuntimeEvent(context, {
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
          case "task_started": {
            context.terminalTaskIds.delete(message.task_id);
            if (
              message.tool_use_id &&
              (message.subagent_type !== undefined || context.subagentRuns.has(message.tool_use_id))
            ) {
              const run = ensureSubagentRun(context, message.tool_use_id);
              run.taskId = message.task_id;
              // A stop that raced the spawn window fires now that the task id exists.
              if (context.pendingSubagentStops.delete(message.tool_use_id)) {
                yield* Effect.tryPromise(() => context.query.stopTask(message.task_id)).pipe(
                  Effect.catch((cause) =>
                    emitRuntimeError(
                      context,
                      `Failed to stop subagent task '${message.task_id}'.`,
                      cause,
                    ),
                  ),
                );
              }
            }
            if (message.task_type === "local_workflow") {
              context.liveWorkflowTaskIds.add(message.task_id);
              context.knownWorkflowTaskIds.add(message.task_id);
            } else if (
              context.liveWorkflowTaskIds.size === 1 &&
              // ambient local_bash housekeeping tasks are not workflow members — tagging them floods the run panel with pseudo-agent rows
              message.task_type !== "local_bash" &&
              message.skip_transcript !== true &&
              // Task-tool subagents already surface via their collab item — tagging them too would list the same agent twice
              !(message.tool_use_id !== undefined && message.subagent_type !== undefined)
            ) {
              const [workflowTaskId] = context.liveWorkflowTaskIds;
              context.workflowTaskIdByMemberTaskId.set(message.task_id, workflowTaskId!);
            }
            const workflowTaskId = context.workflowTaskIdByMemberTaskId.get(message.task_id);
            const workflowScript =
              message.task_type === "local_workflow"
                ? yield* resolveWorkflowScriptText(context, message)
                : undefined;
            const workflowMeta = workflowScript
              ? parseClaudeWorkflowScriptMeta(workflowScript)
              : undefined;
            const workflowAgentPhases = workflowScript
              ? extractClaudeWorkflowAgentPhases(workflowScript)
              : undefined;
            const workflowAgentPlans = workflowScript
              ? extractClaudeWorkflowAgentPlans(workflowScript)
              : undefined;
            const workflowName = message.workflow_name ?? workflowMeta?.name;
            yield* offerRuntimeEvent(context, {
              ...base,
              type: "task.started",
              payload: {
                taskId: RuntimeTaskId.makeUnsafe(message.task_id),
                description: message.description,
                ...(message.task_type ? { taskType: message.task_type } : {}),
                ...(message.subagent_type ? { subagentType: message.subagent_type } : {}),
                ...(workflowName ? { workflowName } : {}),
                ...(workflowTaskId
                  ? { workflowTaskId: RuntimeTaskId.makeUnsafe(workflowTaskId) }
                  : {}),
                ...(workflowMeta?.phases ? { workflowPhases: workflowMeta.phases } : {}),
                ...(workflowAgentPhases ? { workflowAgentPhases } : {}),
                ...(workflowAgentPlans ? { workflowAgentPlans } : {}),
                ...(message.tool_use_id ? { toolUseId: message.tool_use_id } : {}),
              },
            });
            return;
          }
          case "task_progress": {
            yield* emitTaskUsageSnapshot(context, message);
            // progress descriptions arrive as "<phase>: <label>" in agent-start order — the label list the poller zips onto journal starts
            if (context.liveWorkflowTaskIds.has(message.task_id)) {
              const separator = message.description.indexOf(": ");
              const label = (
                separator > 0 ? message.description.slice(separator + 2) : message.description
              ).trim();
              if (label.length > 0) {
                const labels = context.workflowAgentLabels.get(message.task_id) ?? [];
                if (!labels.includes(label)) {
                  labels.push(label);
                  context.workflowAgentLabels.set(message.task_id, labels);
                }
              }
            }
            const workflowTaskId = context.workflowTaskIdByMemberTaskId.get(message.task_id);
            yield* offerRuntimeEvent(context, {
              ...base,
              type: "task.progress",
              payload: {
                taskId: RuntimeTaskId.makeUnsafe(message.task_id),
                description: message.description,
                ...(message.summary ? { summary: message.summary } : {}),
                ...(message.usage ? { usage: message.usage } : {}),
                ...(message.last_tool_name ? { lastToolName: message.last_tool_name } : {}),
                ...(workflowTaskId
                  ? { workflowTaskId: RuntimeTaskId.makeUnsafe(workflowTaskId) }
                  : {}),
              },
            });
            return;
          }
          case "task_notification": {
            yield* emitTaskUsageSnapshot(context, message);
            context.terminalTaskIds.add(message.task_id);
            yield* settlePendingHumanInteractionsForAgent(context, message.task_id);
            context.knownBackgroundTaskIds.delete(message.task_id);
            const workflowTaskId = context.workflowTaskIdByMemberTaskId.get(message.task_id);
            // the output file's workflowProgress carries final per-agent state/model the live stream never surfaced
            const workflowOutputText =
              context.knownWorkflowTaskIds.has(message.task_id) &&
              typeof message.output_file === "string" &&
              message.output_file.length > 0
                ? yield* readClaudeWorkflowOutputText(fileSystem, message.output_file)
                : undefined;
            const parsedWorkflowAgents = workflowOutputText
              ? parseClaudeWorkflowProgressAgents(workflowOutputText)
              : undefined;
            // the output file has no effort — carry it over by agent id from the live poller
            const runtimeEffortByAgentId = new Map(
              Array.from(
                context.workflowRuntimeStates.get(message.task_id)?.agents.values() ?? [],
                (agent) => [agent.agentId, agent.effort] as const,
              ).filter((entry): entry is [string, string] => entry[1] !== undefined),
            );
            const workflowAgents = parsedWorkflowAgents?.map((agent) => {
              const effort = agent.agentId ? runtimeEffortByAgentId.get(agent.agentId) : undefined;
              return agent.effort === undefined && effort !== undefined
                ? Object.assign({}, agent, { effort })
                : agent;
            });
            yield* offerRuntimeEvent(context, {
              ...base,
              type: "task.completed",
              payload: {
                taskId: RuntimeTaskId.makeUnsafe(message.task_id),
                status: message.status,
                ...(message.summary ? { summary: message.summary } : {}),
                ...(message.usage ? { usage: message.usage } : {}),
                ...(workflowTaskId
                  ? { workflowTaskId: RuntimeTaskId.makeUnsafe(workflowTaskId) }
                  : {}),
                ...(workflowAgents ? { workflowAgents } : {}),
              },
            });
            context.liveWorkflowTaskIds.delete(message.task_id);
            context.knownWorkflowTaskIds.delete(message.task_id);
            context.workflowTaskIdByMemberTaskId.delete(message.task_id);
            context.workflowRuntimeStates.delete(message.task_id);
            yield* stopWorkflowRuntimePoller(context, message.task_id);
            const run = subagentRunForTask(context, message.tool_use_id, message.task_id);
            if (run) {
              context.subagentRuns.delete(run.toolUseId);
              context.pendingSubagentSteers.delete(run.toolUseId);
              context.pendingSubagentStops.delete(run.toolUseId);
              context.settledSubagentToolUseIds.set(run.toolUseId, message.status);
              if (run.context.turnState) {
                yield* completeTurn(run.context, claudeTaskTurnStatus(message.status));
              }
            }
            return;
          }
          case "files_persisted":
            yield* offerRuntimeEvent(context, {
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
          case "background_tasks_changed": {
            // REPLACE semantics: payload is the full live background set — announce only newly backgrounded work; removals settle via their own lifecycle
            const tasks = Array.isArray(message.tasks) ? message.tasks : [];
            const added = tasks.filter((task) => !context.knownBackgroundTaskIds.has(task.task_id));
            context.knownBackgroundTaskIds.clear();
            for (const task of tasks) {
              context.knownBackgroundTaskIds.add(task.task_id);
            }
            if (added.length === 0) {
              return;
            }
            const labels = added.map((task) =>
              task.description.trim().length > 0 ? task.description.trim() : task.task_type,
            );
            const notice =
              added.length === 1
                ? labels[0]!
                : `${added.length} tasks: ${labels.join(", ")}`.slice(0, 200);
            yield* emitRuntimeWarning(context, notice, message);
            return;
          }
          default:
            yield* warnUnhandledSdkKind(
              context,
              `system:${message.subtype}`,
              `Unhandled Claude system message subtype '${message.subtype}'.`,
              message,
            );
            return;
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
          yield* offerRuntimeEvent(context, {
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
          yield* offerRuntimeEvent(context, {
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
          yield* offerRuntimeEvent(context, {
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
          yield* offerRuntimeEvent(context, {
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
    ): Effect.Effect<void, ProviderAdapterProcessError> =>
      Effect.gen(function* () {
        yield* logNativeSdkMessage(context, message);

        // Claude sets parent_tool_use_id on async Bash progress too — route only ids already recognized as Task/Agent tools
        const subagentToolUseId = recognizedSubagentParentToolUseId(context, message);
        if (subagentToolUseId !== undefined) {
          // A settled task's zombie tail (messages already in flight when the stop landed) is dropped, not projected onto the settled child.
          if (context.settledSubagentToolUseIds.has(subagentToolUseId)) {
            return;
          }
          const run = ensureSubagentRun(context, subagentToolUseId);
          yield* ensureSyntheticTurn(run.context);
          switch (message.type) {
            case "stream_event":
              yield* handleStreamEvent(run.context, message);
              return;
            case "user":
              yield* handleUserMessage(run.context, message);
              return;
            case "assistant":
              yield* handleAssistantMessage(run.context, message);
              return;
            default:
              yield* handleSdkTelemetryMessage(run.context, message);
              return;
          }
        }

        yield* ensureThreadId(context, message);

        switch (message.type) {
          case "stream_event":
            yield* handleStreamEvent(context, message);
            return;
          case "user":
            yield* handleUserMessage(context, message);
            return;
          case "assistant":
            yield* handleAssistantMessage(context, message);
            return;
          case "conversation_reset":
            invalidateClaudeCache(context);
            // The query survives /clear even when its cumulative counters restart.
            delete context.resultUsageBaseline;
            context.requestUsage.reset();
            context.compactionMessageId = undefined;
            context.processedTokenTurnBaseline = context.processedTokenTotal;
            context.processedTokenResultBaseline = context.processedTokenTotal;
            yield* updateResumeCursor(context);
            return;
          case "result":
            yield* handleResultMessage(context, message);
            return;
          case "system":
            yield* handleSystemMessage(context, message);
            return;
          case "tool_progress":
          case "tool_use_summary":
          case "auth_status":
          case "rate_limit_event":
            yield* handleSdkTelemetryMessage(context, message);
            return;
          default:
            yield* warnUnhandledSdkKind(
              context,
              `type:${message.type}`,
              `Unhandled Claude SDK message type '${message.type}'.`,
              message,
            );
            return;
        }
      });

    const runSdkStream = (context: ClaudeSessionContext): Effect.Effect<void, Error> =>
      Stream.fromAsyncIterable(context.messageStream ?? context.query, (cause) =>
        toError(cause, "Claude runtime stream failed."),
      ).pipe(
        Stream.takeWhile(() => !context.stopped),
        Stream.runForEach((message) => handleSdkMessage(context, message)),
      );

    const handleStreamExit = (
      context: ClaudeSessionContext,
      exit: Exit.Exit<void, Error>,
    ): Effect.Effect<void, ProviderAdapterProcessError> =>
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
            // external SIGTERM/SIGINT: graceful suspend without error toast; next message pays a full resume replay
            yield* Effect.logInfo("claude.session.benign_termination", {
              threadId: context.session.threadId,
              hadActiveTurn: context.turnState !== undefined,
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
            if (isClaudeMissingResumeConversationCause(exit.cause)) {
              // the SDK can accept a resume then report the native conversation missing only after the prompt queues — drop dead ids so the next dispatch starts fresh and bootstraps the retained transcript
              context.resumeSessionId = undefined;
              context.lastAssistantUuid = undefined;
              // the map sources turn.tasks.updated — clearing it silently would strand the turn's task chips with no correction emitted
              if (context.trackedTasks.size > 0) {
                context.trackedTasks.clear();
                yield* emitTrackedTasksUpdated(context, {
                  rawPayload: { source: "claude.stale-resume-invalidated" },
                });
              }
              yield* Effect.logWarning("claude.session.stale_resume_invalidated", {
                threadId: context.session.threadId,
                detail: message,
              });
            }
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

    const performStopSessionInternal = (
      context: ClaudeSessionContext,
      options?: ClaudeStopSessionOptions,
    ): Effect.Effect<void, ProviderAdapterProcessError> =>
      Effect.gen(function* () {
        context.stopped = true;
        yield* cancelAgentGatewayTurn(context.gatewaySessionLease, context.turnState?.turnId);
        context.gatewaySessionLease?.release();

        yield* settlePendingHumanInteractions(context, { type: "session" });

        for (const run of context.subagentRuns.values()) {
          if (run.context.turnState) {
            yield* completeTurn(run.context, "interrupted", "Session stopped.");
          }
        }
        context.subagentRuns.clear();
        context.pendingSubagentSteers.clear();
        context.pendingSubagentStops.clear();

        for (const taskId of Array.from(context.workflowRuntimePollers.keys())) {
          yield* stopWorkflowRuntimePoller(context, taskId);
        }
        context.liveWorkflowTaskIds.clear();
        context.knownWorkflowTaskIds.clear();

        if (context.turnState) {
          yield* completeTurn(context, "interrupted", "Session stopped.");
        }

        yield* Queue.shutdown(context.promptQueue);

        const streamFiber = context.streamFiber;
        context.streamFiber = undefined;
        if (
          options?.interruptStream !== false &&
          streamFiber &&
          streamFiber.pollUnsafe() === undefined
        ) {
          yield* Fiber.interrupt(streamFiber);
        }

        // @effect-diagnostics-next-line tryCatchInEffectGen:off
        try {
          context.query.close();
        } catch (cause) {
          yield* emitRuntimeError(context, "Failed to close Claude runtime query.", cause);
        }
        // don't release session ownership until teardown proves the old process tree exited — the stopped context stays non-routable so no replacement spawns concurrently
        yield* teardownClaudeProcess(context.session.threadId, context.processOwner);

        const updatedAt = yield* nowIso;
        context.session = {
          ...context.session,
          status: "closed",
          activeTurnId: undefined,
          updatedAt,
        };

        if (options?.emitExitEvent !== false) {
          const stamp = yield* makeEventStamp();
          yield* offerRuntimeEvent(context, {
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

        if (sessions.get(context.session.threadId) === context) {
          sessions.delete(context.session.threadId);
        }
      });

    const stopSessionInternal = (
      context: ClaudeSessionContext,
      options?: ClaudeStopSessionOptions,
    ): Effect.Effect<void, ProviderAdapterProcessError> =>
      Effect.suspend(() => {
        if (context.stopDeferred) {
          return Deferred.await(context.stopDeferred);
        }
        const stopDeferred = Deferred.makeUnsafe<void, ProviderAdapterProcessError>();
        context.stopDeferred = stopDeferred;
        return performStopSessionInternal(context, options).pipe(
          Effect.onExit((exit) =>
            Deferred.done(stopDeferred, exit).pipe(
              Effect.andThen(
                Exit.isFailure(exit)
                  ? Effect.sync(() => {
                      if (context.stopDeferred === stopDeferred) {
                        delete context.stopDeferred;
                      }
                    })
                  : Effect.void,
              ),
              Effect.asVoid,
            ),
          ),
        );
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

    const assertSessionReplaceable = (threadId: ThreadId) =>
      Effect.suspend(() => {
        const context = sessions.get(threadId);
        return context && (context.pendingDispatches || hasActiveClaudeRuntimeWork(context))
          ? Effect.fail(
              new ProviderAdapterValidationError({
                provider: PROVIDER,
                operation: "session/reconfigure",
                issue:
                  "Wait for Claude's active turn, shared tasks, approvals and questions to finish before changing session settings.",
              }),
            )
          : Effect.void;
      });

    // only slash-shaped input pays for the lookup (served from the cached initialize response); no answer means the shape decides
    const resolveNativeCommandNames = (
      context: ClaudeSessionContext,
      text: string | undefined,
    ): Effect.Effect<ReadonlySet<string> | undefined> =>
      isClaudeNativeSlashCommand(text)
        ? Effect.tryPromise(() => context.query.supportedCommands()).pipe(
            Effect.timeoutOption(CLAUDE_NATIVE_COMMAND_LOOKUP_TIMEOUT_MS),
            Effect.map((commands) =>
              Option.isSome(commands)
                ? new Set(
                    commands.value.flatMap((command) => [command.name, ...(command.aliases ?? [])]),
                  )
                : undefined,
            ),
            Effect.orElseSucceed(() => undefined),
          )
        : Effect.succeed(undefined);

    // Keep version/binary validation ahead of retirement for permission Auto.
    const resolveClaudeStartPreflight = (
      input: Parameters<ClaudeAdapterShape["startSession"]>[0],
    ) =>
      Effect.gen(function* () {
        const claudeSdkEnv = yield* resolveClaudeSdkEnv;
        if (input.runtimeMode !== "auto") return { claudeSdkEnv, snapshotSupported: false };
        const binaryPath = input.providerOptions?.claudeAgent?.binaryPath ?? "claude";
        const installedVersion = yield* Effect.tryPromise({
          try: () =>
            readClaudeCliVersion({
              binaryPath,
              ...(input.cwd ? { cwd: input.cwd } : {}),
              env: claudeSdkEnv,
            }),
          catch: (cause) =>
            new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: `Could not verify Auto mode support for Claude CLI at "${binaryPath}": ${toMessage(cause, "version probe failed")}`,
            }),
        });
        if (!isClaudeAutoModeCliVersionSupported(installedVersion)) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue:
              installedVersion === null
                ? `Could not determine whether Claude CLI at "${binaryPath}" supports Auto mode.`
                : `Claude CLI ${installedVersion} at "${binaryPath}" does not support Auto mode; upgrade to ${MINIMUM_CLAUDE_AUTO_MODE_CLI_VERSION} or newer.`,
          });
        }
        return {
          claudeSdkEnv,
          snapshotSupported:
            installedVersion !== null && compareSemverVersions(installedVersion, "2.1.267") >= 0,
        };
      });

    const prepareSessionReplacement: NonNullable<
      ClaudeAdapterShape["prepareSessionReplacement"]
    > = (input) =>
      withSessionLifecycleLock(
        input.threadId,
        Effect.gen(function* () {
          const context = sessions.get(input.threadId);
          if (!context) return undefined;
          const preflight = yield* resolveClaudeStartPreflight(input).pipe(
            Effect.mapError(
              (error) =>
                new ProviderAdapterValidationError({
                  provider: PROVIDER,
                  operation: "session/reconfigure",
                  issue: error.issue,
                }),
            ),
          );
          // Work can arrive during the asynchronous version probe. Check last.
          yield* assertSessionReplaceable(input.threadId);
          const session = context.session;
          yield* stopSessionInternal(context, { emitExitEvent: false });
          return {
            previousSession: session,
            startSession: (startInput) =>
              withSessionLifecycleLock(
                startInput.threadId,
                startSessionUnlocked(startInput, preflight),
              ),
          };
        }),
      );

    const startSessionUnlocked = (
      input: Parameters<ClaudeAdapterShape["startSession"]>[0],
      preflight?: Effect.Success<ReturnType<typeof resolveClaudeStartPreflight>>,
    ): ReturnType<ClaudeAdapterShape["startSession"]> =>
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
        const pendingSubagentSteers = new Map<string, Array<string>>();
        const pendingSubagentStops = new Set<string>();
        const inFlightTools = new Map<number, ToolInFlight>();
        const trackedTasks = new Map<string, ClaudeTrackedTask>(
          (resumeState?.trackedTasks ?? []).map((task) => [task.id, task]),
        );

        const contextRef = yield* Ref.make<ClaudeSessionContext | undefined>(undefined);
        // auto init can run hooks before contextRef is installed — keep one observation in this start's closure, never a global buffer
        let startupCacheObservation: ClaudeCacheObservation | undefined;
        const sessionStartHook = async (
          hookInput: HookInput,
          _toolUseId: string | undefined,
          options: { signal: AbortSignal },
        ): Promise<HookJSONOutput> => {
          if (options.signal.aborted || hookInput.hook_event_name !== "SessionStart") return {};
          if (sessionId && hookInput.session_id !== sessionId) return {};
          const nativeObservation = claudeCacheFromSessionStart(
            hookInput as unknown as Record<string, unknown>,
            new Date(cacheClock.currentTimeMillisUnsafe()).toISOString(),
            input.lifecycleGeneration,
          );
          if (!nativeObservation) return {};
          const current = Effect.runSync(Ref.get(contextRef));
          const previous = current ? current.cacheObservation : resumeState?.claudeCache;
          const observation: ClaudeCacheObservation = {
            ...(previous?.nativeSessionId === nativeObservation.nativeSessionId ? previous : {}),
            ...nativeObservation,
          };
          if (!current) startupCacheObservation = observation;
          else if (
            !current.stopped &&
            sessions.get(threadId) === current &&
            current.resumeSessionId === observation.nativeSessionId &&
            !current.hasObservedCacheRequest
          ) {
            current.cacheObservation = claudeCacheForModel(observation, current.currentApiModelId);
            syncClaudeCacheResumeCursor(current);
            Effect.runFork(emitClaudeCacheObservation(current));
          }
          return {};
        };

        const handleAskUserQuestion = (
          context: ClaudeSessionContext,
          toolInput: Record<string, unknown>,
          callbackOptions: Parameters<CanUseTool>[2],
        ) =>
          Effect.gen(function* () {
            if (
              callbackOptions.signal.aborted ||
              context.stopped ||
              (callbackOptions.agentID !== undefined &&
                context.terminalTaskIds.has(callbackOptions.agentID))
            ) {
              return {
                behavior: "deny",
                message: "User cancelled tool execution.",
              } satisfies PermissionResult;
            }
            const requestId = ApprovalRequestId.makeUnsafe(yield* Random.nextUUIDv4);
            const interactionTurnId =
              context.turnState?.turnId ??
              (callbackOptions.agentID !== undefined ? context.lastTurnId : undefined);

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

            const resultDeferred = yield* Deferred.make<PendingUserInputResult>();
            const settledDeferred = yield* Deferred.make<PendingUserInputResult>();
            const pendingInput: PendingUserInput = {
              questions,
              result: resultDeferred,
              settled: settledDeferred,
              ...(interactionTurnId !== undefined ? { turnId: interactionTurnId } : {}),
              ...(callbackOptions.toolUseID ? { providerItemId: callbackOptions.toolUseID } : {}),
              ...(callbackOptions.agentID !== undefined
                ? { agentId: callbackOptions.agentID }
                : {}),
              settlementStarted: false,
            };

            // stamp before registering ownership so terminal settlement can't publish a resolution before its request
            const requestedStamp = yield* makeEventStamp();
            pendingUserInputs.set(requestId, pendingInput);
            yield* offerRuntimeEvent(context, {
              type: "user-input.requested",
              eventId: requestedStamp.eventId,
              provider: PROVIDER,
              createdAt: requestedStamp.createdAt,
              threadId: context.session.threadId,
              ...(interactionTurnId !== undefined
                ? { turnId: asCanonicalTurnId(interactionTurnId) }
                : {}),
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

            if (
              callbackOptions.agentID !== undefined &&
              context.terminalTaskIds.has(callbackOptions.agentID)
            ) {
              yield* settlePendingUserInput(context, requestId, pendingInput, {
                answers: {},
                cancelled: true,
              });
            }

            const onAbort = () => {
              Effect.runFork(
                settlePendingUserInput(context, requestId, pendingInput, {
                  answers: {},
                  cancelled: true,
                }),
              );
            };
            callbackOptions.signal.addEventListener("abort", onAbort, { once: true });
            if (callbackOptions.signal.aborted) onAbort();

            const result = yield* Deferred.await(resultDeferred).pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  callbackOptions.signal.removeEventListener("abort", onAbort);
                }),
              ),
            );

            if (result.cancelled) {
              return {
                behavior: "deny",
                message: "User cancelled tool execution.",
              } satisfies PermissionResult;
            }

            return {
              behavior: "allow",
              updatedInput: {
                questions: toolInput.questions,
                answers: remapAnswersToClaudeQuestionText(questions, result.answers),
              },
            } satisfies PermissionResult;
          });

        // PreToolUse is the only SDK channel reaching a RUNNING subagent; it fires on every tool call so the no-steer path stays trivial and queued messages drain on the next call
        const subagentSteerHook = async (hookInput: HookInput): Promise<HookJSONOutput> => {
          const agentId = "agent_id" in hookInput ? hookInput.agent_id : undefined;
          if (pendingSubagentSteers.size === 0 || typeof agentId !== "string") {
            return {};
          }
          return Effect.runPromise(
            Effect.gen(function* () {
              const context = yield* Ref.get(contextRef);
              if (!context) {
                return {};
              }
              let run: ClaudeSubagentRun | undefined;
              for (const candidate of context.subagentRuns.values()) {
                if (candidate.taskId === agentId) {
                  run = candidate;
                  break;
                }
              }
              const pending = run ? pendingSubagentSteers.get(run.toolUseId) : undefined;
              if (!run || !pending || pending.length === 0) {
                return {};
              }
              pendingSubagentSteers.delete(run.toolUseId);
              const message = pending.join("\n\n");
              yield* emitSubagentSteerDelivered(run, message);
              return {
                hookSpecificOutput: {
                  hookEventName: "PreToolUse",
                  additionalContext: claudeSubagentSteerContext(message),
                },
              } satisfies HookJSONOutput;
            }),
          ).catch(() => ({}));
        };

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
              if (runtimeMode === "full-access" || context.approvalsAlwaysAllowedForSession) {
                return {
                  behavior: "allow",
                  updatedInput: toolInput,
                } satisfies PermissionResult;
              }

              // in Auto mode canUseTool fires only for the classifier's "ask" outcome — keep the prompt so risky calls still reach the user
              const requestId = ApprovalRequestId.makeUnsafe(yield* Random.nextUUIDv4);
              const requestType = classifyRequestType(toolName);
              const detail = summarizeToolRequest(toolName, toolInput);
              const interactionTurnId =
                context.turnState?.turnId ??
                (callbackOptions.agentID !== undefined ? context.lastTurnId : undefined);
              const decisionDeferred = yield* Deferred.make<ProviderApprovalDecision>();
              const settledDeferred = yield* Deferred.make<ProviderApprovalDecision>();
              const pendingApproval: PendingApproval = {
                requestType,
                detail,
                decision: decisionDeferred,
                settled: settledDeferred,
                ...(interactionTurnId !== undefined ? { turnId: interactionTurnId } : {}),
                ...(callbackOptions.toolUseID ? { providerItemId: callbackOptions.toolUseID } : {}),
                ...(callbackOptions.agentID !== undefined
                  ? { agentId: callbackOptions.agentID }
                  : {}),
                settlementStarted: false,
                ...(callbackOptions.suggestions && callbackOptions.suggestions.length > 0
                  ? { suggestions: callbackOptions.suggestions }
                  : {}),
              };

              const requestedStamp = yield* makeEventStamp();
              yield* offerRuntimeEvent(context, {
                type: "request.opened",
                eventId: requestedStamp.eventId,
                provider: PROVIDER,
                createdAt: requestedStamp.createdAt,
                threadId: context.session.threadId,
                ...(interactionTurnId !== undefined
                  ? { turnId: asCanonicalTurnId(interactionTurnId) }
                  : {}),
                requestId: asRuntimeRequestId(requestId),
                payload: {
                  requestType,
                  detail,
                  args: {
                    toolName,
                    input: toolInput,
                    sessionApprovalAvailable:
                      callbackOptions.suggestions !== undefined &&
                      callbackOptions.suggestions.length > 0,
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
              if (
                callbackOptions.agentID !== undefined &&
                context.terminalTaskIds.has(callbackOptions.agentID)
              ) {
                yield* settlePendingApproval(context, requestId, pendingApproval, "cancel");
              }

              const onAbort = () => {
                Effect.runFork(
                  settlePendingApproval(context, requestId, pendingApproval, "cancel"),
                );
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

              if (decision === "accept" || decision === "acceptForSession") {
                if (decision === "acceptForSession" && runtimeMode !== "auto") {
                  // SDK permission suggestions cover only some requests; supervised keeps its live "always allow" fallback, Auto stays reviewer-gated
                  context.approvalsAlwaysAllowedForSession = true;
                }
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
        const requestedAutoCompactWindow = normalizeClaudeModelOptions(
          modelSelection?.model,
          modelSelection?.options,
        )?.autoCompactWindow;
        const effectiveClaudeModel = modelSelection?.model ?? getDefaultModel("claudeAgent");
        const caps = getModelCapabilities("claudeAgent", effectiveClaudeModel);
        const requestedAutoCompactWindowTokens = resolveSelectedClaudeAutoCompactWindow(
          effectiveClaudeModel,
          requestedAutoCompactWindow,
        );
        const apiModelId = modelSelection ? resolveApiModelId(modelSelection) : undefined;
        const effort =
          requestedEffort && hasEffortLevel(caps, requestedEffort) ? requestedEffort : null;
        const fastMode = modelSelection?.options?.fastMode === true && caps.supportsFastMode;
        const thinking = resolveSelectedClaudeThinkingToggle(
          effectiveClaudeModel,
          modelSelection?.options?.thinking,
        );
        const effectiveEffort = getEffectiveClaudeCodeEffort(effort);
        const ultracode = effort === "ultracode" && hasEffortLevel(caps, "xhigh");
        const permissionMode =
          input.runtimeMode === "auto"
            ? "auto"
            : (toPermissionMode(providerOptions?.permissionMode) ??
              (input.runtimeMode === "full-access" ? "bypassPermissions" : undefined));
        const settings = {
          // pin only explicit non-native overrides — Claude Code owns resolution otherwise (server tuning, settings.json, env)
          autoCompactEnabled: true,
          ...(requestedAutoCompactWindowTokens !== undefined
            ? { autoCompactWindow: requestedAutoCompactWindowTokens }
            : {}),
          ...(typeof thinking === "boolean" ? { alwaysThinkingEnabled: thinking } : {}),
          // non-max effort lives in flag-settings so it changes live; `max` has no Settings equivalent (effortLevel caps at xhigh) and stays a spawn option
          ...(effectiveEffort && effectiveEffort !== "max" ? { effortLevel: effectiveEffort } : {}),
          ...(fastMode ? { fastMode: true } : {}),
          ...(ultracode ? { ultracode: true } : {}),
        };
        const claudeSubagents = buildClaudeSdkSubagents();
        const { claudeSdkEnv, snapshotSupported } =
          preflight ?? (yield* resolveClaudeStartPreflight(input));
        const failedStartupProcessOwner = failedStartupProcessOwners.get(threadId);
        if (failedStartupProcessOwner) {
          // a prior createQuery failure may have spawned first — never create another runtime until that orphan's exit is proven; a failed replacement is truthfully a stopped session
          yield* teardownFailedStartupProcess(threadId, failedStartupProcessOwner);
        }
        const existing = sessions.get(threadId);
        if (existing) {
          yield* assertSessionReplaceable(threadId);
          yield* stopSessionInternal(existing, { emitExitEvent: false });
        }
        const processOwner: ClaudeProcessOwner = {};

        const gatewaySessionLease = acquireAgentGatewaySessionLease(
          agentGatewayCredentials,
          threadId,
          PROVIDER,
        );
        const queryOptions: ClaudeQueryOptions = {
          ...(input.cwd ? { cwd: input.cwd } : {}),
          ...(apiModelId ? { model: apiModelId } : {}),
          pathToClaudeCodeExecutable: providerOptions?.binaryPath ?? "claude",
          settingSources: [...CLAUDE_SETTING_SOURCES],
          systemPrompt: {
            type: "preset",
            preset: "claude_code",
            append: buildEmbeddedClaudeSystemPromptAppend(agentGatewayCredentials !== undefined),
            // per-user dynamic sections move into the first user message so the cached system-prompt prefix stays static across sessions/users (tradeoff: marginally less authoritative steering)
            excludeDynamicSections: true,
            ...(snapshotSupported ? { snapshot: true } : {}),
          },
          ...(Object.keys(claudeSubagents).length > 0 ? { agents: claudeSubagents } : {}),
          // only `max` effort is spawn-fixed; every other level rides settings.effortLevel for live changes
          ...(effectiveEffort === "max" ? { effort: "max" as const } : {}),
          ...(permissionMode ? { permissionMode } : {}),
          ...(permissionMode === "bypassPermissions"
            ? { allowDangerouslySkipPermissions: true }
            : {}),
          ...(providerOptions?.maxThinkingTokens !== undefined
            ? { maxThinkingTokens: providerOptions.maxThinkingTokens }
            : {}),
          settings,
          ...(existingResumeSessionId ? { resume: existingResumeSessionId } : {}),
          ...(newSessionId ? { sessionId: newSessionId } : {}),
          includePartialMessages: true,
          forwardSubagentText: true,
          hooks: {
            SessionStart: [{ hooks: [sessionStartHook] }],
            PreToolUse: [{ hooks: [subagentSteerHook] }],
          },
          canUseTool,
          env: withClaudeArtifactOptIn(claudeSdkEnv, providerOptions?.enableArtifacts),
          spawnClaudeCodeProcess: bindClaudeProcessOwner(processOwner),
          ...(input.cwd ? { additionalDirectories: [input.cwd] } : {}),
          ...(agentGatewayCredentials
            ? {
                mcpServers: buildClaudeMcpServers(gatewaySessionLease!.connection),
              }
            : {}),
        };

        const queryRuntime = yield* Effect.tryPromise({
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
        }).pipe(
          Effect.tapError(() =>
            Effect.all([
              teardownFailedStartupProcess(threadId, processOwner).pipe(
                Effect.catch((error) =>
                  Effect.sync(() => {
                    if (processOwner.process) {
                      failedStartupProcessOwners.set(threadId, processOwner);
                    }
                  }).pipe(
                    Effect.andThen(
                      Effect.logWarning("claude.session.failed_start_teardown_unproven", {
                        threadId,
                        detail: error.message,
                      }),
                    ),
                  ),
                ),
              ),
              gatewaySessionLease ? Effect.sync(gatewaySessionLease.release) : Effect.void,
            ]).pipe(Effect.asVoid),
          ),
        );
        const messageStream =
          input.runtimeMode === "auto" ? prestartClaudeMessageStream(queryRuntime) : undefined;

        let installationContext: ClaudeSessionContext | undefined;
        let installationComplete = false;

        return yield* Effect.gen(function* () {
          if (input.runtimeMode === "auto") {
            yield* verifyClaudeAutoModelSupport({
              queryRuntime,
              selectedModel: effectiveClaudeModel,
              apiModelId,
              operation: "startSession",
            });
          } else if (!cachedModels) {
            queryRuntime
              .supportedModels()
              .then((models) => {
                cachedModels = {
                  models: models.map(mapClaudeModelInfo),
                  source: "sdk",
                  cached: false,
                };
              })
              .catch(() => {});
          }

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
              .catch(() => {});
          }

          const processedTokenBaselineKnown =
            input.resumeCursor === undefined || resumeState?.processedTokenTotal !== undefined;
          const cacheObservation = claudeCacheForModel(
            startupCacheObservation ?? resumeState?.claudeCache,
            apiModelId,
          );
          const initialCacheObservation = cacheObservation
            ? {
                ...cacheObservation,
                ...(input.lifecycleGeneration
                  ? { lifecycleGeneration: input.lifecycleGeneration }
                  : {}),
              }
            : undefined;
          const session: ProviderSession = {
            threadId,
            provider: PROVIDER,
            status: "ready",
            runtimeMode: input.runtimeMode,
            ...(input.cwd ? { cwd: input.cwd } : {}),
            ...(modelSelection?.model ? { model: modelSelection.model } : {}),
            ...(threadId ? { threadId } : {}),
            resumeCursor: {
              ...(initialCacheObservation ? { claudeCache: initialCacheObservation } : {}),
              ...(threadId ? { threadId } : {}),
              ...(sessionId ? { resume: sessionId } : {}),
              ...(resumeState?.resumeSessionAt
                ? { resumeSessionAt: resumeState.resumeSessionAt }
                : {}),
              turnCount: resumeState?.turnCount ?? 0,
              ...(trackedTasks.size > 0 ? { trackedTasks: Array.from(trackedTasks.values()) } : {}),
              ...(processedTokenBaselineKnown
                ? {
                    processedTokenTotal: resumeState?.processedTokenTotal ?? 0,
                    tokenAccountingVersion: 1,
                  }
                : {}),
            },
            createdAt: startedAt,
            updatedAt: startedAt,
          };

          const context: ClaudeSessionContext = {
            ...(initialCacheObservation ? { cacheObservation: initialCacheObservation } : {}),
            ...(gatewaySessionLease ? { gatewaySessionLease } : {}),
            session,
            artifactsEnabled: providerOptions?.enableArtifacts === true,
            ...(input.lifecycleGeneration !== undefined
              ? { lifecycleGeneration: input.lifecycleGeneration }
              : {}),
            promptQueue,
            query: queryRuntime,
            ...(messageStream ? { messageStream } : {}),
            processOwner,
            streamFiber: undefined,
            startedAt,
            basePermissionMode: permissionMode,
            // a fresh CLI starts in queryOptions' permissionMode, else the SDK's "default"
            spawnPermissionMode: permissionMode ?? "default",
            firstTurnSpawnModeAuthoritative: true,
            lastInteractionMode: undefined,
            currentApiModelId: apiModelId,
            resumeSessionId: sessionId,
            pendingApprovals,
            approvalsAlwaysAllowedForSession: false,
            pendingUserInputs,
            turns: [],
            inFlightTools,
            trackedTasks,
            turnState: undefined,
            lastTurnId: undefined,
            interruptRequestedTurnId: undefined,
            lastKnownContextWindow: resolveClaudeApiModelIdContextWindowMaxTokens(
              apiModelId ?? effectiveClaudeModel,
            ),
            currentAutoCompactWindow: requestedAutoCompactWindowTokens,
            currentAlwaysThinkingEnabled: thinking,
            currentEffort: effectiveEffort,
            currentUltracode: ultracode,
            currentFastMode: fastMode,
            lastKnownAutoCompactThreshold: requestedAutoCompactWindowTokens,
            contextUsageControlEnabled: true,
            lastKnownTokenUsage: undefined,
            tokenUsageState: "current",
            compactionMessageId: undefined,
            processedTokenTotal: resumeState?.processedTokenTotal ?? 0,
            processedTokenTurnBaseline: resumeState?.processedTokenTotal ?? 0,
            processedTokenResultBaseline: resumeState?.processedTokenTotal ?? 0,
            processedTokenBaselineKnown,
            requestUsage: new ClaudeRequestUsage(),
            lastResultUuid: undefined,
            lastAssistantUuid: resumeState?.resumeSessionAt,
            lastThreadStartedId: undefined,
            rerouteOriginalApiModelId: undefined,
            emittedContextUsageWarnings: new Set(),
            stopped: false,
            warnedUnhandledSdkKinds: new Set(),
            subagentRuns: new Map(),
            pendingSubagentSteers,
            pendingSubagentStops,
            knownBackgroundTaskIds: new Set(),
            terminalTaskIds: new Set(),
            settledSubagentToolUseIds: new Map(),
            liveWorkflowTaskIds: new Set(),
            knownWorkflowTaskIds: new Set(),
            workflowTaskIdByMemberTaskId: new Map(),
            workflowRuntimePollers: new Map(),
            workflowAgentLabels: new Map(),
            workflowRuntimeStates: new Map(),
          };
          installationContext = context;
          yield* Effect.gen(function* () {
            yield* Ref.set(contextRef, context);
            sessions.set(threadId, context);

            const sessionStartedStamp = yield* makeEventStamp();
            yield* offerRuntimeEvent(context, {
              type: "session.started",
              eventId: sessionStartedStamp.eventId,
              provider: PROVIDER,
              createdAt: sessionStartedStamp.createdAt,
              threadId,
              payload: input.resumeCursor !== undefined ? { resume: input.resumeCursor } : {},
              providerRefs: {},
            });
            yield* emitClaudeCacheObservation(context);

            const configuredStamp = yield* makeEventStamp();
            yield* offerRuntimeEvent(context, {
              type: "session.configured",
              eventId: configuredStamp.eventId,
              provider: PROVIDER,
              createdAt: configuredStamp.createdAt,
              threadId,
              payload: {
                config: {
                  ...(modelSelection?.model ? { model: modelSelection.model } : {}),
                  ...(apiModelId ? { apiModelId } : {}),
                  autoCompactWindow: requestedAutoCompactWindowTokens ?? null,
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
            yield* offerRuntimeEvent(context, {
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
          });

          installationComplete = true;
          return {
            ...context.session,
          };
        }).pipe(
          Effect.ensuring(
            Effect.suspend(() => {
              if (installationComplete) {
                return Effect.void;
              }
              if (installationContext !== undefined) {
                return stopSessionInternal(installationContext, {
                  emitExitEvent: false,
                }).pipe(Effect.ignore);
              }
              return Effect.gen(function* () {
                gatewaySessionLease?.release();
                yield* Queue.shutdown(promptQueue);
                const closeExit = yield* Effect.exit(Effect.sync(() => queryRuntime.close()));
                if (Exit.isFailure(closeExit)) {
                  yield* Effect.logWarning("claude.session.failed_install_cleanup", {
                    threadId,
                    cause: Cause.pretty(closeExit.cause),
                  });
                }
                yield* teardownFailedStartupProcess(threadId, processOwner);
              });
            }).pipe(Effect.ignore),
          ),
        );
      });

    const startSession: ClaudeAdapterShape["startSession"] = (input) =>
      withSessionLifecycleLock(input.threadId, startSessionUnlocked(input));

    const getClaudeCacheObservation: NonNullable<
      ClaudeAdapterShape["getClaudeCacheObservation"]
    > = (threadId) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        const usage = yield* readClaudeContextUsage(context);
        if (context.stopped || sessions.get(threadId) !== context) return undefined;
        const observedAt = yield* nowIso;
        const previous = claudeCacheForModel(context.cacheObservation, context.currentApiModelId);
        const contextTokens =
          (usage ? claudeCacheContextTokens(usage) : undefined) ?? previous?.contextTokens;
        if (!previous && contextTokens === undefined) return undefined;
        // SessionStart can report cache warmth without a model — bind that evidence before preflight compares a requested switch
        const model = previous?.model ?? context.currentApiModelId;
        const observation: ClaudeCacheObservation = {
          ...(previous ?? {
            observedAt,
            state: "unknown" as const,
            source: "local-estimate" as const,
            ...(context.resumeSessionId ? { nativeSessionId: context.resumeSessionId } : {}),
          }),
          ...(model ? { model } : {}),
          ...(context.lifecycleGeneration
            ? { lifecycleGeneration: context.lifecycleGeneration }
            : {}),
          ...(contextTokens !== undefined ? { contextTokens } : {}),
        };
        const state = assessClaudeCache(observation, Date.parse(observedAt)).state;
        context.cacheObservation = { ...observation, state };
        syncClaudeCacheResumeCursor(context);
        yield* emitClaudeCacheObservation(context);
        return context.cacheObservation;
      });

    // re-send the mode every turn so sticky SDK state can't leak plan mode across recovery paths; skip only the provably-redundant first-turn case (spawn mode is authoritative only before the first prompt)
    const applyInteractionModePermission = (
      context: ClaudeSessionContext,
      threadId: ThreadId,
      interactionMode: ProviderSendTurnInput["interactionMode"],
    ): Effect.Effect<ProviderInteractionMode, ProviderAdapterError> =>
      Effect.gen(function* () {
        const effectiveInteractionMode = interactionMode ?? "default";
        const desiredPermissionMode: PermissionMode | undefined =
          effectiveInteractionMode === "plan"
            ? "plan"
            : context.basePermissionMode !== undefined || context.lastInteractionMode === "plan"
              ? (context.basePermissionMode ?? "default")
              : undefined;
        const canSkipRedundantSpawnModeRequest =
          context.firstTurnSpawnModeAuthoritative &&
          desiredPermissionMode === context.spawnPermissionMode;
        if (desiredPermissionMode !== undefined && !canSkipRedundantSpawnModeRequest) {
          yield* Effect.tryPromise({
            try: () => context.query.setPermissionMode(desiredPermissionMode),
            catch: (cause) => toRequestError(threadId, "turn/setPermissionMode", cause),
          });
        }
        return effectiveInteractionMode;
      });

    const sendTurnCore = (
      input: ProviderSendTurnInput,
      compactionTurnId?: TurnId,
    ): ReturnType<ClaudeAdapterShape["sendTurn"]> =>
      Effect.gen(function* () {
        const context = yield* requireSession(input.threadId);
        const isCompaction =
          compactionTurnId !== undefined || isClaudeCompactionCommand(input.input);
        if (isCompaction && (input.attachments?.length ?? 0) > 0) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startClaudeCompaction",
            issue:
              "Native Claude compaction does not accept attachments. Remove them before compacting.",
          });
        }
        if (isCompaction) {
          const commands = yield* Effect.tryPromise({
            try: () => context.query.supportedCommands(),
            // discovery is read-only and precedes enqueue — a failed lookup proves this compaction was never dispatched
            catch: (cause) =>
              new ProviderAdapterValidationError({
                provider: PROVIDER,
                operation: "startClaudeCompaction",
                issue: `Could not discover native compaction support: ${toMessage(cause, "Command discovery failed.")}`,
              }),
          }).pipe(Effect.timeoutOption(CLAUDE_CONTEXT_USAGE_TIMEOUT_MS));
          if (
            Option.isNone(commands) ||
            !commands.value.some((command) => command.name === "compact")
          ) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startClaudeCompaction",
              issue: "Native context compaction is unavailable in this Claude runtime.",
            });
          }
          if (context.stopped || sessions.get(input.threadId) !== context) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startClaudeCompaction",
              issue: "Claude's session changed while preparing compaction. Try again.",
            });
          }
        }
        if (isCompaction && hasActiveClaudeCompactionWork(context)) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startClaudeCompaction",
            issue: "Wait for Claude's active turn and shared tasks to finish before compacting.",
          });
        }
        if (isCompaction && !context.resumeSessionId) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startClaudeCompaction",
            issue: "Claude's native session identity is unavailable for compaction.",
          });
        }
        const modelSelection =
          input.modelSelection?.provider === "claudeAgent" ? input.modelSelection : undefined;
        const requestedAutoCompactWindow = resolveSelectedClaudeAutoCompactWindow(
          modelSelection?.model,
          normalizeClaudeModelOptions(modelSelection?.model, modelSelection?.options)
            ?.autoCompactWindow,
        );

        if (context.turnState) {
          // auto-close a stale synthetic turn so it can't block the user's next turn
          yield* completeTurn(context, "completed");
        }

        if (hasOnlyCompletedClaudeTasks(context.trackedTasks)) {
          context.trackedTasks.clear();
          yield* updateResumeCursor(context);
        }

        let apiModelChanged = false;
        if (modelSelection?.model) {
          const apiModelId = resolveApiModelId(modelSelection);
          if (apiModelId !== context.currentApiModelId) {
            apiModelChanged = true;
            if (context.session.runtimeMode === "auto") {
              yield* verifyClaudeAutoModelSupport({
                queryRuntime: context.query,
                selectedModel: modelSelection.model,
                apiModelId,
                operation: "sendTurn",
              });
            }
            yield* Effect.tryPromise({
              try: () => context.query.setModel(apiModelId),
              catch: (cause) => toRequestError(input.threadId, "turn/setModel", cause),
            });
          }
          context.currentApiModelId = apiModelId;
          context.rerouteOriginalApiModelId = undefined;
          if (apiModelChanged) {
            context.cacheObservation = claudeCacheForModel(context.cacheObservation, apiModelId);
            context.lastKnownContextWindow =
              resolveClaudeApiModelIdContextWindowMaxTokens(apiModelId);
            context.lastKnownAutoCompactThreshold = requestedAutoCompactWindow;
          }
          yield* updateResumeCursor(context);
        }

        // re-announce model switches but never label a catalog capacity as the effective auto window — Claude settings/runtime tuning own it
        if (modelSelection && apiModelChanged) {
          context.emittedContextUsageWarnings.delete("near-window");
          context.emittedContextUsageWarnings.delete("large-prompt");

          const configuredWindow = {
            autoCompactWindow: requestedAutoCompactWindow ?? null,
            model: modelSelection.model,
            apiModelId: context.currentApiModelId,
          };
          const configuredStamp = yield* makeEventStamp();
          yield* offerRuntimeEvent(context, {
            type: "session.configured",
            eventId: configuredStamp.eventId,
            provider: PROVIDER,
            createdAt: configuredStamp.createdAt,
            threadId: input.threadId,
            payload: { config: configuredWindow },
            providerRefs: nativeProviderRefs(context),
          });
        }

        // the thinking toggle mirrors spawn-time alwaysThinkingEnabled; flipping it live avoids a restart-and-resume replay
        const requestedThinking = resolveSelectedClaudeThinkingToggle(
          modelSelection?.model,
          modelSelection?.options?.thinking,
        );
        if (modelSelection && requestedThinking !== context.currentAlwaysThinkingEnabled) {
          yield* Effect.tryPromise({
            try: () =>
              context.query.applyFlagSettings({
                alwaysThinkingEnabled: requestedThinking ?? null,
              }),
            catch: (cause) => toRequestError(input.threadId, "turn/applyFlagSettings", cause),
          });
          context.currentAlwaysThinkingEnabled = requestedThinking;
        }

        // effort/fast/ultracode are Settings keys so changes apply live; `max` effort has none and restarts upstream first
        if (modelSelection) {
          const turnCaps = getModelCapabilities("claudeAgent", modelSelection.model);
          const requestedEffortOption = trimOrNull(modelSelection.options?.effort ?? null);
          const validEffort =
            requestedEffortOption && hasEffortLevel(turnCaps, requestedEffortOption)
              ? requestedEffortOption
              : null;
          const requestedEffort = getEffectiveClaudeCodeEffort(validEffort);
          const requestedUltracode =
            validEffort === "ultracode" && hasEffortLevel(turnCaps, "xhigh");
          const requestedFastMode =
            modelSelection.options?.fastMode === true && turnCaps.supportsFastMode;
          const effortChanged =
            requestedEffort !== context.currentEffort &&
            requestedEffort !== "max" &&
            context.currentEffort !== "max";
          const ultracodeChanged = requestedUltracode !== context.currentUltracode;
          const fastModeChanged = requestedFastMode !== context.currentFastMode;
          if (effortChanged || ultracodeChanged || fastModeChanged) {
            yield* Effect.tryPromise({
              try: () =>
                context.query.applyFlagSettings({
                  ...(effortChanged
                    ? { effortLevel: requestedEffort as Exclude<ClaudeApiEffort, "max"> | null }
                    : {}),
                  ...(ultracodeChanged ? { ultracode: requestedUltracode ? true : null } : {}),
                  ...(fastModeChanged ? { fastMode: requestedFastMode ? true : null } : {}),
                }),
              catch: (cause) => toRequestError(input.threadId, "turn/applyFlagSettings", cause),
            });
            if (effortChanged) {
              context.currentEffort = requestedEffort;
            }
            context.currentUltracode = requestedUltracode;
            context.currentFastMode = requestedFastMode;
          }
        }

        const effectiveInteractionMode = isCompaction
          ? (context.lastInteractionMode ?? "default")
          : yield* applyInteractionModePermission(context, input.threadId, input.interactionMode);

        const turnId = compactionTurnId ?? TurnId.makeUnsafe(yield* Random.nextUUIDv4);
        context.processedTokenTurnBaseline = context.processedTokenTotal;
        const turnState: ClaudeTurnState = {
          turnId,
          startedAt: yield* nowIso,
          interactionMode: effectiveInteractionMode,
          ...(isCompaction
            ? {
                explicitCompaction: {
                  nativeSessionId: context.resumeSessionId!,
                  boundaryObserved: false,
                },
              }
            : {}),
          items: [],
          assistantTextBlocks: new Map(),
          assistantTextBlockOrder: [],
          capturedProposedPlanKeys: new Set(),
          sawFileChange: false,
          nextSyntheticAssistantBlockIndex: -1,
          assistantMessageBlockBase: 0,
        };

        const updatedAt = yield* nowIso;
        // native events can arrive during async prep — reserve only after one final synchronous idle check
        if (
          isCompaction &&
          (context.stopped ||
            sessions.get(input.threadId) !== context ||
            hasActiveClaudeCompactionWork(context))
        ) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startClaudeCompaction",
            issue:
              "Claude's session became active while preparing compaction. Try again when idle.",
          });
        }
        context.turnState = turnState;
        context.lastTurnId = turnId;
        context.session = {
          ...context.session,
          status: "running",
          activeTurnId: turnId,
          updatedAt,
        };

        const turnStartedStamp = yield* makeEventStamp();
        yield* offerRuntimeEvent(context, {
          type: "turn.started",
          eventId: turnStartedStamp.eventId,
          provider: PROVIDER,
          createdAt: turnStartedStamp.createdAt,
          threadId: context.session.threadId,
          turnId,
          payload: context.currentApiModelId
            ? { model: stripClaudeContextWindowSuffix(context.currentApiModelId) }
            : modelSelection?.model
              ? { model: modelSelection.model }
              : {},
          providerRefs: {},
        });

        if (isCompaction) yield* emitCompactionProgress(context);

        if (hasUnfinishedClaudeTasks(context.trackedTasks)) {
          yield* emitTrackedTasksUpdated(context, {
            rawPayload: {
              source: "claude.resume-cursor",
              trackedTaskCount: context.trackedTasks.size,
            },
          });
        }

        const message = yield* buildUserMessageEffect(input, {
          fileSystem,
          attachmentsDir: serverConfig.attachmentsDir,
          nativeCommandNames: yield* resolveNativeCommandNames(context, input.input),
        });

        yield* Queue.offer(context.promptQueue, {
          type: "message",
          message,
        }).pipe(Effect.mapError((cause) => toRequestError(input.threadId, "turn/start", cause)));

        // after the first prompt the CLI's mode is unprovable — every later turn re-sends unconditionally
        context.firstTurnSpawnModeAuthoritative = false;

        return {
          threadId: context.session.threadId,
          turnId,
          ...(context.session.resumeCursor !== undefined
            ? { resumeCursor: context.session.resumeCursor }
            : {}),
        };
      });

    // reserve dispatch before async controls so a replacement can't retire a session that accepted a send but hasn't installed its turn
    const withPendingDispatch = (
      input: ProviderSendTurnInput,
      dispatch: ReturnType<ClaudeAdapterShape["sendTurn"]>,
    ): ReturnType<ClaudeAdapterShape["sendTurn"]> =>
      Effect.gen(function* () {
        const context = yield* requireSession(input.threadId);
        const selection = input.modelSelection;
        if (
          selection?.provider === "claudeAgent" &&
          resolveSelectedClaudeAutoCompactWindow(
            selection.model,
            normalizeClaudeModelOptions(selection.model, selection.options)?.autoCompactWindow,
          ) !== context.currentAutoCompactWindow
        ) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "session/reconfigure",
            issue:
              "Claude's auto-compact setting requires an idle session restart with resume before sending.",
          });
        }
        context.pendingDispatches = (context.pendingDispatches ?? 0) + 1;
        return yield* dispatch.pipe(
          Effect.ensuring(
            Effect.sync(() => {
              context.pendingDispatches = (context.pendingDispatches ?? 1) - 1;
            }),
          ),
        );
      });

    const sendTurn: ClaudeAdapterShape["sendTurn"] = (input) =>
      withPendingDispatch(input, sendTurnCore(input));

    const startClaudeCompaction: NonNullable<ClaudeAdapterShape["startClaudeCompaction"]> = (
      input,
    ) =>
      withPendingDispatch(
        { threadId: input.threadId, input: "/compact", attachments: [] },
        sendTurnCore(
          { threadId: input.threadId, input: "/compact", attachments: [] },
          input.turnId,
        ),
      );

    // a steer rides the live agent loop: pushed into the streaming prompt input, delivered at the next API request — parked steers behind long tools are read when they return; only a real user turn can be steered
    const steerTurn: ClaudeAdapterShape["steerTurn"] = (input) =>
      withPendingDispatch(
        input,
        Effect.gen(function* () {
          if (isClaudeCompactionCommand(input.input)) return yield* sendTurn(input);
          const context = yield* requireSession(input.threadId);
          const liveTurnState = context.turnState;
          if (liveTurnState === undefined || liveTurnState.synthetic === true) {
            return yield* sendTurn(input);
          }

          // steering across an interaction-mode change must still flip the CLI's permission mode even though no new turn starts
          const effectiveInteractionMode = yield* applyInteractionModePermission(
            context,
            input.threadId,
            input.interactionMode,
          );
          if (effectiveInteractionMode !== liveTurnState.interactionMode) {
            context.turnState = {
              ...liveTurnState,
              interactionMode: effectiveInteractionMode,
            };
          }

          const message = yield* buildUserMessageEffect(input, {
            fileSystem,
            attachmentsDir: serverConfig.attachmentsDir,
            nativeCommandNames: yield* resolveNativeCommandNames(context, input.input),
          });
          yield* Queue.offer(context.promptQueue, {
            type: "message",
            message,
          }).pipe(Effect.mapError((cause) => toRequestError(input.threadId, "turn/steer", cause)));

          const steerText = input.input?.trim();
          if (steerText) {
            const stamp = yield* makeEventStamp();
            yield* offerRuntimeEvent(context, {
              type: "turn.steered",
              eventId: stamp.eventId,
              provider: PROVIDER,
              createdAt: stamp.createdAt,
              threadId: context.session.threadId,
              turnId: liveTurnState.turnId,
              payload: { message: steerText, target: "turn" },
              providerRefs: nativeProviderRefs(context),
            });
          }

          return {
            threadId: context.session.threadId,
            turnId: liveTurnState.turnId,
            ...(context.session.resumeCursor !== undefined
              ? { resumeCursor: context.session.resumeCursor }
              : {}),
          };
        }),
      );

    const interruptTurn: ClaudeAdapterShape["interruptTurn"] = (
      threadId,
      turnId,
      providerThreadId,
    ) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);

        // a subagent thread id targets one Task spawn — stop that task, not the turn; before task_started maps it, queue the stop and fire when the mapping lands
        if (providerThreadId !== undefined) {
          // already settled: queueing would leak a stop that could fire on an unrelated future task
          if (context.settledSubagentToolUseIds.has(providerThreadId)) {
            return;
          }
          const taskId = context.subagentRuns.get(providerThreadId)?.taskId;
          const stopChild =
            taskId === undefined
              ? Effect.sync(() => {
                  context.pendingSubagentStops.add(providerThreadId);
                })
              : Effect.tryPromise({
                  try: () => context.query.stopTask(taskId),
                  catch: (cause) => toRequestError(threadId, "turn/interrupt", cause),
                });
          // subagents share the parent's MCP transport — their browser calls register under the parent's turn, so tombstone that gateway turn while stopping only the child task; revoke the shared bearer before either async stop can yield
          yield* withAgentGatewayTurnCancellation(
            context.gatewaySessionLease,
            context.turnState?.turnId,
            stopChild,
          );
          return;
        }

        if (turnId !== undefined && turnId !== context.turnState?.turnId) {
          yield* Effect.logWarning("claude.stale_interrupt_ignored", {
            threadId,
            requestedTurnId: turnId,
            activeTurnId: context.turnState?.turnId,
          });
          return;
        }
        const activeTurnId = turnId ?? context.turnState?.turnId;
        if (activeTurnId) {
          context.interruptRequestedTurnId = activeTurnId;
        }
        const acknowledged = yield* withAgentGatewayTurnCancellation(
          context.gatewaySessionLease,
          activeTurnId,
          Effect.tryPromise({
            try: () => context.query.interrupt(),
            catch: (cause) => toRequestError(threadId, "turn/interrupt", cause),
          }).pipe(Effect.timeoutOption(CLAUDE_INTERRUPT_TIMEOUT)),
        );
        if (Option.isNone(acknowledged)) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "turn/interrupt",
            detail: `The Claude CLI did not acknowledge the interrupt within ${Duration.toMillis(
              CLAUDE_INTERRUPT_TIMEOUT,
            )}ms.`,
          });
        }
      });

    // stop one background task by SDK task id; answered with a task_notification "stopped"
    const stopTask: ClaudeAdapterShape["stopTask"] = (threadId, taskId) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        yield* Effect.tryPromise({
          try: () => context.query.stopTask(taskId),
          catch: (cause) => toRequestError(threadId, "task/stop", cause),
        });
      });

    // CLI's Ctrl+B: the blocking Task tool_result returns immediately and the task settles later via task_notification
    const backgroundTask: ClaudeAdapterShape["backgroundTask"] = (threadId, toolUseId) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        yield* Effect.tryPromise({
          try: () => context.query.backgroundTasks(toolUseId).then(() => undefined),
          catch: (cause) => toRequestError(threadId, "task/background", cause),
        });
      });

    // queue a mid-task message; the PreToolUse hook injects it as additionalContext on the subagent's next tool call
    const steerSubagent: ClaudeAdapterShape["steerSubagent"] = (
      threadId,
      providerThreadId,
      input,
    ) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        if (!context.subagentRuns.has(providerThreadId)) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "turn/steerSubagent",
            detail: `Subagent '${providerThreadId}' already finished; the message was not delivered.`,
          });
        }
        // the PreToolUse hook is text-only — every attachment projects as a disk-path reference the subagent reads with its own tools
        const attachmentsBlock = buildFileAttachmentsPromptBlock({
          attachments: input.attachments,
          attachmentsDir: serverConfig.attachmentsDir,
          include: "all-files",
          includeImage: () => true,
        });
        const message = [input.input, attachmentsBlock]
          .filter((part): part is string => typeof part === "string" && part.length > 0)
          .join("\n\n");
        const pending = context.pendingSubagentSteers.get(providerThreadId) ?? [];
        pending.push(message);
        context.pendingSubagentSteers.set(providerThreadId, pending);
      });

    const readThread: ClaudeAdapterShape["readThread"] = (threadId) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        return yield* snapshotThread(context);
      });

    const rollbackThread: ClaudeAdapterShape["rollbackThread"] = (threadId, _numTurns) =>
      Effect.fail(
        new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "rollbackThread",
          issue:
            `Claude rollback requires a session restart for thread '${threadId}'. ` +
            "ProviderService owns that restart and retained-transcript bootstrap.",
        }),
      );

    const forkThread: NonNullable<ClaudeAdapterShape["forkThread"]> = (input) =>
      Effect.gen(function* () {
        // prefer the live session's cursor — the persisted binding may lag a turn
        const liveSource = sessions.get(input.sourceThreadId);
        // mid-turn lastAssistantUuid can point at a tool_use without its result — a fork would cut an incomplete transcript, so busy sources use the retained-transcript fallback
        if (liveSource?.turnState !== undefined) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "forkThread",
            issue:
              "The source Claude session has a turn in flight; Synara will rebuild the fork from its retained transcript.",
          });
        }
        const sourceState = readClaudeResumeState(input.sourceResumeCursor);
        const sourceSessionId = liveSource?.resumeSessionId ?? sourceState?.resume;
        if (!sourceSessionId) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "forkThread",
            issue: "The source Claude session has no resumable native cursor.",
          });
        }
        let upToMessageId = liveSource?.lastAssistantUuid ?? sourceState?.resumeSessionAt;
        const sourceCwd = liveSource?.session.cwd ?? input.sourceCwd;
        let importedSourceMessages: ReadonlyArray<SessionMessage> | undefined;
        if (input.requireCompletedSource) {
          const messages = yield* Effect.tryPromise({
            try: async () => {
              const readMessages =
                options?.readNativeSessionMessages ??
                (await loadClaudeAgentSdk()).getSessionMessages;
              return readMessages(sourceSessionId, sourceCwd ? { dir: sourceCwd } : {});
            },
            catch: (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "session/read",
                detail: toMessage(cause, "Failed to read the source Claude transcript."),
                cause,
              }),
          });
          const lastMessage = messages.at(-1);
          const message = lastMessage?.message;
          const stopReason =
            message && typeof message === "object" && "stop_reason" in message
              ? message.stop_reason
              : undefined;
          const content =
            message && typeof message === "object" && "content" in message
              ? message.content
              : undefined;
          const legacyTextOnly =
            stopReason === undefined &&
            ((typeof content === "string" && content.trim().length > 0) ||
              (Array.isArray(content) &&
                content.length > 0 &&
                content.every((block) => block?.type === "text")));
          const hasPendingToolUse =
            Array.isArray(content) && content.some((block) => block?.type === "tool_use");
          // missing legacy metadata ≠ explicit unfinished stream (null) or tool-use boundary; token exhaustion is terminal too
          if (
            lastMessage?.type !== "assistant" ||
            hasPendingToolUse ||
            (!legacyTextOnly &&
              stopReason !== "end_turn" &&
              stopReason !== "stop_sequence" &&
              stopReason !== "max_tokens")
          ) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "forkThread",
              issue:
                "Wait for the source Claude conversation to finish its turn before importing it.",
            });
          }
          // freeze the boundary before the SDK copies — concurrently appended messages must not enter the imported copy
          upToMessageId = lastMessage.uuid;
          importedSourceMessages = messages;
        }
        const forked = yield* Effect.tryPromise({
          try: () =>
            forkNativeSession(sourceSessionId, {
              ...(sourceCwd ? { dir: sourceCwd } : {}),
              ...(upToMessageId ? { upToMessageId } : {}),
            }),
          catch: (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "session/fork",
              detail: toMessage(cause, "Failed to fork the Claude session transcript."),
              cause,
            }),
        });
        if (importedSourceMessages !== undefined) {
          yield* Effect.tryPromise({
            try: () =>
              restoreClaudeImportedCopyDates({
                sourceSessionId,
                copiedSessionId: forked.sessionId,
                sourceMessages: importedSourceMessages!,
              }),
            catch: (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "session/fork",
                detail: toMessage(cause, "Failed to preserve the imported conversation dates."),
                cause,
              }),
          });
        }
        // the SDK fork remaps every uuid — the source's resume pin and tracked tasks must not carry into the fork
        // a live context restarts turns at [] on resume — keep the larger of live count vs persisted total
        const resumeCursor = {
          threadId: input.threadId,
          resume: forked.sessionId,
          turnCount: Math.max(liveSource?.turns.length ?? 0, sourceState?.turnCount ?? 0),
          processedTokenTotal: 0,
          tokenAccountingVersion: 1,
        };
        return { threadId: input.threadId, resumeCursor };
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

        const settledDecision = yield* settlePendingApproval(context, requestId, pending, decision);
        if (settledDecision !== decision) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "item/requestApproval/decision",
            detail: `Approval request ${requestId} was already resolved as ${settledDecision}.`,
          });
        }
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

        const submittedResult: PendingUserInputResult = {
          answers,
          cancelled: false,
        };
        const settledResult = yield* settlePendingUserInput(
          context,
          requestId,
          pending,
          submittedResult,
        );
        if (settledResult !== submittedResult) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "item/tool/respondToUserInput",
            detail: `User-input request ${requestId} was already resolved.`,
          });
        }
      });

    const stopSession: ClaudeAdapterShape["stopSession"] = (threadId) =>
      withSessionLifecycleLock(
        threadId,
        Effect.gen(function* () {
          const failedOwner = failedStartupProcessOwners.get(threadId);
          if (failedOwner) yield* teardownFailedStartupProcess(threadId, failedOwner);
          const context = sessions.get(threadId);
          if (!context) {
            return;
          }
          yield* stopSessionInternal(context, {
            emitExitEvent: true,
          });
        }),
      );

    const listSessions: ClaudeAdapterShape["listSessions"] = () =>
      Effect.sync(() => Array.from(sessions.values(), ({ session }) => ({ ...session })));

    const hasSession: ClaudeAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => {
        const context = sessions.get(threadId);
        return context !== undefined && !context.stopped;
      });

    // Native discovery caches — avoid spawning a process per query.
    let commandsCache: {
      result: ProviderListCommandsResult;
      cwd: string;
      enableArtifacts: boolean;
    } | null = null;
    // keyed by everything the spawned process depends on so a lookup never joins (then caches) a discovery for another workspace/Artifact opt-in
    const pendingCommandDiscoveries = new Map<string, Promise<ProviderListCommandsResult>>();
    let commandDiscoveryTail: Promise<unknown> = Promise.resolve();
    let pendingModelDiscovery: Promise<ProviderListModelsResult> | null = null;

    async function discoverViaTemporaryProcess<T>(
      cwd: string,
      env: NodeJS.ProcessEnv,
      binaryPath: string,
      discover: (queryRuntime: ClaudeQueryRuntime) => Promise<T>,
    ): Promise<T> {
      // never spawn another discovery process until every previously unproven process tree is reaped
      await Effect.runPromise(teardownFailedDiscoveryProcesses());

      // SDK capability methods await an init promise that resolves only when the async generator is iterated — drive it to run the handshake
      const processOwner: ClaudeProcessOwner = {};
      let tempQuery: ClaudeQueryRuntime | undefined;

      try {
        // query construction may invoke the spawn callback before throwing — it belongs inside the same ownership boundary
        tempQuery = await createQuery({
          prompt: neverResolvingUserMessageStream(),
          options: {
            cwd,
            pathToClaudeCodeExecutable: binaryPath,
            settingSources: [...CLAUDE_SETTING_SOURCES],
            permissionMode: "plan" as PermissionMode,
            persistSession: false,
            env,
            spawnClaudeCodeProcess: bindClaudeProcessOwner(processOwner),
          },
        });
        const queryRuntime = tempQuery;

        void (async () => {
          for await (const message of queryRuntime) {
            void message;
          }
        })().catch(() => undefined);

        return await discover(queryRuntime);
      } finally {
        try {
          tempQuery?.close();
        } finally {
          await Effect.runPromise(teardownDiscoveryProcess(processOwner));
        }
      }
    }

    const discoverCommandsViaTemporaryProcess = (
      cwd: string,
      env: NodeJS.ProcessEnv,
      binaryPath: string,
      artifactsEnabled: boolean,
    ): Promise<ProviderListCommandsResult> =>
      discoverViaTemporaryProcess(cwd, env, binaryPath, (queryRuntime) =>
        queryRuntime
          .supportedCommands()
          .then((commands) =>
            mapSupportedCommands(
              commands,
              resolveClaudeArtifactsState({ artifactsEnabled, commands }),
            ),
          ),
      );

    const discoverModelsViaTemporaryProcess = (
      cwd: string,
      env: NodeJS.ProcessEnv,
      binaryPath: string,
    ): Promise<ProviderListModelsResult> =>
      discoverViaTemporaryProcess(cwd, env, binaryPath, async (queryRuntime) => ({
        models: (await queryRuntime.supportedModels()).map(mapClaudeModelInfo),
        source: "sdk",
        cached: false,
      }));

    const listCommands: NonNullable<ClaudeAdapterShape["listCommands"]> = (
      input: ProviderListCommandsInput,
    ) =>
      Effect.gen(function* () {
        const enableArtifacts = input.enableArtifacts === true;
        // a thread's own session is truth; only borrow a session spawned with the same Artifact opt-in or its command list misreports /design and /slides
        const ownContext = input.threadId
          ? sessions.get(ThreadId.makeUnsafe(input.threadId))
          : undefined;
        const context =
          ownContext && !ownContext.stopped
            ? ownContext
            : input.threadId
              ? undefined
              : [...sessions.values()].find(
                  (s) => !s.stopped && s.artifactsEnabled === enableArtifacts,
                );

        if (context && !context.stopped) {
          const commands = yield* Effect.tryPromise({
            try: () => context.query.supportedCommands(),
            catch: (cause) => toRequestError(context.session.threadId, "listCommands", cause),
          });
          const result = mapSupportedCommands(
            commands,
            resolveClaudeArtifactsState({
              artifactsEnabled: context.artifactsEnabled,
              commands,
              initToolNames: context.initToolNames,
            }),
          );
          // cache under the flag this process was spawned with, not the current setting — a pre-toggle session can't poison fresh discovery
          commandsCache = { result, cwd: input.cwd, enableArtifacts: context.artifactsEnabled };
          return result;
        }

        if (
          commandsCache &&
          commandsCache.cwd === input.cwd &&
          commandsCache.enableArtifacts === enableArtifacts &&
          !input.forceReload
        ) {
          return { ...commandsCache.result, cached: true } satisfies ProviderListCommandsResult;
        }

        const claudeSdkEnv = yield* resolveClaudeSdkEnv;
        const binaryPath = input.binaryPath ?? "claude";
        const discoveryKey = JSON.stringify([input.cwd, binaryPath, enableArtifacts]);
        let discoveryPromise = pendingCommandDiscoveries.get(discoveryKey);
        if (!discoveryPromise) {
          // distinct lookups queue behind each other: still one temporary Claude process at a time
          const previous = commandDiscoveryTail;
          const started = previous
            .catch(() => undefined)
            .then(() =>
              discoverCommandsViaTemporaryProcess(
                input.cwd,
                withClaudeArtifactOptIn(claudeSdkEnv, enableArtifacts),
                binaryPath,
                enableArtifacts,
              ),
            );
          discoveryPromise = started;
          commandDiscoveryTail = started;
          pendingCommandDiscoveries.set(discoveryKey, started);
          const forget = () => {
            if (pendingCommandDiscoveries.get(discoveryKey) === started) {
              pendingCommandDiscoveries.delete(discoveryKey);
            }
          };
          void started.then(forget, forget);
        }
        const pendingDiscovery = discoveryPromise;

        const result = yield* Effect.tryPromise({
          try: () => pendingDiscovery,
          catch: (cause) =>
            new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId: ThreadId.makeUnsafe("discovery"),
              detail: toMessage(cause, "Failed to discover Claude commands."),
              cause,
            }),
        });

        commandsCache = { result, cwd: input.cwd, enableArtifacts };
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
      settleConcurrentTeardowns(
        [
          settleConcurrentTeardowns([...sessions.values()], (context) =>
            stopSessionInternal(context, { emitExitEvent: true }),
          ),
          settleConcurrentTeardowns([...failedStartupProcessOwners], ([threadId, owner]) =>
            teardownFailedStartupProcess(threadId, owner),
          ),
          teardownFailedDiscoveryProcesses(),
        ],
        (teardown) => teardown,
      );

    yield* Effect.addFinalizer(() =>
      settleConcurrentTeardowns(
        [
          settleConcurrentTeardowns([...sessions.values()], (context) =>
            stopSessionInternal(context, { emitExitEvent: false }),
          ),
          settleConcurrentTeardowns([...failedStartupProcessOwners], ([threadId, owner]) =>
            teardownFailedStartupProcess(threadId, owner),
          ),
          teardownFailedDiscoveryProcesses(),
        ],
        (teardown) => teardown,
      ).pipe(Effect.ignore, Effect.andThen(Queue.shutdown(runtimeEventQueue))),
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

    const listModels: NonNullable<ClaudeAdapterShape["listModels"]> = (input) =>
      Effect.gen(function* () {
        if (cachedModels) {
          return { ...cachedModels, cached: true };
        }

        for (const [, context] of sessions) {
          if (!context.stopped && context.query) {
            const result = yield* Effect.tryPromise({
              try: async () => ({
                models: (await context.query.supportedModels()).map(mapClaudeModelInfo),
                source: "sdk",
                cached: false,
              }),
              catch: (cause) => toRequestError(context.session.threadId, "listModels", cause),
            });
            cachedModels = result;
            return result;
          }
        }

        // cold starts have no active session — use one short-lived SDK process so the first model request gets real capability flags instead of a cached empty catalog
        const claudeSdkEnv = yield* resolveClaudeSdkEnv;
        const discoveryPromise =
          pendingModelDiscovery ??
          discoverModelsViaTemporaryProcess(
            input.cwd ?? serverConfig.cwd,
            claudeSdkEnv,
            input.binaryPath ?? "claude",
          );
        pendingModelDiscovery = discoveryPromise;

        const result = yield* Effect.tryPromise({
          try: () => discoveryPromise,
          catch: (cause) =>
            new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId: CLAUDE_DISCOVERY_THREAD_ID,
              detail: toMessage(cause, "Failed to discover Claude models."),
              cause,
            }),
        }).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              pendingModelDiscovery = null;
            }),
          ),
          Effect.tapError(() =>
            Effect.sync(() => {
              pendingModelDiscovery = null;
            }),
          ),
        );

        cachedModels = result;
        return result;
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
        conversationRollback: "restart-session",
        supportsSkillMentions: false,
        supportsSkillDiscovery: false,
        supportsNativeSlashCommandDiscovery: true,
        supportsPluginMentions: false,
        supportsPluginDiscovery: false,
        supportsRuntimeModelList: true,
        supportsTurnSteering: true,
        supportsLiveTurnDiffPatch: false,
      },
      startSession,
      prepareSessionReplacement,
      getClaudeCacheObservation,
      startClaudeCompaction,
      sendTurn,
      steerTurn,
      interruptTurn,
      stopTask,
      backgroundTask,
      steerSubagent,
      readThread,
      rollbackThread,
      forkThread,
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
