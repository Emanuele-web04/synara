import { Option, Schema, SchemaIssue, Struct } from "effect";
import {
  ClaudeModelOptions,
  CodexModelOptions,
  CursorModelOptions,
  GeminiModelOptions,
  GrokModelOptions,
  OpenCodeModelOptions,
  PiModelOptions,
} from "./model";
import { ProviderMentionReference, ProviderSkillReference } from "./providerDiscovery";
import { ProjectKind } from "./project";
import {
  ExecutionTargetKind,
  ExecutionRuntimeProvider,
  OrchestrationThreadRuntime,
  RuntimeInstanceStatus,
  RuntimePlan,
  RuntimeRole,
} from "./executionRuntime";
import {
  ApprovalRequestId,
  CheckpointRef,
  CommandId,
  EventId,
  ExecutionInstanceId,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ProviderItemId,
  RuntimeActivityLeaseId,
  RuntimeProcessId,
  RuntimeRouteId,
  RuntimeSnapshotId,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
} from "./baseSchemas";

export const ORCHESTRATION_WS_METHODS = {
  getSnapshot: "orchestration.getSnapshot",
  getShellSnapshot: "orchestration.getShellSnapshot",
  dispatchCommand: "orchestration.dispatchCommand",
  importThread: "orchestration.importThread",
  repairState: "orchestration.repairState",
  getTurnDiff: "orchestration.getTurnDiff",
  getFullThreadDiff: "orchestration.getFullThreadDiff",
  replayEvents: "orchestration.replayEvents",
  subscribeShell: "orchestration.subscribeShell",
  unsubscribeShell: "orchestration.unsubscribeShell",
  subscribeThread: "orchestration.subscribeThread",
  unsubscribeThread: "orchestration.unsubscribeThread",
} as const;

export const ORCHESTRATION_WS_CHANNELS = {
  domainEvent: "orchestration.domainEvent",
  shellEvent: "orchestration.shellEvent",
  threadEvent: "orchestration.threadEvent",
} as const;

export {
  ProviderKind,
  ProviderApprovalPolicy,
  ProviderSandboxMode,
  DEFAULT_PROVIDER_KIND,
} from "./providerKind";
import { ProviderKind } from "./providerKind";

export const CodexModelSelection = Schema.Struct({
  provider: Schema.Literal("codex"),
  model: TrimmedNonEmptyString,
  options: Schema.optional(CodexModelOptions),
});
export type CodexModelSelection = typeof CodexModelSelection.Type;

export const ClaudeModelSelection = Schema.Struct({
  provider: Schema.Literal("claudeAgent"),
  model: TrimmedNonEmptyString,
  options: Schema.optional(ClaudeModelOptions),
});
export type ClaudeModelSelection = typeof ClaudeModelSelection.Type;

export const CursorModelSelection = Schema.Struct({
  provider: Schema.Literal("cursor"),
  model: TrimmedNonEmptyString,
  options: Schema.optional(CursorModelOptions),
});
export type CursorModelSelection = typeof CursorModelSelection.Type;

export const GeminiModelSelection = Schema.Struct({
  provider: Schema.Literal("gemini"),
  model: TrimmedNonEmptyString,
  options: Schema.optional(GeminiModelOptions),
});
export type GeminiModelSelection = typeof GeminiModelSelection.Type;

export const GrokModelSelection = Schema.Struct({
  provider: Schema.Literal("grok"),
  model: TrimmedNonEmptyString,
  options: Schema.optional(GrokModelOptions),
});
export type GrokModelSelection = typeof GrokModelSelection.Type;

export const OpenCodeModelSelection = Schema.Struct({
  provider: Schema.Literal("opencode"),
  model: TrimmedNonEmptyString,
  options: Schema.optional(OpenCodeModelOptions),
});
export type OpenCodeModelSelection = typeof OpenCodeModelSelection.Type;

export const KiloModelSelection = Schema.Struct({
  provider: Schema.Literal("kilo"),
  model: TrimmedNonEmptyString,
  options: Schema.optional(OpenCodeModelOptions),
});
export type KiloModelSelection = typeof KiloModelSelection.Type;

export const PiModelSelection = Schema.Struct({
  provider: Schema.Literal("pi"),
  model: TrimmedNonEmptyString,
  options: Schema.optional(PiModelOptions),
});
export type PiModelSelection = typeof PiModelSelection.Type;

export const ModelSelection = Schema.Union([
  CodexModelSelection,
  ClaudeModelSelection,
  CursorModelSelection,
  GeminiModelSelection,
  GrokModelSelection,
  KiloModelSelection,
  OpenCodeModelSelection,
  PiModelSelection,
]);
export type ModelSelection = typeof ModelSelection.Type;

export const CodexProviderStartOptions = Schema.Struct({
  binaryPath: Schema.optional(TrimmedNonEmptyString),
  homePath: Schema.optional(TrimmedNonEmptyString),
});

export const ClaudeProviderStartOptions = Schema.Struct({
  binaryPath: Schema.optional(TrimmedNonEmptyString),
  permissionMode: Schema.optional(TrimmedNonEmptyString),
  maxThinkingTokens: Schema.optional(NonNegativeInt),
});

export const GeminiProviderStartOptions = Schema.Struct({
  binaryPath: Schema.optional(TrimmedNonEmptyString),
});

export const CursorProviderStartOptions = Schema.Struct({
  binaryPath: Schema.optional(TrimmedNonEmptyString),
  apiEndpoint: Schema.optional(TrimmedNonEmptyString),
});

export const GrokProviderStartOptions = Schema.Struct({
  binaryPath: Schema.optional(TrimmedNonEmptyString),
});

export const OpenCodeProviderStartOptions = Schema.Struct({
  binaryPath: Schema.optional(TrimmedNonEmptyString),
  serverUrl: Schema.optional(TrimmedNonEmptyString),
  serverPassword: Schema.optional(TrimmedNonEmptyString),
});

export const KiloProviderStartOptions = Schema.Struct({
  binaryPath: Schema.optional(TrimmedNonEmptyString),
  serverUrl: Schema.optional(TrimmedNonEmptyString),
  serverPassword: Schema.optional(TrimmedNonEmptyString),
});

export const PiProviderStartOptions = Schema.Struct({
  binaryPath: Schema.optional(TrimmedNonEmptyString),
  agentDir: Schema.optional(TrimmedNonEmptyString),
});

export const ProviderStartOptions = Schema.Struct({
  codex: Schema.optional(CodexProviderStartOptions),
  claudeAgent: Schema.optional(ClaudeProviderStartOptions),
  cursor: Schema.optional(CursorProviderStartOptions),
  gemini: Schema.optional(GeminiProviderStartOptions),
  grok: Schema.optional(GrokProviderStartOptions),
  kilo: Schema.optional(KiloProviderStartOptions),
  opencode: Schema.optional(OpenCodeProviderStartOptions),
  pi: Schema.optional(PiProviderStartOptions),
});
export type ProviderStartOptions = typeof ProviderStartOptions.Type;

export const RuntimeMode = Schema.Literals(["approval-required", "full-access"]);
export type RuntimeMode = typeof RuntimeMode.Type;
export const DEFAULT_RUNTIME_MODE: RuntimeMode = "full-access";
export const ProviderInteractionMode = Schema.Literals(["default", "plan"]);
export type ProviderInteractionMode = typeof ProviderInteractionMode.Type;
export const DEFAULT_PROVIDER_INTERACTION_MODE: ProviderInteractionMode = "default";
const SidechatSourceThreadId = Schema.optional(Schema.NullOr(ThreadId)).pipe(
  Schema.withDecodingDefault(() => null),
);
export const ProviderRequestKind = Schema.Literals(["command", "file-read", "file-change"]);
export type ProviderRequestKind = typeof ProviderRequestKind.Type;
export const AssistantDeliveryMode = Schema.Literals(["buffered", "streaming"]);
export type AssistantDeliveryMode = typeof AssistantDeliveryMode.Type;
// Queue is the default "send message" behavior; steer is an urgent redirect.
export const TurnDispatchMode = Schema.Literals(["queue", "steer"]);
export type TurnDispatchMode = typeof TurnDispatchMode.Type;
export const DEFAULT_TURN_DISPATCH_MODE: TurnDispatchMode = "queue";
export const ProviderReviewTarget = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("uncommittedChanges"),
  }),
  Schema.Struct({
    type: Schema.Literal("baseBranch"),
    branch: TrimmedNonEmptyString,
  }),
]);
export type ProviderReviewTarget = typeof ProviderReviewTarget.Type;
export const ProviderApprovalDecision = Schema.Literals([
  "accept",
  "acceptForSession",
  "decline",
  "cancel",
]);
export type ProviderApprovalDecision = typeof ProviderApprovalDecision.Type;
export const ProviderUserInputAnswer = Schema.NullOr(
  Schema.Union([Schema.String, Schema.Array(Schema.String)]),
);
export type ProviderUserInputAnswer = typeof ProviderUserInputAnswer.Type;
export const ProviderUserInputAnswers = Schema.Record(Schema.String, ProviderUserInputAnswer);
export type ProviderUserInputAnswers = typeof ProviderUserInputAnswers.Type;
export const ThreadHandoffBootstrapStatus = Schema.Literals(["pending", "completed"]);
export type ThreadHandoffBootstrapStatus = typeof ThreadHandoffBootstrapStatus.Type;
export const ThreadEnvironmentMode = Schema.Literals(["local", "worktree"]);
export type ThreadEnvironmentMode = typeof ThreadEnvironmentMode.Type;

export const OrchestrationMessageSource = Schema.Literals([
  "native",
  "handoff-import",
  "fork-import",
  "review-context-bootstrap",
]);
export type OrchestrationMessageSource = typeof OrchestrationMessageSource.Type;

export const PROVIDER_SEND_TURN_MAX_INPUT_CHARS = 120_000;
export const PROVIDER_SEND_TURN_MAX_ATTACHMENTS = 8;
export const PROVIDER_SEND_TURN_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const PROVIDER_SEND_TURN_MAX_IMAGE_DATA_URL_CHARS = 14_000_000;
const CHAT_ATTACHMENT_ID_MAX_CHARS = 128;
export const CHAT_ASSISTANT_SELECTION_TEXT_MAX_CHARS = 4_000;
// Correlation id is command id by design in this model.
export const CorrelationId = CommandId;
export type CorrelationId = typeof CorrelationId.Type;

const ChatAttachmentId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(CHAT_ATTACHMENT_ID_MAX_CHARS),
  Schema.isPattern(/^[a-z0-9_-]+$/i),
);
export type ChatAttachmentId = typeof ChatAttachmentId.Type;

export const ChatImageAttachment = Schema.Struct({
  type: Schema.Literal("image"),
  id: ChatAttachmentId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  mimeType: TrimmedNonEmptyString.check(Schema.isMaxLength(100), Schema.isPattern(/^image\//i)),
  sizeBytes: NonNegativeInt.check(Schema.isLessThanOrEqualTo(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES)),
});
export type ChatImageAttachment = typeof ChatImageAttachment.Type;

export const ChatAssistantSelectionAttachment = Schema.Struct({
  type: Schema.Literal("assistant-selection"),
  id: ChatAttachmentId,
  assistantMessageId: MessageId,
  text: TrimmedNonEmptyString.check(Schema.isMaxLength(CHAT_ASSISTANT_SELECTION_TEXT_MAX_CHARS)),
});
export type ChatAssistantSelectionAttachment = typeof ChatAssistantSelectionAttachment.Type;

const UploadChatImageAttachment = Schema.Struct({
  type: Schema.Literal("image"),
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  mimeType: TrimmedNonEmptyString.check(Schema.isMaxLength(100), Schema.isPattern(/^image\//i)),
  sizeBytes: NonNegativeInt.check(Schema.isLessThanOrEqualTo(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES)),
  dataUrl: TrimmedNonEmptyString.check(
    Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_IMAGE_DATA_URL_CHARS),
  ),
});
export type UploadChatImageAttachment = typeof UploadChatImageAttachment.Type;

export const UploadChatAssistantSelectionAttachment = Schema.Struct({
  type: Schema.Literal("assistant-selection"),
  assistantMessageId: MessageId,
  text: TrimmedNonEmptyString.check(Schema.isMaxLength(CHAT_ASSISTANT_SELECTION_TEXT_MAX_CHARS)),
});
export type UploadChatAssistantSelectionAttachment =
  typeof UploadChatAssistantSelectionAttachment.Type;

export const ChatAttachment = Schema.Union([ChatImageAttachment, ChatAssistantSelectionAttachment]);
export type ChatAttachment = typeof ChatAttachment.Type;
const UploadChatAttachment = Schema.Union([
  UploadChatImageAttachment,
  UploadChatAssistantSelectionAttachment,
]);
export type UploadChatAttachment = typeof UploadChatAttachment.Type;

export const ProjectScriptIcon = Schema.Literals([
  "play",
  "test",
  "lint",
  "configure",
  "build",
  "debug",
]);
export type ProjectScriptIcon = typeof ProjectScriptIcon.Type;

export const ProjectScript = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  command: TrimmedNonEmptyString,
  icon: ProjectScriptIcon,
  runOnWorktreeCreate: Schema.Boolean,
});
export type ProjectScript = typeof ProjectScript.Type;

export const OrchestrationProject = Schema.Struct({
  id: ProjectId,
  kind: Schema.optional(ProjectKind).pipe(Schema.withDecodingDefault(() => "project")),
  title: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  defaultModelSelection: Schema.NullOr(ModelSelection),
  scripts: Schema.Array(ProjectScript),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  deletedAt: Schema.NullOr(IsoDateTime),
});
export type OrchestrationProject = typeof OrchestrationProject.Type;

export const OrchestrationProjectShell = Schema.Struct({
  id: ProjectId,
  kind: Schema.optional(ProjectKind).pipe(Schema.withDecodingDefault(() => "project")),
  title: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  defaultModelSelection: Schema.NullOr(ModelSelection),
  scripts: Schema.Array(ProjectScript),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type OrchestrationProjectShell = typeof OrchestrationProjectShell.Type;

export const OrchestrationMessageRole = Schema.Literals(["user", "assistant", "system"]);
export type OrchestrationMessageRole = typeof OrchestrationMessageRole.Type;

export const OrchestrationMessage = Schema.Struct({
  id: MessageId,
  role: OrchestrationMessageRole,
  text: Schema.String,
  attachments: Schema.optional(Schema.Array(ChatAttachment)),
  skills: Schema.optional(Schema.Array(ProviderSkillReference)),
  mentions: Schema.optional(Schema.Array(ProviderMentionReference)),
  dispatchMode: Schema.optional(TurnDispatchMode),
  turnId: Schema.NullOr(TurnId),
  streaming: Schema.Boolean,
  source: OrchestrationMessageSource.pipe(Schema.withDecodingDefault(() => "native")),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type OrchestrationMessage = typeof OrchestrationMessage.Type;

export const ThreadHandoff = Schema.Struct({
  sourceThreadId: ThreadId,
  sourceProvider: ProviderKind,
  importedAt: IsoDateTime,
  bootstrapStatus: ThreadHandoffBootstrapStatus,
});
export type ThreadHandoff = typeof ThreadHandoff.Type;

export const OrchestrationProposedPlanId = TrimmedNonEmptyString;
export type OrchestrationProposedPlanId = typeof OrchestrationProposedPlanId.Type;

export const OrchestrationProposedPlan = Schema.Struct({
  id: OrchestrationProposedPlanId,
  turnId: Schema.NullOr(TurnId),
  planMarkdown: TrimmedNonEmptyString,
  implementedAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(() => null)),
  implementationThreadId: Schema.NullOr(ThreadId).pipe(Schema.withDecodingDefault(() => null)),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type OrchestrationProposedPlan = typeof OrchestrationProposedPlan.Type;

const SourceProposedPlanReference = Schema.Struct({
  threadId: ThreadId,
  planId: OrchestrationProposedPlanId,
});

export const OrchestrationSessionStatus = Schema.Literals([
  "idle",
  "starting",
  "running",
  "ready",
  "interrupted",
  "stopped",
  "error",
]);
export type OrchestrationSessionStatus = typeof OrchestrationSessionStatus.Type;

export const OrchestrationSession = Schema.Struct({
  threadId: ThreadId,
  status: OrchestrationSessionStatus,
  providerName: Schema.NullOr(TrimmedNonEmptyString),
  runtimeMode: RuntimeMode.pipe(Schema.withDecodingDefault(() => DEFAULT_RUNTIME_MODE)),
  activeTurnId: Schema.NullOr(TurnId),
  lastError: Schema.NullOr(TrimmedNonEmptyString),
  updatedAt: IsoDateTime,
});
export type OrchestrationSession = typeof OrchestrationSession.Type;

export const OrchestrationCheckpointFile = Schema.Struct({
  path: TrimmedNonEmptyString,
  kind: TrimmedNonEmptyString,
  additions: NonNegativeInt,
  deletions: NonNegativeInt,
});
export type OrchestrationCheckpointFile = typeof OrchestrationCheckpointFile.Type;

export const OrchestrationCheckpointStatus = Schema.Literals(["ready", "missing", "error"]);
export type OrchestrationCheckpointStatus = typeof OrchestrationCheckpointStatus.Type;

export const OrchestrationCheckpointSummary = Schema.Struct({
  turnId: TurnId,
  checkpointTurnCount: NonNegativeInt,
  checkpointRef: CheckpointRef,
  status: OrchestrationCheckpointStatus,
  files: Schema.Array(OrchestrationCheckpointFile),
  assistantMessageId: Schema.NullOr(MessageId),
  completedAt: IsoDateTime,
});
export type OrchestrationCheckpointSummary = typeof OrchestrationCheckpointSummary.Type;

export const OrchestrationThreadActivityTone = Schema.Literals([
  "info",
  "tool",
  "approval",
  "error",
]);
export type OrchestrationThreadActivityTone = typeof OrchestrationThreadActivityTone.Type;

export const OrchestrationThreadActivity = Schema.Struct({
  id: EventId,
  tone: OrchestrationThreadActivityTone,
  kind: TrimmedNonEmptyString,
  summary: TrimmedNonEmptyString,
  payload: Schema.Json,
  turnId: Schema.NullOr(TurnId),
  sequence: Schema.optional(NonNegativeInt),
  createdAt: IsoDateTime,
});
export type OrchestrationThreadActivity = typeof OrchestrationThreadActivity.Type;

const OrchestrationLatestTurnState = Schema.Literals([
  "running",
  "interrupted",
  "completed",
  "error",
]);
export type OrchestrationLatestTurnState = typeof OrchestrationLatestTurnState.Type;

export const OrchestrationLatestTurn = Schema.Struct({
  turnId: TurnId,
  state: OrchestrationLatestTurnState,
  requestedAt: IsoDateTime,
  startedAt: Schema.NullOr(IsoDateTime),
  completedAt: Schema.NullOr(IsoDateTime),
  assistantMessageId: Schema.NullOr(MessageId),
  sourceProposedPlan: Schema.optional(SourceProposedPlanReference),
});
export type OrchestrationLatestTurn = typeof OrchestrationLatestTurn.Type;

export const OrchestrationThreadPullRequest = Schema.Struct({
  number: PositiveInt,
  title: TrimmedNonEmptyString,
  url: Schema.String,
  baseBranch: TrimmedNonEmptyString,
  headBranch: TrimmedNonEmptyString,
  state: Schema.Literals(["open", "closed", "merged"]),
});
export type OrchestrationThreadPullRequest = typeof OrchestrationThreadPullRequest.Type;

export const OrchestrationReviewChatTarget = Schema.Struct({
  projectId: ProjectId,
  cwd: TrimmedNonEmptyString,
  repositoryId: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  reference: TrimmedNonEmptyString,
  number: PositiveInt,
  url: Schema.optional(Schema.NullOr(Schema.String)).pipe(Schema.withDecodingDefault(() => null)),
});
export type OrchestrationReviewChatTarget = typeof OrchestrationReviewChatTarget.Type;

export const OrchestrationThread = Schema.Struct({
  id: ThreadId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(() => DEFAULT_PROVIDER_INTERACTION_MODE),
  ),
  envMode: Schema.optional(ThreadEnvironmentMode).pipe(Schema.withDecodingDefault(() => "local")),
  branch: Schema.NullOr(TrimmedNonEmptyString),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  associatedWorktreePath: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  associatedWorktreeBranch: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  associatedWorktreeRef: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  createBranchFlowCompleted: Schema.optional(Schema.Boolean).pipe(
    Schema.withDecodingDefault(() => false),
  ),
  isPinned: Schema.optional(Schema.Boolean).pipe(Schema.withDecodingDefault(() => false)),
  parentThreadId: Schema.optional(Schema.NullOr(ThreadId)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  subagentAgentId: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  subagentNickname: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  subagentRole: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  forkSourceThreadId: Schema.optional(Schema.NullOr(ThreadId)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  sidechatSourceThreadId: SidechatSourceThreadId,
  lastKnownPr: Schema.optional(Schema.NullOr(OrchestrationThreadPullRequest)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  reviewChatTarget: Schema.optional(Schema.NullOr(OrchestrationReviewChatTarget)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  runtime: Schema.optional(Schema.NullOr(OrchestrationThreadRuntime)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  latestTurn: Schema.NullOr(OrchestrationLatestTurn),
  latestUserMessageAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  hasPendingApprovals: Schema.optional(Schema.Boolean),
  hasPendingUserInput: Schema.optional(Schema.Boolean),
  hasActionableProposedPlan: Schema.optional(Schema.Boolean),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  archivedAt: Schema.optional(Schema.NullOr(IsoDateTime)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  deletedAt: Schema.NullOr(IsoDateTime),
  handoff: Schema.NullOr(ThreadHandoff).pipe(Schema.withDecodingDefault(() => null)),
  messages: Schema.Array(OrchestrationMessage),
  proposedPlans: Schema.Array(OrchestrationProposedPlan).pipe(Schema.withDecodingDefault(() => [])),
  activities: Schema.Array(OrchestrationThreadActivity),
  checkpoints: Schema.Array(OrchestrationCheckpointSummary),
  session: Schema.NullOr(OrchestrationSession),
});
export type OrchestrationThread = typeof OrchestrationThread.Type;

export const OrchestrationThreadShell = Schema.Struct({
  id: ThreadId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(() => DEFAULT_PROVIDER_INTERACTION_MODE),
  ),
  envMode: Schema.optional(ThreadEnvironmentMode).pipe(Schema.withDecodingDefault(() => "local")),
  branch: Schema.NullOr(TrimmedNonEmptyString),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  associatedWorktreePath: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  associatedWorktreeBranch: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  associatedWorktreeRef: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  createBranchFlowCompleted: Schema.optional(Schema.Boolean).pipe(
    Schema.withDecodingDefault(() => false),
  ),
  isPinned: Schema.optional(Schema.Boolean).pipe(Schema.withDecodingDefault(() => false)),
  parentThreadId: Schema.optional(Schema.NullOr(ThreadId)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  subagentAgentId: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  subagentNickname: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  subagentRole: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  forkSourceThreadId: Schema.optional(Schema.NullOr(ThreadId)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  sidechatSourceThreadId: SidechatSourceThreadId,
  lastKnownPr: Schema.optional(Schema.NullOr(OrchestrationThreadPullRequest)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  reviewChatTarget: Schema.optional(Schema.NullOr(OrchestrationReviewChatTarget)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  runtime: Schema.optional(Schema.NullOr(OrchestrationThreadRuntime)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  latestTurn: Schema.NullOr(OrchestrationLatestTurn),
  latestUserMessageAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  hasPendingApprovals: Schema.optional(Schema.Boolean),
  hasPendingUserInput: Schema.optional(Schema.Boolean),
  hasActionableProposedPlan: Schema.optional(Schema.Boolean),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  archivedAt: Schema.optional(Schema.NullOr(IsoDateTime)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  handoff: Schema.NullOr(ThreadHandoff).pipe(Schema.withDecodingDefault(() => null)),
  session: Schema.NullOr(OrchestrationSession),
});
export type OrchestrationThreadShell = typeof OrchestrationThreadShell.Type;

export const OrchestrationReadModel = Schema.Struct({
  snapshotSequence: NonNegativeInt,
  projects: Schema.Array(OrchestrationProject),
  threads: Schema.Array(OrchestrationThread),
  updatedAt: IsoDateTime,
});
export type OrchestrationReadModel = typeof OrchestrationReadModel.Type;

export const OrchestrationShellSnapshot = Schema.Struct({
  snapshotSequence: NonNegativeInt,
  projects: Schema.Array(OrchestrationProjectShell),
  threads: Schema.Array(OrchestrationThreadShell),
  updatedAt: IsoDateTime,
});
export type OrchestrationShellSnapshot = typeof OrchestrationShellSnapshot.Type;

export const OrchestrationShellStreamEvent = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("project-upserted"),
    sequence: NonNegativeInt,
    project: OrchestrationProjectShell,
  }),
  Schema.Struct({
    kind: Schema.Literal("project-removed"),
    sequence: NonNegativeInt,
    projectId: ProjectId,
  }),
  Schema.Struct({
    kind: Schema.Literal("thread-upserted"),
    sequence: NonNegativeInt,
    thread: OrchestrationThreadShell,
  }),
  Schema.Struct({
    kind: Schema.Literal("thread-removed"),
    sequence: NonNegativeInt,
    threadId: ThreadId,
  }),
]);
export type OrchestrationShellStreamEvent = typeof OrchestrationShellStreamEvent.Type;

export const OrchestrationShellStreamItem = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("snapshot"),
    snapshot: OrchestrationShellSnapshot,
  }),
  OrchestrationShellStreamEvent,
]);
export type OrchestrationShellStreamItem = typeof OrchestrationShellStreamItem.Type;

export const ProjectCreateCommand = Schema.Struct({
  type: Schema.Literal("project.create"),
  commandId: CommandId,
  projectId: ProjectId,
  kind: Schema.optional(ProjectKind).pipe(Schema.withDecodingDefault(() => "project")),
  title: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  createWorkspaceRootIfMissing: Schema.optional(Schema.Boolean).pipe(
    Schema.withDecodingDefault(() => false),
  ),
  defaultModelSelection: Schema.optional(Schema.NullOr(ModelSelection)),
  createdAt: IsoDateTime,
});

const ProjectMetaUpdateCommand = Schema.Struct({
  type: Schema.Literal("project.meta.update"),
  commandId: CommandId,
  projectId: ProjectId,
  kind: Schema.optional(ProjectKind),
  title: Schema.optional(TrimmedNonEmptyString),
  workspaceRoot: Schema.optional(TrimmedNonEmptyString),
  defaultModelSelection: Schema.optional(Schema.NullOr(ModelSelection)),
  scripts: Schema.optional(Schema.Array(ProjectScript)),
});

const ProjectDeleteCommand = Schema.Struct({
  type: Schema.Literal("project.delete"),
  commandId: CommandId,
  projectId: ProjectId,
});

const ThreadCreateCommand = Schema.Struct({
  type: Schema.Literal("thread.create"),
  commandId: CommandId,
  threadId: ThreadId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(() => DEFAULT_PROVIDER_INTERACTION_MODE),
  ),
  envMode: Schema.optional(ThreadEnvironmentMode).pipe(Schema.withDecodingDefault(() => "local")),
  branch: Schema.NullOr(TrimmedNonEmptyString),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  associatedWorktreePath: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  associatedWorktreeBranch: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  associatedWorktreeRef: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  createBranchFlowCompleted: Schema.optional(Schema.Boolean).pipe(
    Schema.withDecodingDefault(() => false),
  ),
  isPinned: Schema.optional(Schema.Boolean).pipe(Schema.withDecodingDefault(() => false)),
  parentThreadId: Schema.optional(Schema.NullOr(ThreadId)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  subagentAgentId: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  subagentNickname: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  subagentRole: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  lastKnownPr: Schema.optional(Schema.NullOr(OrchestrationThreadPullRequest)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  reviewChatTarget: Schema.optional(Schema.NullOr(OrchestrationReviewChatTarget)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  runtimePlan: Schema.optional(Schema.NullOr(RuntimePlan)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  createdAt: IsoDateTime,
});

export const ThreadHandoffImportedMessage = Schema.Struct({
  messageId: MessageId,
  role: Schema.Literals(["user", "assistant"]),
  text: Schema.String,
  attachments: Schema.optional(Schema.Array(ChatAttachment)),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ThreadHandoffImportedMessage = typeof ThreadHandoffImportedMessage.Type;

const ThreadHandoffCreateCommand = Schema.Struct({
  type: Schema.Literal("thread.handoff.create"),
  commandId: CommandId,
  threadId: ThreadId,
  sourceThreadId: ThreadId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(() => DEFAULT_PROVIDER_INTERACTION_MODE),
  ),
  envMode: Schema.optional(ThreadEnvironmentMode).pipe(Schema.withDecodingDefault(() => "local")),
  branch: Schema.NullOr(TrimmedNonEmptyString),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  associatedWorktreePath: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  associatedWorktreeBranch: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  associatedWorktreeRef: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  createBranchFlowCompleted: Schema.optional(Schema.Boolean).pipe(
    Schema.withDecodingDefault(() => false),
  ),
  runtimePlan: Schema.optional(Schema.NullOr(RuntimePlan)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  importedMessages: Schema.Array(ThreadHandoffImportedMessage),
  createdAt: IsoDateTime,
});

const ThreadForkCreateCommand = Schema.Struct({
  type: Schema.Literal("thread.fork.create"),
  commandId: CommandId,
  threadId: ThreadId,
  sourceThreadId: ThreadId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(() => DEFAULT_PROVIDER_INTERACTION_MODE),
  ),
  envMode: Schema.optional(ThreadEnvironmentMode).pipe(Schema.withDecodingDefault(() => "local")),
  branch: Schema.NullOr(TrimmedNonEmptyString),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  associatedWorktreePath: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  associatedWorktreeBranch: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  associatedWorktreeRef: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  createBranchFlowCompleted: Schema.optional(Schema.Boolean).pipe(
    Schema.withDecodingDefault(() => false),
  ),
  sidechatSourceThreadId: SidechatSourceThreadId,
  runtimePlan: Schema.optional(Schema.NullOr(RuntimePlan)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  importedMessages: Schema.Array(ThreadHandoffImportedMessage),
  createdAt: IsoDateTime,
});

const ThreadDeleteCommand = Schema.Struct({
  type: Schema.Literal("thread.delete"),
  commandId: CommandId,
  threadId: ThreadId,
});

const ThreadArchiveCommand = Schema.Struct({
  type: Schema.Literal("thread.archive"),
  commandId: CommandId,
  threadId: ThreadId,
});

const ThreadUnarchiveCommand = Schema.Struct({
  type: Schema.Literal("thread.unarchive"),
  commandId: CommandId,
  threadId: ThreadId,
});

const ThreadMetaUpdateCommand = Schema.Struct({
  type: Schema.Literal("thread.meta.update"),
  commandId: CommandId,
  threadId: ThreadId,
  title: Schema.optional(TrimmedNonEmptyString),
  modelSelection: Schema.optional(ModelSelection),
  envMode: Schema.optional(ThreadEnvironmentMode),
  branch: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  worktreePath: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  associatedWorktreePath: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  associatedWorktreeBranch: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  associatedWorktreeRef: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  createBranchFlowCompleted: Schema.optional(Schema.Boolean),
  isPinned: Schema.optional(Schema.Boolean),
  parentThreadId: Schema.optional(Schema.NullOr(ThreadId)),
  subagentAgentId: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  subagentNickname: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  subagentRole: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  handoff: Schema.optional(Schema.NullOr(ThreadHandoff)),
  lastKnownPr: Schema.optional(Schema.NullOr(OrchestrationThreadPullRequest)),
  reviewChatTarget: Schema.optional(Schema.NullOr(OrchestrationReviewChatTarget)),
});

const ThreadRuntimeModeSetCommand = Schema.Struct({
  type: Schema.Literal("thread.runtime-mode.set"),
  commandId: CommandId,
  threadId: ThreadId,
  runtimeMode: RuntimeMode,
  createdAt: IsoDateTime,
});

const ThreadInteractionModeSetCommand = Schema.Struct({
  type: Schema.Literal("thread.interaction-mode.set"),
  commandId: CommandId,
  threadId: ThreadId,
  interactionMode: ProviderInteractionMode,
  createdAt: IsoDateTime,
});

export const ThreadTurnStartCommand = Schema.Struct({
  type: Schema.Literal("thread.turn.start"),
  commandId: CommandId,
  threadId: ThreadId,
  message: Schema.Struct({
    messageId: MessageId,
    role: Schema.Literal("user"),
    text: Schema.String,
    attachments: Schema.Array(ChatAttachment),
    skills: Schema.optional(Schema.Array(ProviderSkillReference)),
    mentions: Schema.optional(Schema.Array(ProviderMentionReference)),
    source: Schema.optional(OrchestrationMessageSource),
  }),
  modelSelection: Schema.optional(ModelSelection),
  providerOptions: Schema.optional(ProviderStartOptions),
  reviewTarget: Schema.optional(ProviderReviewTarget),
  assistantDeliveryMode: Schema.optional(AssistantDeliveryMode),
  dispatchMode: Schema.optional(TurnDispatchMode).pipe(
    Schema.withDecodingDefault(() => DEFAULT_TURN_DISPATCH_MODE),
  ),
  runtimeMode: RuntimeMode.pipe(Schema.withDecodingDefault(() => DEFAULT_RUNTIME_MODE)),
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(() => DEFAULT_PROVIDER_INTERACTION_MODE),
  ),
  sourceProposedPlan: Schema.optional(SourceProposedPlanReference),
  createdAt: IsoDateTime,
});

const ClientThreadTurnStartCommand = Schema.Struct({
  type: Schema.Literal("thread.turn.start"),
  commandId: CommandId,
  threadId: ThreadId,
  message: Schema.Struct({
    messageId: MessageId,
    role: Schema.Literal("user"),
    text: Schema.String,
    attachments: Schema.Array(UploadChatAttachment),
    skills: Schema.optional(Schema.Array(ProviderSkillReference)),
    mentions: Schema.optional(Schema.Array(ProviderMentionReference)),
    source: Schema.optional(OrchestrationMessageSource),
  }),
  modelSelection: Schema.optional(ModelSelection),
  providerOptions: Schema.optional(ProviderStartOptions),
  reviewTarget: Schema.optional(ProviderReviewTarget),
  assistantDeliveryMode: Schema.optional(AssistantDeliveryMode),
  dispatchMode: Schema.optional(TurnDispatchMode).pipe(
    Schema.withDecodingDefault(() => DEFAULT_TURN_DISPATCH_MODE),
  ),
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  sourceProposedPlan: Schema.optional(SourceProposedPlanReference),
  createdAt: IsoDateTime,
});

const ThreadTurnInterruptCommand = Schema.Struct({
  type: Schema.Literal("thread.turn.interrupt"),
  commandId: CommandId,
  threadId: ThreadId,
  turnId: Schema.optional(TurnId),
  createdAt: IsoDateTime,
});

const ThreadDispatchQueuedTurnCommand = Schema.Struct({
  type: Schema.Literal("thread.turn.dispatch-queued"),
  commandId: CommandId,
  threadId: ThreadId,
  messageId: MessageId,
  modelSelection: Schema.optional(ModelSelection),
  providerOptions: Schema.optional(ProviderStartOptions),
  reviewTarget: Schema.optional(ProviderReviewTarget),
  assistantDeliveryMode: Schema.optional(AssistantDeliveryMode),
  dispatchMode: Schema.optional(TurnDispatchMode).pipe(
    Schema.withDecodingDefault(() => DEFAULT_TURN_DISPATCH_MODE),
  ),
  runtimeMode: RuntimeMode.pipe(Schema.withDecodingDefault(() => DEFAULT_RUNTIME_MODE)),
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(() => DEFAULT_PROVIDER_INTERACTION_MODE),
  ),
  sourceProposedPlan: Schema.optional(SourceProposedPlanReference),
  createdAt: IsoDateTime,
});

const ThreadApprovalRespondCommand = Schema.Struct({
  type: Schema.Literal("thread.approval.respond"),
  commandId: CommandId,
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  decision: ProviderApprovalDecision,
  createdAt: IsoDateTime,
});

const ThreadUserInputRespondCommand = Schema.Struct({
  type: Schema.Literal("thread.user-input.respond"),
  commandId: CommandId,
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  answers: ProviderUserInputAnswers,
  createdAt: IsoDateTime,
});

const ThreadCheckpointRevertCommand = Schema.Struct({
  type: Schema.Literal("thread.checkpoint.revert"),
  commandId: CommandId,
  threadId: ThreadId,
  turnCount: NonNegativeInt,
  createdAt: IsoDateTime,
});

const ThreadConversationRollbackCommand = Schema.Struct({
  type: Schema.Literal("thread.conversation.rollback"),
  commandId: CommandId,
  threadId: ThreadId,
  messageId: MessageId,
  numTurns: NonNegativeInt,
  createdAt: IsoDateTime,
});

const ThreadMessageEditAndResendCommand = Schema.Struct({
  type: Schema.Literal("thread.message.edit-and-resend"),
  commandId: CommandId,
  threadId: ThreadId,
  messageId: MessageId,
  text: TrimmedNonEmptyString.check(Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_INPUT_CHARS)),
  modelSelection: Schema.optional(ModelSelection),
  providerOptions: Schema.optional(ProviderStartOptions),
  assistantDeliveryMode: Schema.optional(AssistantDeliveryMode),
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  createdAt: IsoDateTime,
});

const ThreadSessionStopCommand = Schema.Struct({
  type: Schema.Literal("thread.session.stop"),
  commandId: CommandId,
  threadId: ThreadId,
  createdAt: IsoDateTime,
});

const ThreadSessionEnsureCommand = Schema.Struct({
  type: Schema.Literal("thread.session.ensure"),
  commandId: CommandId,
  threadId: ThreadId,
  modelSelection: Schema.optional(ModelSelection),
  providerOptions: Schema.optional(ProviderStartOptions),
  runtimeMode: RuntimeMode,
  createdAt: IsoDateTime,
});

const ThreadRuntimeActionRequestCommand = Schema.Struct({
  type: Schema.Literal("thread.runtime.action"),
  commandId: CommandId,
  threadId: ThreadId,
  action: Schema.Literals(["stop", "destroy", "snapshot"]),
  instanceId: ExecutionInstanceId,
  createdAt: IsoDateTime,
});

const ThreadActivityAppendCommand = Schema.Struct({
  type: Schema.Literal("thread.activity.append"),
  commandId: CommandId,
  threadId: ThreadId,
  activity: OrchestrationThreadActivity,
  createdAt: IsoDateTime,
});

const DispatchableClientOrchestrationCommand = Schema.Union([
  ProjectCreateCommand,
  ProjectMetaUpdateCommand,
  ProjectDeleteCommand,
  ThreadCreateCommand,
  ThreadHandoffCreateCommand,
  ThreadForkCreateCommand,
  ThreadDeleteCommand,
  ThreadArchiveCommand,
  ThreadUnarchiveCommand,
  ThreadMetaUpdateCommand,
  ThreadRuntimeModeSetCommand,
  ThreadInteractionModeSetCommand,
  ThreadTurnStartCommand,
  ThreadTurnInterruptCommand,
  ThreadApprovalRespondCommand,
  ThreadUserInputRespondCommand,
  ThreadCheckpointRevertCommand,
  ThreadMessageEditAndResendCommand,
  ThreadActivityAppendCommand,
  ThreadSessionStopCommand,
  ThreadSessionEnsureCommand,
  ThreadRuntimeActionRequestCommand,
]);
export type DispatchableClientOrchestrationCommand =
  typeof DispatchableClientOrchestrationCommand.Type;

export const ClientOrchestrationCommand = Schema.Union([
  ProjectCreateCommand,
  ProjectMetaUpdateCommand,
  ProjectDeleteCommand,
  ThreadCreateCommand,
  ThreadHandoffCreateCommand,
  ThreadForkCreateCommand,
  ThreadDeleteCommand,
  ThreadArchiveCommand,
  ThreadUnarchiveCommand,
  ThreadMetaUpdateCommand,
  ThreadRuntimeModeSetCommand,
  ThreadInteractionModeSetCommand,
  ClientThreadTurnStartCommand,
  ThreadTurnInterruptCommand,
  ThreadApprovalRespondCommand,
  ThreadUserInputRespondCommand,
  ThreadCheckpointRevertCommand,
  ThreadMessageEditAndResendCommand,
  ThreadActivityAppendCommand,
  ThreadSessionStopCommand,
  ThreadSessionEnsureCommand,
  ThreadRuntimeActionRequestCommand,
]);
export type ClientOrchestrationCommand = typeof ClientOrchestrationCommand.Type;

const ThreadSessionSetCommand = Schema.Struct({
  type: Schema.Literal("thread.session.set"),
  commandId: CommandId,
  threadId: ThreadId,
  session: OrchestrationSession,
  createdAt: IsoDateTime,
});

const ThreadMessagesImportCommand = Schema.Struct({
  type: Schema.Literal("thread.messages.import"),
  commandId: CommandId,
  threadId: ThreadId,
  messages: Schema.Array(ThreadHandoffImportedMessage),
  createdAt: IsoDateTime,
});

const ThreadMessageAssistantDeltaCommand = Schema.Struct({
  type: Schema.Literal("thread.message.assistant.delta"),
  commandId: CommandId,
  threadId: ThreadId,
  messageId: MessageId,
  delta: Schema.String,
  turnId: Schema.optional(TurnId),
  createdAt: IsoDateTime,
});

const ThreadMessageAssistantCompleteCommand = Schema.Struct({
  type: Schema.Literal("thread.message.assistant.complete"),
  commandId: CommandId,
  threadId: ThreadId,
  messageId: MessageId,
  turnId: Schema.optional(TurnId),
  createdAt: IsoDateTime,
});

const ThreadProposedPlanUpsertCommand = Schema.Struct({
  type: Schema.Literal("thread.proposed-plan.upsert"),
  commandId: CommandId,
  threadId: ThreadId,
  proposedPlan: OrchestrationProposedPlan,
  createdAt: IsoDateTime,
});

const ThreadTurnDiffCompleteCommand = Schema.Struct({
  type: Schema.Literal("thread.turn.diff.complete"),
  commandId: CommandId,
  threadId: ThreadId,
  turnId: TurnId,
  completedAt: IsoDateTime,
  checkpointRef: CheckpointRef,
  status: OrchestrationCheckpointStatus,
  files: Schema.Array(OrchestrationCheckpointFile),
  assistantMessageId: Schema.optional(MessageId),
  checkpointTurnCount: NonNegativeInt,
  createdAt: IsoDateTime,
});

const ThreadRevertCompleteCommand = Schema.Struct({
  type: Schema.Literal("thread.revert.complete"),
  commandId: CommandId,
  threadId: ThreadId,
  turnCount: NonNegativeInt,
  createdAt: IsoDateTime,
});

const ThreadConversationRollbackCompleteCommand = Schema.Struct({
  type: Schema.Literal("thread.conversation.rollback.complete"),
  commandId: CommandId,
  threadId: ThreadId,
  messageId: MessageId,
  numTurns: NonNegativeInt,
  removedTurnIds: Schema.optional(Schema.Array(TurnId)),
  skipAttachmentPrune: Schema.optional(Schema.Boolean),
  createdAt: IsoDateTime,
});

// Execution-runtime infra commands. Internal-only (driven by the runtime
// reactor with stable commandIds so reconnect/crash retries dedupe on the
// receipt, not the event). No public `runtimePlan` surface lands until a later
// slice; these are the internal command path for the runtime mechanism.
//
// Each command carries the data its event needs. The reactor resolves provider
// results through `ExecutionRuntimeService` first, then dispatches a command
// recording the resolved fact — the decider stays provider-agnostic and never
// invents instance ids or statuses.
const ThreadRuntimeProvisionCommand = Schema.Struct({
  type: Schema.Literal("thread.runtime.provision"),
  commandId: CommandId,
  threadId: ThreadId,
  targetKind: ExecutionTargetKind,
  provider: ExecutionRuntimeProvider,
  role: RuntimeRole,
  createdAt: IsoDateTime,
});

const ThreadRuntimeInstanceRecordCommand = Schema.Struct({
  type: Schema.Literal("thread.runtime.instance.record"),
  commandId: CommandId,
  threadId: ThreadId,
  instanceId: ExecutionInstanceId,
  provider: ExecutionRuntimeProvider,
  status: RuntimeInstanceStatus,
  rootPath: Schema.NullOr(TrimmedNonEmptyString),
  createdAt: IsoDateTime,
});

const ThreadRuntimeStateRecordCommand = Schema.Struct({
  type: Schema.Literal("thread.runtime.state.record"),
  commandId: CommandId,
  threadId: ThreadId,
  instanceId: ExecutionInstanceId,
  status: RuntimeInstanceStatus,
  rootPath: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  failureReason: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  createdAt: IsoDateTime,
});

const ThreadRuntimeStopCommand = Schema.Struct({
  type: Schema.Literal("thread.runtime.stop"),
  commandId: CommandId,
  threadId: ThreadId,
  instanceId: ExecutionInstanceId,
  createdAt: IsoDateTime,
});

const ThreadRuntimeDestroyCommand = Schema.Struct({
  type: Schema.Literal("thread.runtime.destroy"),
  commandId: CommandId,
  threadId: ThreadId,
  instanceId: ExecutionInstanceId,
  createdAt: IsoDateTime,
});

const ThreadRuntimeProcessStartCommand = Schema.Struct({
  type: Schema.Literal("thread.runtime.process.start"),
  commandId: CommandId,
  threadId: ThreadId,
  instanceId: ExecutionInstanceId,
  processId: RuntimeProcessId,
  role: RuntimeRole,
  command: Schema.NullOr(TrimmedNonEmptyString),
  createdAt: IsoDateTime,
});

const ThreadRuntimeProcessOutputCommand = Schema.Struct({
  type: Schema.Literal("thread.runtime.process.output"),
  commandId: CommandId,
  threadId: ThreadId,
  instanceId: ExecutionInstanceId,
  processId: RuntimeProcessId,
  stream: Schema.Literals(["stdout", "stderr"]),
  tail: Schema.String,
  createdAt: IsoDateTime,
});

const ThreadRuntimeProcessCompleteCommand = Schema.Struct({
  type: Schema.Literal("thread.runtime.process.complete"),
  commandId: CommandId,
  threadId: ThreadId,
  instanceId: ExecutionInstanceId,
  processId: RuntimeProcessId,
  status: Schema.Literals(["exited", "failed"]),
  exitCode: Schema.NullOr(Schema.Int),
  failureReason: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  tail: Schema.optional(Schema.NullOr(Schema.String)),
  createdAt: IsoDateTime,
});

const ThreadRuntimeSnapshotCommand = Schema.Struct({
  type: Schema.Literal("thread.runtime.snapshot"),
  commandId: CommandId,
  threadId: ThreadId,
  instanceId: ExecutionInstanceId,
  snapshotId: RuntimeSnapshotId,
  label: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  secretTainted: Schema.optional(Schema.Boolean),
  createdAt: IsoDateTime,
});

const ThreadRuntimeExposePortCommand = Schema.Struct({
  type: Schema.Literal("thread.runtime.expose-port"),
  commandId: CommandId,
  threadId: ThreadId,
  instanceId: ExecutionInstanceId,
  routeId: RuntimeRouteId,
  port: PositiveInt,
  url: Schema.NullOr(TrimmedNonEmptyString),
  label: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  createdAt: IsoDateTime,
});

const ThreadRuntimeLeaseAcquireCommand = Schema.Struct({
  type: Schema.Literal("thread.runtime.lease.acquire"),
  commandId: CommandId,
  threadId: ThreadId,
  instanceId: ExecutionInstanceId,
  leaseId: RuntimeActivityLeaseId,
  reason: Schema.Literals(["turn", "terminal", "preview"]),
  expiresAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  createdAt: IsoDateTime,
});

const ThreadRuntimeLeaseReleaseCommand = Schema.Struct({
  type: Schema.Literal("thread.runtime.lease.release"),
  commandId: CommandId,
  threadId: ThreadId,
  instanceId: ExecutionInstanceId,
  leaseId: RuntimeActivityLeaseId,
  reason: Schema.Literals(["turn", "terminal", "preview"]),
  acquiredAt: IsoDateTime,
  createdAt: IsoDateTime,
});

const ThreadRuntimeFailCommand = Schema.Struct({
  type: Schema.Literal("thread.runtime.fail"),
  commandId: CommandId,
  threadId: ThreadId,
  instanceId: Schema.NullOr(ExecutionInstanceId),
  failureReason: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
});

const InternalOrchestrationCommand = Schema.Union([
  ThreadSessionSetCommand,
  ThreadMessagesImportCommand,
  ThreadMessageAssistantDeltaCommand,
  ThreadMessageAssistantCompleteCommand,
  ThreadProposedPlanUpsertCommand,
  ThreadTurnDiffCompleteCommand,
  ThreadActivityAppendCommand,
  ThreadRevertCompleteCommand,
  ThreadConversationRollbackCommand,
  ThreadConversationRollbackCompleteCommand,
  ThreadDispatchQueuedTurnCommand,
  ThreadRuntimeProvisionCommand,
  ThreadRuntimeInstanceRecordCommand,
  ThreadRuntimeStateRecordCommand,
  ThreadRuntimeStopCommand,
  ThreadRuntimeDestroyCommand,
  ThreadRuntimeProcessStartCommand,
  ThreadRuntimeProcessOutputCommand,
  ThreadRuntimeProcessCompleteCommand,
  ThreadRuntimeSnapshotCommand,
  ThreadRuntimeExposePortCommand,
  ThreadRuntimeFailCommand,
  ThreadRuntimeLeaseAcquireCommand,
  ThreadRuntimeLeaseReleaseCommand,
]);
export type InternalOrchestrationCommand = typeof InternalOrchestrationCommand.Type;

export const OrchestrationCommand = Schema.Union([
  DispatchableClientOrchestrationCommand,
  InternalOrchestrationCommand,
]);
export type OrchestrationCommand = typeof OrchestrationCommand.Type;

export const OrchestrationEventType = Schema.Literals([
  "project.created",
  "project.meta-updated",
  "project.deleted",
  "thread.created",
  "thread.deleted",
  // Legacy desktop installs can still contain these rows in orchestration_events.
  "thread.archived",
  "thread.unarchived",
  "thread.meta-updated",
  "thread.runtime-mode-set",
  "thread.interaction-mode-set",
  "thread.message-sent",
  "thread.turn-queued",
  "thread.turn-start-requested",
  "thread.turn-interrupt-requested",
  "thread.approval-response-requested",
  "thread.user-input-response-requested",
  "thread.checkpoint-revert-requested",
  "thread.reverted",
  "thread.conversation-rollback-requested",
  "thread.conversation-rolled-back",
  "thread.message-edit-resend-requested",
  "thread.session-stop-requested",
  "thread.session-ensure-requested",
  "thread.runtime-action-requested",
  "thread.session-set",
  "thread.proposed-plan-upserted",
  "thread.turn-diff-completed",
  "thread.activity-appended",
  "thread.runtime-provision-requested",
  "thread.runtime-instance-created",
  "thread.runtime-instance-state-changed",
  "thread.runtime-process-started",
  "thread.runtime-process-output",
  "thread.runtime-process-completed",
  "thread.runtime-route-exposed",
  "thread.runtime-snapshot-created",
  "thread.runtime-lease-renewed",
  "thread.runtime-destroyed",
  "thread.runtime-failed",
]);
export type OrchestrationEventType = typeof OrchestrationEventType.Type;

export const OrchestrationAggregateKind = Schema.Literals(["project", "thread"]);
export type OrchestrationAggregateKind = typeof OrchestrationAggregateKind.Type;
export const OrchestrationActorKind = Schema.Literals(["client", "server", "provider"]);

export const ProjectCreatedPayload = Schema.Struct({
  projectId: ProjectId,
  kind: Schema.optional(ProjectKind).pipe(Schema.withDecodingDefault(() => "project")),
  title: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  defaultModelSelection: Schema.NullOr(ModelSelection),
  scripts: Schema.Array(ProjectScript),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

export const ProjectMetaUpdatedPayload = Schema.Struct({
  projectId: ProjectId,
  kind: Schema.optional(ProjectKind),
  title: Schema.optional(TrimmedNonEmptyString),
  workspaceRoot: Schema.optional(TrimmedNonEmptyString),
  defaultModelSelection: Schema.optional(Schema.NullOr(ModelSelection)),
  scripts: Schema.optional(Schema.Array(ProjectScript)),
  updatedAt: IsoDateTime,
});

export const ProjectDeletedPayload = Schema.Struct({
  projectId: ProjectId,
  deletedAt: IsoDateTime,
});

export const ThreadCreatedPayload = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode.pipe(Schema.withDecodingDefault(() => DEFAULT_RUNTIME_MODE)),
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(() => DEFAULT_PROVIDER_INTERACTION_MODE),
  ),
  envMode: Schema.optional(ThreadEnvironmentMode).pipe(Schema.withDecodingDefault(() => "local")),
  branch: Schema.NullOr(TrimmedNonEmptyString),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  associatedWorktreePath: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  associatedWorktreeBranch: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  associatedWorktreeRef: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  createBranchFlowCompleted: Schema.optional(Schema.Boolean).pipe(
    Schema.withDecodingDefault(() => false),
  ),
  isPinned: Schema.optional(Schema.Boolean).pipe(Schema.withDecodingDefault(() => false)),
  parentThreadId: Schema.optional(Schema.NullOr(ThreadId)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  subagentAgentId: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  subagentNickname: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  subagentRole: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  forkSourceThreadId: Schema.optional(Schema.NullOr(ThreadId)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  sidechatSourceThreadId: SidechatSourceThreadId,
  lastKnownPr: Schema.optional(Schema.NullOr(OrchestrationThreadPullRequest)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  reviewChatTarget: Schema.optional(Schema.NullOr(OrchestrationReviewChatTarget)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  // The requested execution target carried from create/handoff/fork. It is plan
  // *input*, not thread state: the reactor validates and provisions from it; the
  // resolved runtime read-model lives on `OrchestrationThread.runtime` instead.
  runtimePlan: Schema.optional(Schema.NullOr(RuntimePlan)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  handoff: Schema.NullOr(ThreadHandoff).pipe(Schema.withDecodingDefault(() => null)),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

export const ThreadDeletedPayload = Schema.Struct({
  threadId: ThreadId,
  deletedAt: IsoDateTime,
});

export const ThreadArchivedPayload = Schema.Struct({
  threadId: ThreadId,
  // Required for new events, optional for legacy events
  archivedAt: Schema.optional(IsoDateTime),
  updatedAt: Schema.optional(IsoDateTime),
});

export const ThreadUnarchivedPayload = Schema.Struct({
  threadId: ThreadId,
  // Legacy field - kept for backward compatibility with old events
  unarchivedAt: Schema.optional(IsoDateTime),
  // Required for new events
  updatedAt: Schema.optional(IsoDateTime),
});

export const ThreadMetaUpdatedPayload = Schema.Struct({
  threadId: ThreadId,
  title: Schema.optional(TrimmedNonEmptyString),
  modelSelection: Schema.optional(ModelSelection),
  envMode: Schema.optional(ThreadEnvironmentMode),
  branch: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  worktreePath: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  associatedWorktreePath: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  associatedWorktreeBranch: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  associatedWorktreeRef: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  createBranchFlowCompleted: Schema.optional(Schema.Boolean),
  isPinned: Schema.optional(Schema.Boolean),
  parentThreadId: Schema.optional(Schema.NullOr(ThreadId)),
  subagentAgentId: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  subagentNickname: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  subagentRole: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  handoff: Schema.optional(Schema.NullOr(ThreadHandoff)),
  lastKnownPr: Schema.optional(Schema.NullOr(OrchestrationThreadPullRequest)),
  reviewChatTarget: Schema.optional(Schema.NullOr(OrchestrationReviewChatTarget)),
  updatedAt: IsoDateTime,
});

export const ThreadRuntimeModeSetPayload = Schema.Struct({
  threadId: ThreadId,
  runtimeMode: RuntimeMode,
  updatedAt: IsoDateTime,
});

export const ThreadInteractionModeSetPayload = Schema.Struct({
  threadId: ThreadId,
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(() => DEFAULT_PROVIDER_INTERACTION_MODE),
  ),
  updatedAt: IsoDateTime,
});

export const ThreadMessageSentPayload = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  role: OrchestrationMessageRole,
  text: Schema.String,
  attachments: Schema.optional(Schema.Array(ChatAttachment)),
  skills: Schema.optional(Schema.Array(ProviderSkillReference)),
  mentions: Schema.optional(Schema.Array(ProviderMentionReference)),
  dispatchMode: Schema.optional(TurnDispatchMode),
  turnId: Schema.NullOr(TurnId),
  streaming: Schema.Boolean,
  source: OrchestrationMessageSource.pipe(Schema.withDecodingDefault(() => "native")),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

export const ThreadTurnStartRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  modelSelection: Schema.optional(ModelSelection),
  providerOptions: Schema.optional(ProviderStartOptions),
  reviewTarget: Schema.optional(ProviderReviewTarget),
  assistantDeliveryMode: Schema.optional(AssistantDeliveryMode),
  dispatchMode: TurnDispatchMode.pipe(Schema.withDecodingDefault(() => DEFAULT_TURN_DISPATCH_MODE)),
  runtimeMode: RuntimeMode.pipe(Schema.withDecodingDefault(() => DEFAULT_RUNTIME_MODE)),
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(() => DEFAULT_PROVIDER_INTERACTION_MODE),
  ),
  sourceProposedPlan: Schema.optional(SourceProposedPlanReference),
  createdAt: IsoDateTime,
});

export const ThreadTurnQueuedPayload = ThreadTurnStartRequestedPayload;

export const ThreadTurnInterruptRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  turnId: Schema.optional(TurnId),
  createdAt: IsoDateTime,
});

export const ThreadApprovalResponseRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  decision: ProviderApprovalDecision,
  createdAt: IsoDateTime,
});

const ThreadUserInputResponseRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  answers: ProviderUserInputAnswers,
  createdAt: IsoDateTime,
});

export const ThreadCheckpointRevertRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  turnCount: NonNegativeInt,
  createdAt: IsoDateTime,
});

export const ThreadRevertedPayload = Schema.Struct({
  threadId: ThreadId,
  turnCount: NonNegativeInt,
});

export const ThreadConversationRollbackRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  numTurns: NonNegativeInt,
  createdAt: IsoDateTime,
});

export const ThreadConversationRolledBackPayload = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  numTurns: NonNegativeInt,
  removedTurnIds: Schema.optional(Schema.Array(TurnId)),
  skipAttachmentPrune: Schema.optional(Schema.Boolean),
});

export const ThreadMessageEditResendRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  text: TrimmedNonEmptyString.check(Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_INPUT_CHARS)),
  rollbackTurnCount: Schema.optional(NonNegativeInt),
  removedTurnIds: Schema.optional(Schema.Array(TurnId)),
  modelSelection: Schema.optional(ModelSelection),
  providerOptions: Schema.optional(ProviderStartOptions),
  assistantDeliveryMode: Schema.optional(AssistantDeliveryMode),
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  createdAt: IsoDateTime,
});

export const ThreadSessionStopRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  createdAt: IsoDateTime,
});

export const ThreadSessionEnsureRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  modelSelection: Schema.optional(ModelSelection),
  providerOptions: Schema.optional(ProviderStartOptions),
  runtimeMode: RuntimeMode,
  createdAt: IsoDateTime,
});

export const ThreadRuntimeActionRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  action: Schema.Literals(["stop", "destroy", "snapshot"]),
  instanceId: ExecutionInstanceId,
});

export const ThreadSessionSetPayload = Schema.Struct({
  threadId: ThreadId,
  session: OrchestrationSession,
});

export const ThreadProposedPlanUpsertedPayload = Schema.Struct({
  threadId: ThreadId,
  proposedPlan: OrchestrationProposedPlan,
});

export const ThreadTurnDiffCompletedPayload = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
  checkpointTurnCount: NonNegativeInt,
  checkpointRef: CheckpointRef,
  status: OrchestrationCheckpointStatus,
  files: Schema.Array(OrchestrationCheckpointFile),
  assistantMessageId: Schema.NullOr(MessageId),
  completedAt: IsoDateTime,
});

export const ThreadActivityAppendedPayload = Schema.Struct({
  threadId: ThreadId,
  activity: OrchestrationThreadActivity,
});

/**
 * Execution-runtime infra lifecycle payloads. These project into the dedicated
 * `projection_thread_runtime` + `execution_runtime_*` tables, never onto the
 * wide `projection_threads` row. `runtime-process-output` is stream-only: it
 * carries a short tail, not every line (resolved decision #5).
 */
export const ThreadRuntimeProvisionRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  targetKind: ExecutionTargetKind,
  provider: ExecutionRuntimeProvider,
  role: RuntimeRole,
  requestedAt: IsoDateTime,
});

export const ThreadRuntimeInstanceCreatedPayload = Schema.Struct({
  threadId: ThreadId,
  instanceId: ExecutionInstanceId,
  provider: ExecutionRuntimeProvider,
  status: RuntimeInstanceStatus,
  rootPath: Schema.NullOr(TrimmedNonEmptyString),
  createdAt: IsoDateTime,
});

export const ThreadRuntimeInstanceStateChangedPayload = Schema.Struct({
  threadId: ThreadId,
  instanceId: ExecutionInstanceId,
  status: RuntimeInstanceStatus,
  rootPath: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  failureReason: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  updatedAt: IsoDateTime,
});

export const ThreadRuntimeProcessStartedPayload = Schema.Struct({
  threadId: ThreadId,
  instanceId: ExecutionInstanceId,
  processId: RuntimeProcessId,
  role: RuntimeRole,
  command: Schema.NullOr(TrimmedNonEmptyString),
  startedAt: IsoDateTime,
});

export const ThreadRuntimeProcessOutputPayload = Schema.Struct({
  threadId: ThreadId,
  instanceId: ExecutionInstanceId,
  processId: RuntimeProcessId,
  stream: Schema.Literals(["stdout", "stderr"]),
  tail: Schema.String,
  occurredAt: IsoDateTime,
});

export const ThreadRuntimeProcessCompletedPayload = Schema.Struct({
  threadId: ThreadId,
  instanceId: ExecutionInstanceId,
  processId: RuntimeProcessId,
  status: Schema.Literals(["exited", "failed"]),
  exitCode: Schema.NullOr(Schema.Int),
  failureReason: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  tail: Schema.optional(Schema.NullOr(Schema.String)).pipe(Schema.withDecodingDefault(() => null)),
  exitedAt: IsoDateTime,
});

export const ThreadRuntimeRouteExposedPayload = Schema.Struct({
  threadId: ThreadId,
  instanceId: ExecutionInstanceId,
  routeId: RuntimeRouteId,
  port: PositiveInt,
  url: Schema.NullOr(TrimmedNonEmptyString),
  label: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  exposedAt: IsoDateTime,
});

export const ThreadRuntimeSnapshotCreatedPayload = Schema.Struct({
  threadId: ThreadId,
  instanceId: ExecutionInstanceId,
  snapshotId: RuntimeSnapshotId,
  label: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  secretTainted: Schema.optional(Schema.Boolean).pipe(Schema.withDecodingDefault(() => false)),
  createdAt: IsoDateTime,
});

export const ThreadRuntimeLeaseRenewedPayload = Schema.Struct({
  threadId: ThreadId,
  instanceId: ExecutionInstanceId,
  leaseId: RuntimeActivityLeaseId,
  reason: Schema.Literals(["turn", "terminal", "preview"]),
  acquiredAt: IsoDateTime,
  renewedAt: Schema.optional(Schema.NullOr(IsoDateTime)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  expiresAt: Schema.optional(Schema.NullOr(IsoDateTime)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  released: Schema.optional(Schema.Boolean).pipe(Schema.withDecodingDefault(() => false)),
});

export const ThreadRuntimeDestroyedPayload = Schema.Struct({
  threadId: ThreadId,
  instanceId: ExecutionInstanceId,
  destroyedAt: IsoDateTime,
});

export const ThreadRuntimeFailedPayload = Schema.Struct({
  threadId: ThreadId,
  instanceId: Schema.NullOr(ExecutionInstanceId),
  failureReason: TrimmedNonEmptyString,
  occurredAt: IsoDateTime,
});

export const OrchestrationEventMetadata = Schema.Struct({
  providerTurnId: Schema.optional(TrimmedNonEmptyString),
  providerItemId: Schema.optional(ProviderItemId),
  adapterKey: Schema.optional(TrimmedNonEmptyString),
  requestId: Schema.optional(ApprovalRequestId),
  ingestedAt: Schema.optional(IsoDateTime),
});
export type OrchestrationEventMetadata = typeof OrchestrationEventMetadata.Type;

const EventBaseFields = {
  sequence: NonNegativeInt,
  eventId: EventId,
  aggregateKind: OrchestrationAggregateKind,
  aggregateId: Schema.Union([ProjectId, ThreadId]),
  occurredAt: IsoDateTime,
  commandId: Schema.NullOr(CommandId),
  causationEventId: Schema.NullOr(EventId),
  correlationId: Schema.NullOr(CommandId),
  metadata: OrchestrationEventMetadata,
} as const;

export const OrchestrationEvent = Schema.Union([
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("project.created"),
    payload: ProjectCreatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("project.meta-updated"),
    payload: ProjectMetaUpdatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("project.deleted"),
    payload: ProjectDeletedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.created"),
    payload: ThreadCreatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.deleted"),
    payload: ThreadDeletedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.archived"),
    payload: ThreadArchivedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.unarchived"),
    payload: ThreadUnarchivedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.meta-updated"),
    payload: ThreadMetaUpdatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.runtime-mode-set"),
    payload: ThreadRuntimeModeSetPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.interaction-mode-set"),
    payload: ThreadInteractionModeSetPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.message-sent"),
    payload: ThreadMessageSentPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.turn-queued"),
    payload: ThreadTurnQueuedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.turn-start-requested"),
    payload: ThreadTurnStartRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.turn-interrupt-requested"),
    payload: ThreadTurnInterruptRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.approval-response-requested"),
    payload: ThreadApprovalResponseRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.user-input-response-requested"),
    payload: ThreadUserInputResponseRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.checkpoint-revert-requested"),
    payload: ThreadCheckpointRevertRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.reverted"),
    payload: ThreadRevertedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.conversation-rollback-requested"),
    payload: ThreadConversationRollbackRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.conversation-rolled-back"),
    payload: ThreadConversationRolledBackPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.message-edit-resend-requested"),
    payload: ThreadMessageEditResendRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.session-stop-requested"),
    payload: ThreadSessionStopRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.session-ensure-requested"),
    payload: ThreadSessionEnsureRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.runtime-action-requested"),
    payload: ThreadRuntimeActionRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.session-set"),
    payload: ThreadSessionSetPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.proposed-plan-upserted"),
    payload: ThreadProposedPlanUpsertedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.turn-diff-completed"),
    payload: ThreadTurnDiffCompletedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.activity-appended"),
    payload: ThreadActivityAppendedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.runtime-provision-requested"),
    payload: ThreadRuntimeProvisionRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.runtime-instance-created"),
    payload: ThreadRuntimeInstanceCreatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.runtime-instance-state-changed"),
    payload: ThreadRuntimeInstanceStateChangedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.runtime-process-started"),
    payload: ThreadRuntimeProcessStartedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.runtime-process-output"),
    payload: ThreadRuntimeProcessOutputPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.runtime-process-completed"),
    payload: ThreadRuntimeProcessCompletedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.runtime-route-exposed"),
    payload: ThreadRuntimeRouteExposedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.runtime-snapshot-created"),
    payload: ThreadRuntimeSnapshotCreatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.runtime-lease-renewed"),
    payload: ThreadRuntimeLeaseRenewedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.runtime-destroyed"),
    payload: ThreadRuntimeDestroyedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.runtime-failed"),
    payload: ThreadRuntimeFailedPayload,
  }),
]);
export type OrchestrationEvent = typeof OrchestrationEvent.Type;

export const OrchestrationThreadDetailSnapshot = Schema.Struct({
  snapshotSequence: NonNegativeInt,
  thread: OrchestrationThread,
});
export type OrchestrationThreadDetailSnapshot = typeof OrchestrationThreadDetailSnapshot.Type;

export const OrchestrationThreadStreamItem = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("snapshot"),
    snapshot: OrchestrationThreadDetailSnapshot,
  }),
  Schema.Struct({
    kind: Schema.Literal("event"),
    event: OrchestrationEvent,
  }),
]);
export type OrchestrationThreadStreamItem = typeof OrchestrationThreadStreamItem.Type;

export const OrchestrationCommandReceiptStatus = Schema.Literals(["accepted", "rejected"]);
export type OrchestrationCommandReceiptStatus = typeof OrchestrationCommandReceiptStatus.Type;

export const TurnCountRange = Schema.Struct({
  fromTurnCount: NonNegativeInt,
  toTurnCount: NonNegativeInt,
}).check(
  Schema.makeFilter(
    (input) =>
      input.fromTurnCount <= input.toTurnCount ||
      new SchemaIssue.InvalidValue(Option.some(input.fromTurnCount), {
        message: "fromTurnCount must be less than or equal to toTurnCount",
      }),
    { identifier: "OrchestrationTurnDiffRange" },
  ),
);

export const ThreadTurnDiff = TurnCountRange.mapFields(
  Struct.assign({
    threadId: ThreadId,
    diff: Schema.String,
  }),
  { unsafePreserveChecks: true },
);

export const ProviderSessionRuntimeStatus = Schema.Literals([
  "starting",
  "running",
  "stopped",
  "error",
]);
export type ProviderSessionRuntimeStatus = typeof ProviderSessionRuntimeStatus.Type;

const ProjectionThreadTurnStatus = Schema.Literals([
  "running",
  "completed",
  "interrupted",
  "error",
]);
export type ProjectionThreadTurnStatus = typeof ProjectionThreadTurnStatus.Type;

const ProjectionCheckpointRow = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
  checkpointTurnCount: NonNegativeInt,
  checkpointRef: CheckpointRef,
  status: OrchestrationCheckpointStatus,
  files: Schema.Array(OrchestrationCheckpointFile),
  assistantMessageId: Schema.NullOr(MessageId),
  completedAt: IsoDateTime,
});
export type ProjectionCheckpointRow = typeof ProjectionCheckpointRow.Type;

export const ProjectionPendingApprovalStatus = Schema.Literals(["pending", "resolved"]);
export type ProjectionPendingApprovalStatus = typeof ProjectionPendingApprovalStatus.Type;

export const ProjectionPendingApprovalDecision = Schema.NullOr(ProviderApprovalDecision);
export type ProjectionPendingApprovalDecision = typeof ProjectionPendingApprovalDecision.Type;

export const DispatchResult = Schema.Struct({
  sequence: NonNegativeInt,
});
export type DispatchResult = typeof DispatchResult.Type;

export const OrchestrationGetSnapshotInput = Schema.Struct({});
export type OrchestrationGetSnapshotInput = typeof OrchestrationGetSnapshotInput.Type;
const OrchestrationGetSnapshotResult = OrchestrationReadModel;
export type OrchestrationGetSnapshotResult = typeof OrchestrationGetSnapshotResult.Type;

export const OrchestrationGetShellSnapshotInput = Schema.Struct({});
export type OrchestrationGetShellSnapshotInput = typeof OrchestrationGetShellSnapshotInput.Type;
const OrchestrationGetShellSnapshotResult = OrchestrationShellSnapshot;
export type OrchestrationGetShellSnapshotResult = typeof OrchestrationGetShellSnapshotResult.Type;

export const OrchestrationRepairStateInput = Schema.Struct({});
export type OrchestrationRepairStateInput = typeof OrchestrationRepairStateInput.Type;
const OrchestrationRepairStateResult = OrchestrationReadModel;
export type OrchestrationRepairStateResult = typeof OrchestrationRepairStateResult.Type;

export const OrchestrationGetTurnDiffInput = TurnCountRange.mapFields(
  Struct.assign({
    threadId: ThreadId,
    ignoreWhitespace: Schema.optional(Schema.Boolean),
  }),
  { unsafePreserveChecks: true },
);
export type OrchestrationGetTurnDiffInput = typeof OrchestrationGetTurnDiffInput.Type;

export const OrchestrationGetTurnDiffResult = ThreadTurnDiff;
export type OrchestrationGetTurnDiffResult = typeof OrchestrationGetTurnDiffResult.Type;

export const OrchestrationGetFullThreadDiffInput = Schema.Struct({
  threadId: ThreadId,
  toTurnCount: NonNegativeInt,
  ignoreWhitespace: Schema.optional(Schema.Boolean),
});
export type OrchestrationGetFullThreadDiffInput = typeof OrchestrationGetFullThreadDiffInput.Type;

export const OrchestrationGetFullThreadDiffResult = ThreadTurnDiff;
export type OrchestrationGetFullThreadDiffResult = typeof OrchestrationGetFullThreadDiffResult.Type;

export const OrchestrationReplayEventsInput = Schema.Struct({
  fromSequenceExclusive: NonNegativeInt,
});
export type OrchestrationReplayEventsInput = typeof OrchestrationReplayEventsInput.Type;

const OrchestrationReplayEventsResult = Schema.Array(OrchestrationEvent);
export type OrchestrationReplayEventsResult = typeof OrchestrationReplayEventsResult.Type;

export const OrchestrationSubscribeShellInput = Schema.Struct({});
export type OrchestrationSubscribeShellInput = typeof OrchestrationSubscribeShellInput.Type;

export const OrchestrationUnsubscribeShellInput = Schema.Struct({});
export type OrchestrationUnsubscribeShellInput = typeof OrchestrationUnsubscribeShellInput.Type;

export const OrchestrationSubscribeThreadInput = Schema.Struct({
  threadId: ThreadId,
});
export type OrchestrationSubscribeThreadInput = typeof OrchestrationSubscribeThreadInput.Type;

export const OrchestrationImportThreadInput = Schema.Struct({
  threadId: ThreadId,
  externalId: TrimmedNonEmptyString,
});
export type OrchestrationImportThreadInput = typeof OrchestrationImportThreadInput.Type;

export const OrchestrationImportThreadResult = Schema.Struct({
  threadId: ThreadId,
});
export type OrchestrationImportThreadResult = typeof OrchestrationImportThreadResult.Type;

export const OrchestrationUnsubscribeThreadInput = Schema.Struct({
  threadId: ThreadId,
});
export type OrchestrationUnsubscribeThreadInput = typeof OrchestrationUnsubscribeThreadInput.Type;

export const OrchestrationRpcSchemas = {
  getSnapshot: {
    input: OrchestrationGetSnapshotInput,
    output: OrchestrationGetSnapshotResult,
  },
  getShellSnapshot: {
    input: OrchestrationGetShellSnapshotInput,
    output: OrchestrationGetShellSnapshotResult,
  },
  repairState: {
    input: OrchestrationRepairStateInput,
    output: OrchestrationRepairStateResult,
  },
  dispatchCommand: {
    input: ClientOrchestrationCommand,
    output: DispatchResult,
  },
  importThread: {
    input: OrchestrationImportThreadInput,
    output: OrchestrationImportThreadResult,
  },
  getTurnDiff: {
    input: OrchestrationGetTurnDiffInput,
    output: OrchestrationGetTurnDiffResult,
  },
  getFullThreadDiff: {
    input: OrchestrationGetFullThreadDiffInput,
    output: OrchestrationGetFullThreadDiffResult,
  },
  replayEvents: {
    input: OrchestrationReplayEventsInput,
    output: OrchestrationReplayEventsResult,
  },
  subscribeShell: {
    input: OrchestrationSubscribeShellInput,
    output: Schema.Void,
  },
  unsubscribeShell: {
    input: OrchestrationUnsubscribeShellInput,
    output: Schema.Void,
  },
  subscribeThread: {
    input: OrchestrationSubscribeThreadInput,
    output: Schema.Void,
  },
  unsubscribeThread: {
    input: OrchestrationUnsubscribeThreadInput,
    output: Schema.Void,
  },
} as const;
