import { Option, Schema, SchemaIssue, Struct } from "effect";
import {
  AntigravityModelOptions,
  ClaudeModelOptions,
  CodexModelOptions,
  CursorModelOptions,
  DroidModelOptions,
  GrokModelOptions,
  OpenCodeModelOptions,
  PiModelOptions,
} from "./model";
import { ProviderMentionReference, ProviderSkillReference } from "./providerDiscovery";
import { ProjectKind } from "./project";
import { GitHubAccountSelection } from "./github";
import {
  ApprovalRequestId,
  CheckpointRef,
  CommandId,
  EventId,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ProviderItemId,
  ThreadId,
  ThreadMarkerId,
  TrimmedNonEmptyString,
  TurnId,
  WorktreeWorkspaceId,
  WorkspaceOperationId,
} from "./baseSchemas";

export const ORCHESTRATION_WS_METHODS = {
  getSnapshot: "orchestration.getSnapshot",
  getShellSnapshot: "orchestration.getShellSnapshot",
  dispatchCommand: "orchestration.dispatchCommand",
  getWorkspaceLifecyclePreflight: "orchestration.getWorkspaceLifecyclePreflight",
  importThread: "orchestration.importThread",
  repairState: "orchestration.repairState",
  getTurnDiff: "orchestration.getTurnDiff",
  getFullThreadDiff: "orchestration.getFullThreadDiff",
  replayEvents: "orchestration.replayEvents",
  listProviderDeliveryBlockers: "orchestration.listProviderDeliveryBlockers",
  reconcileProviderDelivery: "orchestration.reconcileProviderDelivery",
  subscribeShell: "orchestration.subscribeShell",
  unsubscribeShell: "orchestration.unsubscribeShell",
  subscribeThread: "orchestration.subscribeThread",
  unsubscribeThread: "orchestration.unsubscribeThread",
  getCapabilities: "orchestration.getCapabilities",
  getWorkspaceShellSnapshot: "orchestration.v2.getShellSnapshot",
  replayWorkspaceEvents: "orchestration.v2.replayEvents",
  subscribeWorkspaceShell: "orchestration.v2.subscribeShell",
  unsubscribeWorkspaceShell: "orchestration.v2.unsubscribeShell",
} as const;

export const ORCHESTRATION_WS_CHANNELS = {
  domainEvent: "orchestration.domainEvent",
  shellEvent: "orchestration.shellEvent",
  threadEvent: "orchestration.threadEvent",
  workspaceShellEvent: "orchestration.v2.shellEvent",
} as const;

export const ProviderKind = Schema.Literals([
  "codex",
  "claudeAgent",
  "cursor",
  "antigravity",
  "grok",
  "droid",
  "kilo",
  "opencode",
  "pi",
]);
export type ProviderKind = typeof ProviderKind.Type;
export const ProviderApprovalPolicy = Schema.Literals([
  "untrusted",
  "on-failure",
  "on-request",
  "never",
]);
export type ProviderApprovalPolicy = typeof ProviderApprovalPolicy.Type;
export const ProviderSandboxMode = Schema.Literals([
  "read-only",
  "workspace-write",
  "danger-full-access",
]);
export type ProviderSandboxMode = typeof ProviderSandboxMode.Type;
export const DEFAULT_PROVIDER_KIND: ProviderKind = "codex";

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

export const AntigravityModelSelection = Schema.Struct({
  provider: Schema.Literal("antigravity"),
  model: TrimmedNonEmptyString,
  options: Schema.optional(AntigravityModelOptions),
});
export type AntigravityModelSelection = typeof AntigravityModelSelection.Type;

export const GrokModelSelection = Schema.Struct({
  provider: Schema.Literal("grok"),
  model: TrimmedNonEmptyString,
  options: Schema.optional(GrokModelOptions),
});
export type GrokModelSelection = typeof GrokModelSelection.Type;

export const DroidModelSelection = Schema.Struct({
  provider: Schema.Literal("droid"),
  model: TrimmedNonEmptyString,
  options: Schema.optional(DroidModelOptions),
});
export type DroidModelSelection = typeof DroidModelSelection.Type;

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
  AntigravityModelSelection,
  GrokModelSelection,
  DroidModelSelection,
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

export const AntigravityProviderStartOptions = Schema.Struct({
  binaryPath: Schema.optional(TrimmedNonEmptyString),
});

export const CursorProviderStartOptions = Schema.Struct({
  binaryPath: Schema.optional(TrimmedNonEmptyString),
  apiEndpoint: Schema.optional(TrimmedNonEmptyString),
});

export const GrokProviderStartOptions = Schema.Struct({
  binaryPath: Schema.optional(TrimmedNonEmptyString),
});

export const DroidProviderStartOptions = Schema.Struct({
  binaryPath: Schema.optional(TrimmedNonEmptyString),
});

export const OpenCodeProviderStartOptions = Schema.Struct({
  binaryPath: Schema.optional(TrimmedNonEmptyString),
  serverUrl: Schema.optional(TrimmedNonEmptyString),
  experimentalWebSockets: Schema.optional(Schema.Boolean),
});

export const KiloProviderStartOptions = Schema.Struct({
  binaryPath: Schema.optional(TrimmedNonEmptyString),
  serverUrl: Schema.optional(TrimmedNonEmptyString),
});

export const PiProviderStartOptions = Schema.Struct({
  binaryPath: Schema.optional(TrimmedNonEmptyString),
  agentDir: Schema.optional(TrimmedNonEmptyString),
});

export const ProviderStartOptions = Schema.Struct({
  codex: Schema.optional(CodexProviderStartOptions),
  claudeAgent: Schema.optional(ClaudeProviderStartOptions),
  cursor: Schema.optional(CursorProviderStartOptions),
  antigravity: Schema.optional(AntigravityProviderStartOptions),
  grok: Schema.optional(GrokProviderStartOptions),
  droid: Schema.optional(DroidProviderStartOptions),
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
// Marks who dispatched a user turn: a person typing, or an automation run.
// Absent is treated as "user"; only automation-dispatched turns carry the flag.
export const MessageDispatchOrigin = Schema.Literals(["user", "automation"]);
export type MessageDispatchOrigin = typeof MessageDispatchOrigin.Type;
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
]);
export type OrchestrationMessageSource = typeof OrchestrationMessageSource.Type;

export const PROVIDER_SEND_TURN_MAX_INPUT_CHARS = 120_000;
export const PROVIDER_SEND_TURN_MAX_ATTACHMENTS = 8;
export const PROVIDER_SEND_TURN_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const PROVIDER_SEND_TURN_MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_PINNED_PROJECTS = 3;
const CHAT_ATTACHMENT_ID_MAX_CHARS = 128;
export const CHAT_ASSISTANT_SELECTION_TEXT_MAX_CHARS = 4_000;
export const THREAD_NOTES_MAX_CHARS = 16_384;
export const PINNED_MESSAGES_MAX_COUNT = 100;
export const PINNED_MESSAGE_LABEL_MAX_CHARS = 60;
export const THREAD_MARKERS_MAX_COUNT = 200;
export const THREAD_MARKER_LABEL_MAX_CHARS = 60;
export const THREAD_MARKER_SELECTED_TEXT_MAX_CHARS = 4_000;
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

export const ChatFileAttachment = Schema.Struct({
  type: Schema.Literal("file"),
  id: ChatAttachmentId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  mimeType: TrimmedNonEmptyString.check(Schema.isMaxLength(100)),
  sizeBytes: NonNegativeInt.check(Schema.isLessThanOrEqualTo(PROVIDER_SEND_TURN_MAX_FILE_BYTES)),
});
export type ChatFileAttachment = typeof ChatFileAttachment.Type;

export const ChatAssistantSelectionAttachment = Schema.Struct({
  type: Schema.Literal("assistant-selection"),
  id: ChatAttachmentId,
  assistantMessageId: MessageId,
  text: TrimmedNonEmptyString.check(Schema.isMaxLength(CHAT_ASSISTANT_SELECTION_TEXT_MAX_CHARS)),
});
export type ChatAssistantSelectionAttachment = typeof ChatAssistantSelectionAttachment.Type;

export const UploadChatAssistantSelectionAttachment = Schema.Struct({
  type: Schema.Literal("assistant-selection"),
  assistantMessageId: MessageId,
  text: TrimmedNonEmptyString.check(Schema.isMaxLength(CHAT_ASSISTANT_SELECTION_TEXT_MAX_CHARS)),
});
export type UploadChatAssistantSelectionAttachment =
  typeof UploadChatAssistantSelectionAttachment.Type;

export const ChatAttachment = Schema.Union([
  ChatImageAttachment,
  ChatFileAttachment,
  ChatAssistantSelectionAttachment,
]);
export type ChatAttachment = typeof ChatAttachment.Type;
const ChatAttachmentList = Schema.Array(ChatAttachment).check(
  Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_ATTACHMENTS),
);
const UploadChatAttachment = Schema.Union([
  ChatImageAttachment,
  ChatFileAttachment,
  UploadChatAssistantSelectionAttachment,
]);
export type UploadChatAttachment = typeof UploadChatAttachment.Type;
const UploadChatAttachmentList = Schema.Array(UploadChatAttachment).check(
  Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_ATTACHMENTS),
);
const TurnMessageContentCheck = Schema.makeFilter(
  (input: { readonly text: string; readonly attachments: ReadonlyArray<unknown> }) =>
    input.text.trim().length > 0 ||
    input.attachments.length > 0 ||
    new SchemaIssue.InvalidValue(Option.some(input.text), {
      message: "Turn input must include text or attachments.",
    }),
  { identifier: "TurnMessageContent" },
);

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
  isPinned: Schema.optional(Schema.Boolean).pipe(Schema.withDecodingDefault(() => false)),
  repositoryIdentity: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  defaultTargetRef: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  githubAccount: Schema.optional(Schema.NullOr(GitHubAccountSelection)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  deletedAt: Schema.NullOr(IsoDateTime),
});
export type OrchestrationProject = typeof OrchestrationProject.Type;

const {
  repositoryIdentity: _projectRepositoryIdentity,
  defaultTargetRef: _projectDefaultTargetRef,
  githubAccount: _projectGithubAccount,
  ...OrchestrationProjectV1Fields
} = OrchestrationProject.fields;
const OrchestrationProjectV1 = Schema.Struct(OrchestrationProjectV1Fields);

export const OrchestrationProjectShell = Schema.Struct({
  id: ProjectId,
  kind: Schema.optional(ProjectKind).pipe(Schema.withDecodingDefault(() => "project")),
  title: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  defaultModelSelection: Schema.NullOr(ModelSelection),
  scripts: Schema.Array(ProjectScript),
  isPinned: Schema.optional(Schema.Boolean).pipe(Schema.withDecodingDefault(() => false)),
  repositoryIdentity: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  defaultTargetRef: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  githubAccount: Schema.optional(Schema.NullOr(GitHubAccountSelection)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type OrchestrationProjectShell = typeof OrchestrationProjectShell.Type;

const {
  repositoryIdentity: _projectShellRepositoryIdentity,
  defaultTargetRef: _projectShellDefaultTargetRef,
  githubAccount: _projectShellGithubAccount,
  ...OrchestrationProjectShellV1Fields
} = OrchestrationProjectShell.fields;
const OrchestrationProjectShellV1 = Schema.Struct(OrchestrationProjectShellV1Fields);

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
  dispatchOrigin: Schema.optional(MessageDispatchOrigin),
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
  // Optional so `last_known_pr_json` rows persisted before these fields existed still
  // decode. Literals stay inline: importing git.ts here would create an import cycle.
  isDraft: Schema.optional(Schema.Boolean),
  mergeability: Schema.optional(Schema.Literals(["mergeable", "conflicting", "unknown"])),
  additions: Schema.optional(Schema.NullOr(NonNegativeInt)),
  deletions: Schema.optional(Schema.NullOr(NonNegativeInt)),
  changedFiles: Schema.optional(Schema.NullOr(NonNegativeInt)),
});
export type OrchestrationThreadPullRequest = typeof OrchestrationThreadPullRequest.Type;

/**
 * A message the user pinned to the chat's sidebar checklist. `label` is an
 * optional user override; when null the UI derives a label from the message
 * text. `done` tracks the checklist "addressed" state. Decoding defaults keep
 * older/partial persisted entries decodable as the shape evolves.
 */
export const ThreadNotes = Schema.String.check(Schema.isMaxLength(THREAD_NOTES_MAX_CHARS));
export type ThreadNotes = typeof ThreadNotes.Type;
export const PinnedMessageLabel = TrimmedNonEmptyString.check(
  Schema.isMaxLength(PINNED_MESSAGE_LABEL_MAX_CHARS),
);
export type PinnedMessageLabel = typeof PinnedMessageLabel.Type;
export const PinnedMessage = Schema.Struct({
  messageId: MessageId,
  label: Schema.optional(Schema.NullOr(PinnedMessageLabel)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  done: Schema.optional(Schema.Boolean).pipe(Schema.withDecodingDefault(() => false)),
  pinnedAt: IsoDateTime,
});
export type PinnedMessage = typeof PinnedMessage.Type;
export const ThreadPinnedMessages = Schema.Array(PinnedMessage).check(
  Schema.isMaxLength(PINNED_MESSAGES_MAX_COUNT),
);
export type ThreadPinnedMessages = typeof ThreadPinnedMessages.Type;
export const ThreadMarkerStyle = Schema.Literals(["highlight", "underline"]);
export type ThreadMarkerStyle = typeof ThreadMarkerStyle.Type;
export const ThreadMarkerColor = Schema.Literals(["yellow", "blue", "green", "pink"]);
export type ThreadMarkerColor = typeof ThreadMarkerColor.Type;
export const ThreadMarkerLabel = TrimmedNonEmptyString.check(
  Schema.isMaxLength(THREAD_MARKER_LABEL_MAX_CHARS),
);
export type ThreadMarkerLabel = typeof ThreadMarkerLabel.Type;
export const ThreadMarker = Schema.Struct({
  id: ThreadMarkerId,
  messageId: MessageId,
  startOffset: NonNegativeInt,
  endOffset: NonNegativeInt,
  selectedText: TrimmedNonEmptyString.check(
    Schema.isMaxLength(THREAD_MARKER_SELECTED_TEXT_MAX_CHARS),
  ),
  style: ThreadMarkerStyle,
  color: ThreadMarkerColor,
  label: Schema.optional(Schema.NullOr(ThreadMarkerLabel)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  done: Schema.optional(Schema.Boolean).pipe(Schema.withDecodingDefault(() => false)),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ThreadMarker = typeof ThreadMarker.Type;
export const ThreadMarkers = Schema.Array(ThreadMarker).check(
  Schema.isMaxLength(THREAD_MARKERS_MAX_COUNT),
);
export type ThreadMarkers = typeof ThreadMarkers.Type;

export const WorktreeWorkspaceKind = Schema.Literals(["managed", "repository-root", "external"]);
export type WorktreeWorkspaceKind = typeof WorktreeWorkspaceKind.Type;

export const WorktreeWorkspaceState = Schema.Literals([
  "provisioning",
  "ready",
  "setup-failed",
  "missing",
  "archiving",
  "archived",
  "error",
]);
export type WorktreeWorkspaceState = typeof WorktreeWorkspaceState.Type;

export const WorktreeWorkspaceSetupStatus = Schema.Literals([
  "pending",
  "running",
  "succeeded",
  "failed",
  "skipped",
]);
export type WorktreeWorkspaceSetupStatus = typeof WorktreeWorkspaceSetupStatus.Type;

export const WorktreeWorkspaceSourceKind = Schema.Literals([
  "new-branch",
  "branch",
  "pull-request",
  "imported",
]);
export type WorktreeWorkspaceSourceKind = typeof WorktreeWorkspaceSourceKind.Type;

export const WorktreeWorkspaceOperationKind = Schema.Literals([
  "provision",
  "setup",
  "archive",
  "restore",
  "repair",
]);
export type WorktreeWorkspaceOperationKind = typeof WorktreeWorkspaceOperationKind.Type;

export const WorktreeWorkspaceActiveOperation = Schema.Struct({
  id: WorkspaceOperationId,
  generation: NonNegativeInt,
  kind: WorktreeWorkspaceOperationKind,
  stage: TrimmedNonEmptyString,
  startedAt: IsoDateTime,
});
export type WorktreeWorkspaceActiveOperation = typeof WorktreeWorkspaceActiveOperation.Type;

export const WorktreeWorkspaceFailure = Schema.Struct({
  generation: NonNegativeInt,
  kind: WorktreeWorkspaceOperationKind,
  stage: TrimmedNonEmptyString,
  summary: TrimmedNonEmptyString,
  logId: Schema.NullOr(TrimmedNonEmptyString),
});
export type WorktreeWorkspaceFailure = typeof WorktreeWorkspaceFailure.Type;

export const OrchestrationWorktreeWorkspace = Schema.Struct({
  id: WorktreeWorkspaceId,
  projectId: ProjectId,
  repositoryIdentity: Schema.NullOr(TrimmedNonEmptyString),
  kind: WorktreeWorkspaceKind,
  state: WorktreeWorkspaceState,
  title: TrimmedNonEmptyString,
  path: Schema.NullOr(TrimmedNonEmptyString),
  branch: Schema.NullOr(TrimmedNonEmptyString),
  headRef: Schema.NullOr(TrimmedNonEmptyString),
  targetRef: TrimmedNonEmptyString,
  targetResolvedCommit: Schema.NullOr(TrimmedNonEmptyString),
  createdFromCommit: Schema.NullOr(TrimmedNonEmptyString),
  sourceKind: WorktreeWorkspaceSourceKind,
  sourceRef: Schema.NullOr(TrimmedNonEmptyString),
  setupStatus: WorktreeWorkspaceSetupStatus,
  setupError: Schema.NullOr(TrimmedNonEmptyString),
  setupLogId: Schema.NullOr(TrimmedNonEmptyString),
  lastKnownPr: Schema.NullOr(OrchestrationThreadPullRequest),
  isPinned: Schema.Boolean,
  lifecycleGeneration: NonNegativeInt,
  activeOperation: Schema.NullOr(WorktreeWorkspaceActiveOperation),
  lastFailure: Schema.NullOr(WorktreeWorkspaceFailure),
  mutationRevision: NonNegativeInt,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  archivedAt: Schema.NullOr(IsoDateTime),
  deletedAt: Schema.NullOr(IsoDateTime),
});
export type OrchestrationWorktreeWorkspace = typeof OrchestrationWorktreeWorkspace.Type;

export const ProjectionPendingInteractionKind = Schema.Literals(["approval", "userInput"]);
export type ProjectionPendingInteractionKind = typeof ProjectionPendingInteractionKind.Type;

export const ProjectionPendingInteractionStatus = Schema.Literals([
  "pending",
  "responding",
  "confirmed",
  "retryable",
  "uncertain",
]);
export type ProjectionPendingInteractionStatus = typeof ProjectionPendingInteractionStatus.Type;

export const ProjectionPendingInteractionDecision = Schema.NullOr(ProviderApprovalDecision);
export type ProjectionPendingInteractionDecision = typeof ProjectionPendingInteractionDecision.Type;

/** Unresolved provider interaction settlement exposed to thread-detail consumers. */
export const OrchestrationPendingInteraction = Schema.Struct({
  interactionKind: ProjectionPendingInteractionKind,
  requestId: ApprovalRequestId,
  threadId: ThreadId,
  turnId: Schema.NullOr(TurnId),
  lifecycleGeneration: Schema.NullOr(TrimmedNonEmptyString),
  status: ProjectionPendingInteractionStatus,
  decision: ProjectionPendingInteractionDecision,
  responseCommandId: Schema.NullOr(CommandId),
  responseRequestedAt: Schema.NullOr(IsoDateTime),
  createdAt: IsoDateTime,
  resolvedAt: Schema.NullOr(IsoDateTime),
});
export type OrchestrationPendingInteraction = typeof OrchestrationPendingInteraction.Type;

export const OrchestrationThread = Schema.Struct({
  id: ThreadId,
  projectId: ProjectId,
  workspaceId: Schema.optional(Schema.NullOr(WorktreeWorkspaceId)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
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
  pinnedMessages: Schema.optional(ThreadPinnedMessages),
  threadMarkers: Schema.optional(ThreadMarkers),
  notes: Schema.optional(ThreadNotes),
  messages: Schema.Array(OrchestrationMessage),
  proposedPlans: Schema.Array(OrchestrationProposedPlan).pipe(Schema.withDecodingDefault(() => [])),
  activities: Schema.Array(OrchestrationThreadActivity),
  pendingInteractions: Schema.optional(Schema.Array(OrchestrationPendingInteraction)),
  checkpoints: Schema.Array(OrchestrationCheckpointSummary),
  session: Schema.NullOr(OrchestrationSession),
});
export type OrchestrationThread = typeof OrchestrationThread.Type;

const { workspaceId: _threadWorkspaceId, ...OrchestrationThreadV1Fields } =
  OrchestrationThread.fields;
const OrchestrationThreadV1 = Schema.Struct(OrchestrationThreadV1Fields);

export const OrchestrationThreadShell = Schema.Struct({
  id: ThreadId,
  projectId: ProjectId,
  workspaceId: Schema.optional(Schema.NullOr(WorktreeWorkspaceId)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
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

const { workspaceId: _threadShellWorkspaceId, ...OrchestrationThreadShellV1Fields } =
  OrchestrationThreadShell.fields;
const OrchestrationThreadShellV1 = Schema.Struct(OrchestrationThreadShellV1Fields);

export const OrchestrationReadModel = Schema.Struct({
  snapshotSequence: NonNegativeInt,
  projects: Schema.Array(OrchestrationProject),
  workspaces: Schema.optional(Schema.Array(OrchestrationWorktreeWorkspace)).pipe(
    Schema.withDecodingDefault(() => []),
  ),
  threads: Schema.Array(OrchestrationThread),
  updatedAt: IsoDateTime,
});
export type OrchestrationReadModel = typeof OrchestrationReadModel.Type;

const OrchestrationReadModelV1 = Schema.Struct({
  snapshotSequence: NonNegativeInt,
  projects: Schema.Array(OrchestrationProjectV1),
  threads: Schema.Array(OrchestrationThreadV1),
  updatedAt: IsoDateTime,
});

export const OrchestrationShellSnapshot = Schema.Struct({
  snapshotSequence: NonNegativeInt,
  projects: Schema.Array(OrchestrationProjectShellV1),
  threads: Schema.Array(OrchestrationThreadShellV1),
  updatedAt: IsoDateTime,
});
export type OrchestrationShellSnapshot = typeof OrchestrationShellSnapshot.Type;

export const OrchestrationWorkspaceShellSnapshot = Schema.Struct({
  protocolVersion: Schema.Literal(2),
  snapshotSequence: NonNegativeInt,
  projects: Schema.Array(OrchestrationProjectShell),
  workspaces: Schema.Array(OrchestrationWorktreeWorkspace),
  threads: Schema.Array(OrchestrationThreadShell),
  updatedAt: IsoDateTime,
});
export type OrchestrationWorkspaceShellSnapshot = typeof OrchestrationWorkspaceShellSnapshot.Type;

export const OrchestrationShellStreamEvent = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("project-upserted"),
    sequence: NonNegativeInt,
    project: OrchestrationProjectShellV1,
  }),
  Schema.Struct({
    kind: Schema.Literal("project-removed"),
    sequence: NonNegativeInt,
    projectId: ProjectId,
  }),
  Schema.Struct({
    kind: Schema.Literal("thread-upserted"),
    sequence: NonNegativeInt,
    thread: OrchestrationThreadShellV1,
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

export const OrchestrationWorkspaceShellStreamEvent = Schema.Union([
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
  Schema.Struct({
    kind: Schema.Literal("workspace-upserted"),
    sequence: NonNegativeInt,
    workspace: OrchestrationWorktreeWorkspace,
  }),
  Schema.Struct({
    kind: Schema.Literal("workspace-removed"),
    sequence: NonNegativeInt,
    workspaceId: WorktreeWorkspaceId,
  }),
]);
export type OrchestrationWorkspaceShellStreamEvent =
  typeof OrchestrationWorkspaceShellStreamEvent.Type;

export const OrchestrationWorkspaceShellStreamItem = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("snapshot"),
    snapshot: OrchestrationWorkspaceShellSnapshot,
  }),
  OrchestrationWorkspaceShellStreamEvent,
]);
export type OrchestrationWorkspaceShellStreamItem =
  typeof OrchestrationWorkspaceShellStreamItem.Type;

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
  isPinned: Schema.optional(Schema.Boolean).pipe(Schema.withDecodingDefault(() => false)),
  repositoryIdentity: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  defaultTargetRef: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  githubAccount: Schema.optional(Schema.NullOr(GitHubAccountSelection)),
  createdAt: IsoDateTime,
});

const ProjectMetaUpdateCommand = Schema.Struct({
  type: Schema.Literal("project.meta.update"),
  commandId: CommandId,
  projectId: ProjectId,
  kind: Schema.optional(ProjectKind),
  title: Schema.optional(TrimmedNonEmptyString),
  workspaceRoot: Schema.optional(TrimmedNonEmptyString),
  createWorkspaceRootIfMissing: Schema.optional(Schema.Boolean).pipe(
    Schema.withDecodingDefault(() => false),
  ),
  defaultModelSelection: Schema.optional(Schema.NullOr(ModelSelection)),
  scripts: Schema.optional(Schema.Array(ProjectScript)),
  isPinned: Schema.optional(Schema.Boolean),
  repositoryIdentity: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  defaultTargetRef: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  githubAccount: Schema.optional(Schema.NullOr(GitHubAccountSelection)),
});

const ProjectDeleteCommand = Schema.Struct({
  type: Schema.Literal("project.delete"),
  commandId: CommandId,
  projectId: ProjectId,
});

export const WorktreeWorkspaceCreateCommand = Schema.Struct({
  type: Schema.Literal("workspace.create"),
  commandId: CommandId,
  workspaceId: WorktreeWorkspaceId,
  threadId: ThreadId,
  projectId: ProjectId,
  operationId: WorkspaceOperationId,
  title: TrimmedNonEmptyString,
  targetRef: TrimmedNonEmptyString,
  branch: Schema.optional(TrimmedNonEmptyString),
  sourceKind: Schema.optional(Schema.Literals(["new-branch", "branch", "pull-request"])),
  sourceRef: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  lastKnownPr: Schema.optional(OrchestrationThreadPullRequest),
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(() => DEFAULT_PROVIDER_INTERACTION_MODE),
  ),
  createdAt: IsoDateTime,
});

export const WorktreeWorkspaceAttachCommand = Schema.Struct({
  type: Schema.Literal("workspace.attach"),
  commandId: CommandId,
  workspaceId: WorktreeWorkspaceId,
  threadId: ThreadId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  path: TrimmedNonEmptyString,
  branch: TrimmedNonEmptyString,
  headRef: Schema.NullOr(TrimmedNonEmptyString),
  targetRef: TrimmedNonEmptyString,
  sourceKind: Schema.Literals(["branch", "pull-request", "imported"]),
  sourceRef: TrimmedNonEmptyString,
  lastKnownPr: Schema.optional(Schema.NullOr(OrchestrationThreadPullRequest)),
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(() => DEFAULT_PROVIDER_INTERACTION_MODE),
  ),
  createdAt: IsoDateTime,
});

export const WorktreeWorkspaceConversationCreateCommand = Schema.Struct({
  type: Schema.Literal("workspace.conversation.create"),
  commandId: CommandId,
  workspaceId: WorktreeWorkspaceId,
  threadId: ThreadId,
  title: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode.pipe(
    Schema.withDecodingDefault(() => DEFAULT_PROVIDER_INTERACTION_MODE),
  ),
  createdAt: IsoDateTime,
});

export const WorktreeWorkspaceMetaUpdateCommand = Schema.Struct({
  type: Schema.Literal("workspace.meta.update"),
  commandId: CommandId,
  workspaceId: WorktreeWorkspaceId,
  title: Schema.optional(TrimmedNonEmptyString),
  branch: Schema.optional(TrimmedNonEmptyString),
  targetRef: Schema.optional(TrimmedNonEmptyString),
  lastKnownPr: Schema.optional(Schema.NullOr(OrchestrationThreadPullRequest)),
  isPinned: Schema.optional(Schema.Boolean),
  updatedAt: IsoDateTime,
});

export const WorktreeWorkspaceArchiveRequestCommand = Schema.Struct({
  type: Schema.Literal("workspace.archive.request"),
  commandId: CommandId,
  workspaceId: WorktreeWorkspaceId,
  operationId: WorkspaceOperationId,
  expectedGeneration: NonNegativeInt,
  confirmedWarnings: Schema.optional(Schema.Boolean).pipe(Schema.withDecodingDefault(() => false)),
  requestedAt: IsoDateTime,
});

export const WorktreeWorkspaceProvisionRequestCommand = Schema.Struct({
  type: Schema.Literal("workspace.provision.request"),
  commandId: CommandId,
  workspaceId: WorktreeWorkspaceId,
  operationId: WorkspaceOperationId,
  expectedGeneration: NonNegativeInt,
  requestedAt: IsoDateTime,
});

export const WorktreeWorkspaceRestoreRequestCommand = Schema.Struct({
  type: Schema.Literal("workspace.restore.request"),
  commandId: CommandId,
  workspaceId: WorktreeWorkspaceId,
  operationId: WorkspaceOperationId,
  expectedGeneration: NonNegativeInt,
  requestedAt: IsoDateTime,
});

const ThreadCreateCommand = Schema.Struct({
  type: Schema.Literal("thread.create"),
  commandId: CommandId,
  threadId: ThreadId,
  projectId: ProjectId,
  workspaceId: Schema.optional(Schema.NullOr(WorktreeWorkspaceId)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
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
  workspaceId: Schema.optional(Schema.NullOr(WorktreeWorkspaceId)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
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
  importedMessages: Schema.Array(ThreadHandoffImportedMessage),
  createdAt: IsoDateTime,
});

const ThreadForkCreateCommand = Schema.Struct({
  type: Schema.Literal("thread.fork.create"),
  commandId: CommandId,
  threadId: ThreadId,
  sourceThreadId: ThreadId,
  projectId: ProjectId,
  workspaceId: Schema.optional(Schema.NullOr(WorktreeWorkspaceId)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
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
  pinnedMessages: Schema.optional(ThreadPinnedMessages),
  threadMarkers: Schema.optional(ThreadMarkers),
  notes: Schema.optional(ThreadNotes),
});

const ThreadPinnedMessageAddCommand = Schema.Struct({
  type: Schema.Literal("thread.pinned-message.add"),
  commandId: CommandId,
  threadId: ThreadId,
  messageId: MessageId,
});

const ThreadPinnedMessageRemoveCommand = Schema.Struct({
  type: Schema.Literal("thread.pinned-message.remove"),
  commandId: CommandId,
  threadId: ThreadId,
  messageId: MessageId,
});

const ThreadPinnedMessageDoneSetCommand = Schema.Struct({
  type: Schema.Literal("thread.pinned-message.done.set"),
  commandId: CommandId,
  threadId: ThreadId,
  messageId: MessageId,
  done: Schema.Boolean,
});

const ThreadPinnedMessageLabelSetCommand = Schema.Struct({
  type: Schema.Literal("thread.pinned-message.label.set"),
  commandId: CommandId,
  threadId: ThreadId,
  messageId: MessageId,
  label: Schema.NullOr(PinnedMessageLabel),
});

const ThreadMarkerAddCommand = Schema.Struct({
  type: Schema.Literal("thread.marker.add"),
  commandId: CommandId,
  threadId: ThreadId,
  markerId: ThreadMarkerId,
  messageId: MessageId,
  startOffset: NonNegativeInt,
  endOffset: NonNegativeInt,
  selectedText: TrimmedNonEmptyString.check(
    Schema.isMaxLength(THREAD_MARKER_SELECTED_TEXT_MAX_CHARS),
  ),
  style: ThreadMarkerStyle,
  color: ThreadMarkerColor,
});

const ThreadMarkerRemoveCommand = Schema.Struct({
  type: Schema.Literal("thread.marker.remove"),
  commandId: CommandId,
  threadId: ThreadId,
  markerId: ThreadMarkerId,
});

const ThreadMarkerDoneSetCommand = Schema.Struct({
  type: Schema.Literal("thread.marker.done.set"),
  commandId: CommandId,
  threadId: ThreadId,
  markerId: ThreadMarkerId,
  done: Schema.Boolean,
});

const ThreadMarkerLabelSetCommand = Schema.Struct({
  type: Schema.Literal("thread.marker.label.set"),
  commandId: CommandId,
  threadId: ThreadId,
  markerId: ThreadMarkerId,
  label: Schema.NullOr(ThreadMarkerLabel),
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
    text: Schema.String.check(Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_INPUT_CHARS)),
    attachments: ChatAttachmentList,
    skills: Schema.optional(Schema.Array(ProviderSkillReference)),
    mentions: Schema.optional(Schema.Array(ProviderMentionReference)),
  }).check(TurnMessageContentCheck),
  modelSelection: Schema.optional(ModelSelection),
  providerOptions: Schema.optional(ProviderStartOptions),
  reviewTarget: Schema.optional(ProviderReviewTarget),
  assistantDeliveryMode: Schema.optional(AssistantDeliveryMode),
  dispatchMode: Schema.optional(TurnDispatchMode).pipe(
    Schema.withDecodingDefault(() => DEFAULT_TURN_DISPATCH_MODE),
  ),
  // Set by the automation engine when it dispatches a turn. Clients cannot set it:
  // ClientThreadTurnStartCommand omits the field, so decoding strips any spoofed value.
  dispatchOrigin: Schema.optional(MessageDispatchOrigin),
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
    text: Schema.String.check(Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_INPUT_CHARS)),
    attachments: UploadChatAttachmentList,
    skills: Schema.optional(Schema.Array(ProviderSkillReference)),
    mentions: Schema.optional(Schema.Array(ProviderMentionReference)),
  }).check(TurnMessageContentCheck),
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

const ThreadTaskStopCommand = Schema.Struct({
  type: Schema.Literal("thread.task.stop"),
  commandId: CommandId,
  threadId: ThreadId,
  taskId: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
});

const ThreadTaskBackgroundCommand = Schema.Struct({
  type: Schema.Literal("thread.task.background"),
  commandId: CommandId,
  threadId: ThreadId,
  toolUseId: TrimmedNonEmptyString,
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
  lifecycleGeneration: Schema.optional(TrimmedNonEmptyString),
  decision: ProviderApprovalDecision,
  createdAt: IsoDateTime,
});

const ThreadUserInputRespondCommand = Schema.Struct({
  type: Schema.Literal("thread.user-input.respond"),
  commandId: CommandId,
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  lifecycleGeneration: Schema.optional(TrimmedNonEmptyString),
  answers: ProviderUserInputAnswers,
  createdAt: IsoDateTime,
});

const ThreadCheckpointRevertCommand = Schema.Struct({
  type: Schema.Literal("thread.checkpoint.revert"),
  commandId: CommandId,
  threadId: ThreadId,
  turnCount: NonNegativeInt,
  scope: Schema.optional(Schema.Literals(["thread", "files"])),
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
  WorktreeWorkspaceCreateCommand,
  WorktreeWorkspaceAttachCommand,
  WorktreeWorkspaceConversationCreateCommand,
  WorktreeWorkspaceMetaUpdateCommand,
  WorktreeWorkspaceProvisionRequestCommand,
  WorktreeWorkspaceArchiveRequestCommand,
  WorktreeWorkspaceRestoreRequestCommand,
  ThreadCreateCommand,
  ThreadHandoffCreateCommand,
  ThreadForkCreateCommand,
  ThreadDeleteCommand,
  ThreadArchiveCommand,
  ThreadUnarchiveCommand,
  ThreadMetaUpdateCommand,
  ThreadPinnedMessageAddCommand,
  ThreadPinnedMessageRemoveCommand,
  ThreadPinnedMessageDoneSetCommand,
  ThreadPinnedMessageLabelSetCommand,
  ThreadMarkerAddCommand,
  ThreadMarkerRemoveCommand,
  ThreadMarkerDoneSetCommand,
  ThreadMarkerLabelSetCommand,
  ThreadRuntimeModeSetCommand,
  ThreadInteractionModeSetCommand,
  ThreadTurnStartCommand,
  ThreadTurnInterruptCommand,
  ThreadTaskStopCommand,
  ThreadTaskBackgroundCommand,
  ThreadApprovalRespondCommand,
  ThreadUserInputRespondCommand,
  ThreadCheckpointRevertCommand,
  ThreadMessageEditAndResendCommand,
  ThreadActivityAppendCommand,
  ThreadSessionStopCommand,
]);
export type DispatchableClientOrchestrationCommand =
  typeof DispatchableClientOrchestrationCommand.Type;

export const ClientOrchestrationCommand = Schema.Union([
  ProjectCreateCommand,
  ProjectMetaUpdateCommand,
  ProjectDeleteCommand,
  WorktreeWorkspaceCreateCommand,
  WorktreeWorkspaceAttachCommand,
  WorktreeWorkspaceConversationCreateCommand,
  WorktreeWorkspaceMetaUpdateCommand,
  WorktreeWorkspaceProvisionRequestCommand,
  WorktreeWorkspaceArchiveRequestCommand,
  WorktreeWorkspaceRestoreRequestCommand,
  ThreadCreateCommand,
  ThreadHandoffCreateCommand,
  ThreadForkCreateCommand,
  ThreadDeleteCommand,
  ThreadArchiveCommand,
  ThreadUnarchiveCommand,
  ThreadMetaUpdateCommand,
  ThreadPinnedMessageAddCommand,
  ThreadPinnedMessageRemoveCommand,
  ThreadPinnedMessageDoneSetCommand,
  ThreadPinnedMessageLabelSetCommand,
  ThreadMarkerAddCommand,
  ThreadMarkerRemoveCommand,
  ThreadMarkerDoneSetCommand,
  ThreadMarkerLabelSetCommand,
  ThreadRuntimeModeSetCommand,
  ThreadInteractionModeSetCommand,
  ClientThreadTurnStartCommand,
  ThreadTurnInterruptCommand,
  ThreadTaskStopCommand,
  ThreadTaskBackgroundCommand,
  ThreadApprovalRespondCommand,
  ThreadUserInputRespondCommand,
  ThreadCheckpointRevertCommand,
  ThreadMessageEditAndResendCommand,
  ThreadActivityAppendCommand,
  ThreadSessionStopCommand,
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
  preserveLatestTurn: Schema.optional(Schema.Boolean),
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

export const WorktreeWorkspaceImportLegacyCommand = Schema.Struct({
  type: Schema.Literal("workspace.import-legacy"),
  commandId: CommandId,
  workspaceId: WorktreeWorkspaceId,
  projectId: ProjectId,
  repositoryIdentity: Schema.NullOr(TrimmedNonEmptyString),
  kind: WorktreeWorkspaceKind,
  state: WorktreeWorkspaceState,
  title: TrimmedNonEmptyString,
  path: Schema.NullOr(TrimmedNonEmptyString),
  branch: Schema.NullOr(TrimmedNonEmptyString),
  headRef: Schema.NullOr(TrimmedNonEmptyString),
  targetRef: TrimmedNonEmptyString,
  targetResolvedCommit: Schema.NullOr(TrimmedNonEmptyString),
  createdFromCommit: Schema.NullOr(TrimmedNonEmptyString),
  setupStatus: WorktreeWorkspaceSetupStatus,
  createdAt: IsoDateTime,
});

export const ThreadWorkspaceAssignCommand = Schema.Struct({
  type: Schema.Literal("thread.workspace.assign"),
  commandId: CommandId,
  threadId: ThreadId,
  workspaceId: WorktreeWorkspaceId,
  updatedAt: IsoDateTime,
});

export const WorktreeWorkspaceProvisionCompleteCommand = Schema.Struct({
  type: Schema.Literal("workspace.provision.complete"),
  commandId: CommandId,
  workspaceId: WorktreeWorkspaceId,
  operationId: WorkspaceOperationId,
  generation: NonNegativeInt,
  path: TrimmedNonEmptyString,
  branch: TrimmedNonEmptyString,
  headRef: TrimmedNonEmptyString,
  targetResolvedCommit: TrimmedNonEmptyString,
  createdFromCommit: TrimmedNonEmptyString,
  targetRef: Schema.optional(TrimmedNonEmptyString),
  lastKnownPr: Schema.optional(OrchestrationThreadPullRequest),
  setupStatus: Schema.Literals(["succeeded", "skipped"]),
  completedAt: IsoDateTime,
});

export const WorktreeWorkspaceArchiveCompleteCommand = Schema.Struct({
  type: Schema.Literal("workspace.archive.complete"),
  commandId: CommandId,
  workspaceId: WorktreeWorkspaceId,
  operationId: WorkspaceOperationId,
  generation: NonNegativeInt,
  completedAt: IsoDateTime,
});

export const WorktreeWorkspaceRestoreCompleteCommand = Schema.Struct({
  type: Schema.Literal("workspace.restore.complete"),
  commandId: CommandId,
  workspaceId: WorktreeWorkspaceId,
  operationId: WorkspaceOperationId,
  generation: NonNegativeInt,
  path: TrimmedNonEmptyString,
  branch: TrimmedNonEmptyString,
  headRef: TrimmedNonEmptyString,
  setupStatus: Schema.Literals(["succeeded", "skipped"]),
  completedAt: IsoDateTime,
});

export const WorktreeWorkspaceOperationFailCommand = Schema.Struct({
  type: Schema.Literal("workspace.operation.fail"),
  commandId: CommandId,
  workspaceId: WorktreeWorkspaceId,
  operationId: WorkspaceOperationId,
  generation: NonNegativeInt,
  kind: WorktreeWorkspaceOperationKind,
  stage: TrimmedNonEmptyString,
  summary: TrimmedNonEmptyString,
  logId: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  path: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  branch: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  headRef: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  targetResolvedCommit: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  createdFromCommit: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  failedAt: IsoDateTime,
});

const InternalOrchestrationCommand = Schema.Union([
  WorktreeWorkspaceImportLegacyCommand,
  ThreadWorkspaceAssignCommand,
  WorktreeWorkspaceProvisionCompleteCommand,
  WorktreeWorkspaceArchiveCompleteCommand,
  WorktreeWorkspaceRestoreCompleteCommand,
  WorktreeWorkspaceOperationFailCommand,
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
  "workspace.created",
  "workspace.meta-updated",
  "workspace.provision-requested",
  "workspace.archive-requested",
  "workspace.archived",
  "workspace.restore-requested",
  "workspace.restored",
  "workspace.ready",
  "workspace.operation-failed",
  "thread.created",
  "thread.workspace-assigned",
  "thread.deleted",
  // Legacy desktop installs can still contain these rows in orchestration_events.
  "thread.archived",
  "thread.unarchived",
  "thread.meta-updated",
  "thread.pinned-message-added",
  "thread.pinned-message-removed",
  "thread.pinned-message-done-set",
  "thread.pinned-message-label-set",
  "thread.marker-added",
  "thread.marker-removed",
  "thread.marker-done-set",
  "thread.marker-label-set",
  "thread.runtime-mode-set",
  "thread.interaction-mode-set",
  "thread.message-sent",
  "thread.turn-queued",
  "thread.turn-start-requested",
  "thread.turn-interrupt-requested",
  "thread.task-stop-requested",
  "thread.task-background-requested",
  "thread.approval-response-requested",
  "thread.user-input-response-requested",
  "thread.checkpoint-revert-requested",
  "thread.reverted",
  "thread.conversation-rollback-requested",
  "thread.conversation-rolled-back",
  "thread.message-edit-resend-requested",
  "thread.session-stop-requested",
  "thread.session-set",
  "thread.proposed-plan-upserted",
  "thread.turn-diff-completed",
  "thread.activity-appended",
]);
export type OrchestrationEventType = typeof OrchestrationEventType.Type;

export const OrchestrationAggregateKind = Schema.Literals(["project", "workspace", "thread"]);
export type OrchestrationAggregateKind = typeof OrchestrationAggregateKind.Type;
export const OrchestrationActorKind = Schema.Literals(["client", "server", "provider"]);

export const ProjectCreatedPayload = Schema.Struct({
  projectId: ProjectId,
  kind: Schema.optional(ProjectKind).pipe(Schema.withDecodingDefault(() => "project")),
  title: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  defaultModelSelection: Schema.NullOr(ModelSelection),
  scripts: Schema.Array(ProjectScript),
  isPinned: Schema.optional(Schema.Boolean).pipe(Schema.withDecodingDefault(() => false)),
  repositoryIdentity: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  defaultTargetRef: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
  githubAccount: Schema.optional(Schema.NullOr(GitHubAccountSelection)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
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
  isPinned: Schema.optional(Schema.Boolean),
  repositoryIdentity: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  defaultTargetRef: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  githubAccount: Schema.optional(Schema.NullOr(GitHubAccountSelection)),
  updatedAt: IsoDateTime,
});

export const ProjectDeletedPayload = Schema.Struct({
  projectId: ProjectId,
  deletedAt: IsoDateTime,
});

export const WorktreeWorkspaceCreatedPayload = Schema.Struct({
  workspaceId: WorktreeWorkspaceId,
  projectId: ProjectId,
  repositoryIdentity: Schema.NullOr(TrimmedNonEmptyString),
  kind: WorktreeWorkspaceKind,
  state: WorktreeWorkspaceState,
  title: TrimmedNonEmptyString,
  path: Schema.NullOr(TrimmedNonEmptyString),
  branch: Schema.NullOr(TrimmedNonEmptyString),
  headRef: Schema.NullOr(TrimmedNonEmptyString),
  targetRef: TrimmedNonEmptyString,
  targetResolvedCommit: Schema.NullOr(TrimmedNonEmptyString),
  createdFromCommit: Schema.NullOr(TrimmedNonEmptyString),
  sourceKind: WorktreeWorkspaceSourceKind,
  sourceRef: Schema.NullOr(TrimmedNonEmptyString),
  setupStatus: WorktreeWorkspaceSetupStatus,
  setupError: Schema.NullOr(TrimmedNonEmptyString),
  setupLogId: Schema.NullOr(TrimmedNonEmptyString),
  lastKnownPr: Schema.NullOr(OrchestrationThreadPullRequest),
  isPinned: Schema.Boolean,
  lifecycleGeneration: NonNegativeInt,
  activeOperation: Schema.NullOr(WorktreeWorkspaceActiveOperation),
  lastFailure: Schema.NullOr(WorktreeWorkspaceFailure),
  mutationRevision: NonNegativeInt,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  archivedAt: Schema.NullOr(IsoDateTime),
  deletedAt: Schema.NullOr(IsoDateTime),
});

export const WorktreeWorkspaceReadyPayload = Schema.Struct({
  workspaceId: WorktreeWorkspaceId,
  operationId: WorkspaceOperationId,
  generation: NonNegativeInt,
  path: TrimmedNonEmptyString,
  branch: TrimmedNonEmptyString,
  headRef: TrimmedNonEmptyString,
  targetResolvedCommit: TrimmedNonEmptyString,
  createdFromCommit: TrimmedNonEmptyString,
  setupStatus: Schema.Literals(["succeeded", "skipped"]),
  completedAt: IsoDateTime,
});

export const WorktreeWorkspaceMetaUpdatedPayload = Schema.Struct({
  workspaceId: WorktreeWorkspaceId,
  title: Schema.optional(TrimmedNonEmptyString),
  branch: Schema.optional(TrimmedNonEmptyString),
  targetRef: Schema.optional(TrimmedNonEmptyString),
  lastKnownPr: Schema.optional(Schema.NullOr(OrchestrationThreadPullRequest)),
  isPinned: Schema.optional(Schema.Boolean),
  mutationRevision: NonNegativeInt,
  updatedAt: IsoDateTime,
});

export const WorktreeWorkspaceLifecycleRequestedPayload = Schema.Struct({
  workspaceId: WorktreeWorkspaceId,
  operationId: WorkspaceOperationId,
  generation: NonNegativeInt,
  confirmedWarnings: Schema.optional(Schema.Boolean),
  requestedAt: IsoDateTime,
});

export const WorktreeWorkspaceArchivedPayload = Schema.Struct({
  workspaceId: WorktreeWorkspaceId,
  operationId: WorkspaceOperationId,
  generation: NonNegativeInt,
  archivedAt: IsoDateTime,
});

export const WorktreeWorkspaceRestoredPayload = Schema.Struct({
  workspaceId: WorktreeWorkspaceId,
  operationId: WorkspaceOperationId,
  generation: NonNegativeInt,
  path: TrimmedNonEmptyString,
  branch: TrimmedNonEmptyString,
  headRef: TrimmedNonEmptyString,
  setupStatus: Schema.Literals(["succeeded", "skipped"]),
  completedAt: IsoDateTime,
});

export const WorktreeWorkspaceOperationFailedPayload = Schema.Struct({
  workspaceId: WorktreeWorkspaceId,
  operationId: WorkspaceOperationId,
  generation: NonNegativeInt,
  kind: WorktreeWorkspaceOperationKind,
  stage: TrimmedNonEmptyString,
  summary: TrimmedNonEmptyString,
  logId: Schema.NullOr(TrimmedNonEmptyString),
  path: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  branch: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  headRef: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  targetResolvedCommit: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  createdFromCommit: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  failedAt: IsoDateTime,
});

export const ThreadWorkspaceAssignedPayload = Schema.Struct({
  threadId: ThreadId,
  workspaceId: WorktreeWorkspaceId,
  projectId: ProjectId,
  envMode: ThreadEnvironmentMode,
  branch: Schema.NullOr(TrimmedNonEmptyString),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  updatedAt: IsoDateTime,
});

export const ThreadCreatedPayload = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  workspaceId: Schema.optional(Schema.NullOr(WorktreeWorkspaceId)).pipe(
    Schema.withDecodingDefault(() => null),
  ),
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
  pinnedMessages: Schema.optional(ThreadPinnedMessages),
  threadMarkers: Schema.optional(ThreadMarkers),
  notes: Schema.optional(ThreadNotes),
  updatedAt: IsoDateTime,
});

export const ThreadPinnedMessageAddedPayload = Schema.Struct({
  threadId: ThreadId,
  pin: PinnedMessage,
  updatedAt: IsoDateTime,
});

export const ThreadPinnedMessageRemovedPayload = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  updatedAt: IsoDateTime,
});

export const ThreadPinnedMessageDoneSetPayload = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  done: Schema.Boolean,
  updatedAt: IsoDateTime,
});

export const ThreadPinnedMessageLabelSetPayload = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  label: Schema.NullOr(PinnedMessageLabel),
  updatedAt: IsoDateTime,
});

export const ThreadMarkerAddedPayload = Schema.Struct({
  threadId: ThreadId,
  marker: ThreadMarker,
  updatedAt: IsoDateTime,
});

export const ThreadMarkerRemovedPayload = Schema.Struct({
  threadId: ThreadId,
  markerId: ThreadMarkerId,
  updatedAt: IsoDateTime,
});

export const ThreadMarkerDoneSetPayload = Schema.Struct({
  threadId: ThreadId,
  markerId: ThreadMarkerId,
  done: Schema.Boolean,
  updatedAt: IsoDateTime,
});

export const ThreadMarkerLabelSetPayload = Schema.Struct({
  threadId: ThreadId,
  markerId: ThreadMarkerId,
  label: Schema.NullOr(ThreadMarkerLabel),
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
  dispatchOrigin: Schema.optional(MessageDispatchOrigin),
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

export const ThreadTaskStopRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  taskId: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
});

export const ThreadTaskBackgroundRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  toolUseId: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
});

export const ThreadApprovalResponseRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  lifecycleGeneration: Schema.optional(TrimmedNonEmptyString),
  decision: ProviderApprovalDecision,
  createdAt: IsoDateTime,
});

const ThreadUserInputResponseRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  lifecycleGeneration: Schema.optional(TrimmedNonEmptyString),
  answers: ProviderUserInputAnswers,
  createdAt: IsoDateTime,
});

export const ThreadCheckpointRevertRequestedPayload = Schema.Struct({
  threadId: ThreadId,
  turnCount: NonNegativeInt,
  scope: Schema.optional(Schema.Literals(["thread", "files"])).pipe(
    Schema.withDecodingDefault(() => "thread"),
  ),
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
  preserveLatestTurn: Schema.optional(Schema.Boolean),
});

export const ThreadActivityAppendedPayload = Schema.Struct({
  threadId: ThreadId,
  activity: OrchestrationThreadActivity,
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
  aggregateId: Schema.Union([ProjectId, WorktreeWorkspaceId, ThreadId]),
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
    type: Schema.Literal("workspace.created"),
    payload: WorktreeWorkspaceCreatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("workspace.meta-updated"),
    payload: WorktreeWorkspaceMetaUpdatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("workspace.provision-requested"),
    payload: WorktreeWorkspaceLifecycleRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("workspace.archive-requested"),
    payload: WorktreeWorkspaceLifecycleRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("workspace.archived"),
    payload: WorktreeWorkspaceArchivedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("workspace.restore-requested"),
    payload: WorktreeWorkspaceLifecycleRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("workspace.restored"),
    payload: WorktreeWorkspaceRestoredPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("workspace.ready"),
    payload: WorktreeWorkspaceReadyPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("workspace.operation-failed"),
    payload: WorktreeWorkspaceOperationFailedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.created"),
    payload: ThreadCreatedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.workspace-assigned"),
    payload: ThreadWorkspaceAssignedPayload,
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
    type: Schema.Literal("thread.pinned-message-added"),
    payload: ThreadPinnedMessageAddedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.pinned-message-removed"),
    payload: ThreadPinnedMessageRemovedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.pinned-message-done-set"),
    payload: ThreadPinnedMessageDoneSetPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.pinned-message-label-set"),
    payload: ThreadPinnedMessageLabelSetPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.marker-added"),
    payload: ThreadMarkerAddedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.marker-removed"),
    payload: ThreadMarkerRemovedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.marker-done-set"),
    payload: ThreadMarkerDoneSetPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.marker-label-set"),
    payload: ThreadMarkerLabelSetPayload,
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
    type: Schema.Literal("thread.task-stop-requested"),
    payload: ThreadTaskStopRequestedPayload,
  }),
  Schema.Struct({
    ...EventBaseFields,
    type: Schema.Literal("thread.task-background-requested"),
    payload: ThreadTaskBackgroundRequestedPayload,
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

export const DispatchResult = Schema.Struct({
  sequence: NonNegativeInt,
});
export type DispatchResult = typeof DispatchResult.Type;

export const OrchestrationCapabilities = Schema.Struct({
  protocolVersions: Schema.Array(PositiveInt),
  worktreeWorkspacesV2: Schema.Boolean,
  canonicalWorkspaceRoutes: Schema.Boolean,
});
export type OrchestrationCapabilities = typeof OrchestrationCapabilities.Type;

export const OrchestrationGetCapabilitiesInput = Schema.Struct({});
export type OrchestrationGetCapabilitiesInput = typeof OrchestrationGetCapabilitiesInput.Type;
export const OrchestrationGetCapabilitiesResult = OrchestrationCapabilities;
export type OrchestrationGetCapabilitiesResult = typeof OrchestrationGetCapabilitiesResult.Type;

export const OrchestrationGetSnapshotInput = Schema.Struct({});
export type OrchestrationGetSnapshotInput = typeof OrchestrationGetSnapshotInput.Type;
const OrchestrationGetSnapshotResult = OrchestrationReadModelV1;
export type OrchestrationGetSnapshotResult = typeof OrchestrationGetSnapshotResult.Type;

export const OrchestrationGetShellSnapshotInput = Schema.Struct({});
export type OrchestrationGetShellSnapshotInput = typeof OrchestrationGetShellSnapshotInput.Type;
const OrchestrationGetShellSnapshotResult = OrchestrationShellSnapshot;
export type OrchestrationGetShellSnapshotResult = typeof OrchestrationGetShellSnapshotResult.Type;

export const OrchestrationGetWorkspaceShellSnapshotInput = Schema.Struct({});
export type OrchestrationGetWorkspaceShellSnapshotInput =
  typeof OrchestrationGetWorkspaceShellSnapshotInput.Type;
export const OrchestrationGetWorkspaceShellSnapshotResult = OrchestrationWorkspaceShellSnapshot;
export type OrchestrationGetWorkspaceShellSnapshotResult =
  typeof OrchestrationGetWorkspaceShellSnapshotResult.Type;

export const OrchestrationRepairStateInput = Schema.Struct({});
export type OrchestrationRepairStateInput = typeof OrchestrationRepairStateInput.Type;
const OrchestrationRepairStateResult = OrchestrationReadModelV1;
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

export const OrchestrationReplayWorkspaceEventsInput = OrchestrationReplayEventsInput;
export type OrchestrationReplayWorkspaceEventsInput =
  typeof OrchestrationReplayWorkspaceEventsInput.Type;
export const OrchestrationReplayWorkspaceEventsResult = Schema.Array(OrchestrationEvent);
export type OrchestrationReplayWorkspaceEventsResult =
  typeof OrchestrationReplayWorkspaceEventsResult.Type;

export const ProviderDeliveryReconciliationOutcome = Schema.Literals([
  "accepted",
  "safe_retry",
  "abandon",
]);
export type ProviderDeliveryReconciliationOutcome =
  typeof ProviderDeliveryReconciliationOutcome.Type;

export const ProviderDeliveryBlockingEvidence = Schema.Struct({
  consumerName: Schema.String,
  eventSequence: NonNegativeInt,
  eventId: EventId,
  eventType: Schema.String,
  occurredAt: IsoDateTime,
  threadId: ThreadId,
  state: Schema.Literals(["dead", "uncertain"]),
  attemptCount: NonNegativeInt,
  lastError: Schema.NullOr(Schema.String),
  updatedAt: IsoDateTime,
  lastReconciliationOutcome: Schema.NullOr(ProviderDeliveryReconciliationOutcome),
  lastReconciledAt: Schema.NullOr(IsoDateTime),
  lastReconciledBy: Schema.NullOr(Schema.String),
  lastReconciliationNote: Schema.NullOr(Schema.String),
});
export type ProviderDeliveryBlockingEvidence = typeof ProviderDeliveryBlockingEvidence.Type;

export const OrchestrationListProviderDeliveryBlockersInput = Schema.Struct({
  threadId: Schema.optional(ThreadId),
  limit: Schema.optional(PositiveInt),
});
export type OrchestrationListProviderDeliveryBlockersInput =
  typeof OrchestrationListProviderDeliveryBlockersInput.Type;

export const OrchestrationListProviderDeliveryBlockersResult = Schema.Array(
  ProviderDeliveryBlockingEvidence,
);
export type OrchestrationListProviderDeliveryBlockersResult =
  typeof OrchestrationListProviderDeliveryBlockersResult.Type;

export const OrchestrationReconcileProviderDeliveryInput = Schema.Struct({
  eventSequence: NonNegativeInt,
  threadId: ThreadId,
  expectedState: Schema.Literals(["dead", "uncertain"]),
  outcome: ProviderDeliveryReconciliationOutcome,
  note: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(2_000))),
});
export type OrchestrationReconcileProviderDeliveryInput =
  typeof OrchestrationReconcileProviderDeliveryInput.Type;

export const OrchestrationReconcileProviderDeliveryResult = Schema.Struct({
  eventSequence: NonNegativeInt,
  threadId: ThreadId,
  outcome: ProviderDeliveryReconciliationOutcome,
  state: Schema.Literals(["retry", "succeeded", "dead", "uncertain"]),
  reconciledAt: IsoDateTime,
});
export type OrchestrationReconcileProviderDeliveryResult =
  typeof OrchestrationReconcileProviderDeliveryResult.Type;

export const OrchestrationSubscribeShellInput = Schema.Struct({});
export type OrchestrationSubscribeShellInput = typeof OrchestrationSubscribeShellInput.Type;

export const OrchestrationUnsubscribeShellInput = Schema.Struct({});
export type OrchestrationUnsubscribeShellInput = typeof OrchestrationUnsubscribeShellInput.Type;

export const OrchestrationSubscribeWorkspaceShellInput = Schema.Struct({});
export type OrchestrationSubscribeWorkspaceShellInput =
  typeof OrchestrationSubscribeWorkspaceShellInput.Type;

export const OrchestrationUnsubscribeWorkspaceShellInput = Schema.Struct({});
export type OrchestrationUnsubscribeWorkspaceShellInput =
  typeof OrchestrationUnsubscribeWorkspaceShellInput.Type;

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

export const WorkspaceLifecyclePreflightInput = Schema.Struct({
  workspaceId: WorktreeWorkspaceId,
  action: Schema.Literals(["archive", "restore"]),
});
export type WorkspaceLifecyclePreflightInput = typeof WorkspaceLifecyclePreflightInput.Type;

export const WorkspaceLifecyclePreflightIssue = Schema.Struct({
  code: Schema.Literals([
    "workspace-not-found",
    "repository-root",
    "invalid-state",
    "operation-active",
    "agent-active",
    "terminal-active",
    "dev-server-active",
    "path-unavailable",
    "git-status-unavailable",
    "working-tree-dirty",
    "merge-conflicts",
    "local-only-commits",
    "unpushed-commits",
    "branch-unavailable",
    "path-occupied",
    "repository-mismatch",
  ]),
  message: TrimmedNonEmptyString,
});
export type WorkspaceLifecyclePreflightIssue = typeof WorkspaceLifecyclePreflightIssue.Type;

export const WorkspaceLifecyclePreflightResult = Schema.Struct({
  workspaceId: WorktreeWorkspaceId,
  action: Schema.Literals(["archive", "restore"]),
  lifecycleGeneration: NonNegativeInt,
  canStart: Schema.Boolean,
  requiresConfirmation: Schema.Boolean,
  blockers: Schema.Array(WorkspaceLifecyclePreflightIssue),
  warnings: Schema.Array(WorkspaceLifecyclePreflightIssue),
});
export type WorkspaceLifecyclePreflightResult = typeof WorkspaceLifecyclePreflightResult.Type;

export const OrchestrationRpcSchemas = {
  getCapabilities: {
    input: OrchestrationGetCapabilitiesInput,
    output: OrchestrationGetCapabilitiesResult,
  },
  getSnapshot: {
    input: OrchestrationGetSnapshotInput,
    output: OrchestrationGetSnapshotResult,
  },
  getShellSnapshot: {
    input: OrchestrationGetShellSnapshotInput,
    output: OrchestrationGetShellSnapshotResult,
  },
  getWorkspaceShellSnapshot: {
    input: OrchestrationGetWorkspaceShellSnapshotInput,
    output: OrchestrationGetWorkspaceShellSnapshotResult,
  },
  repairState: {
    input: OrchestrationRepairStateInput,
    output: OrchestrationRepairStateResult,
  },
  dispatchCommand: {
    input: ClientOrchestrationCommand,
    output: DispatchResult,
  },
  getWorkspaceLifecyclePreflight: {
    input: WorkspaceLifecyclePreflightInput,
    output: WorkspaceLifecyclePreflightResult,
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
  replayWorkspaceEvents: {
    input: OrchestrationReplayWorkspaceEventsInput,
    output: OrchestrationReplayWorkspaceEventsResult,
  },
  listProviderDeliveryBlockers: {
    input: OrchestrationListProviderDeliveryBlockersInput,
    output: OrchestrationListProviderDeliveryBlockersResult,
  },
  reconcileProviderDelivery: {
    input: OrchestrationReconcileProviderDeliveryInput,
    output: OrchestrationReconcileProviderDeliveryResult,
  },
  subscribeShell: {
    input: OrchestrationSubscribeShellInput,
    output: Schema.Void,
  },
  unsubscribeShell: {
    input: OrchestrationUnsubscribeShellInput,
    output: Schema.Void,
  },
  subscribeWorkspaceShell: {
    input: OrchestrationSubscribeWorkspaceShellInput,
    output: Schema.Void,
  },
  unsubscribeWorkspaceShell: {
    input: OrchestrationUnsubscribeWorkspaceShellInput,
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
