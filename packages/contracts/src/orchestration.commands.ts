// Purpose: Orchestration command Schema/type definitions — client-dispatchable
//   commands (project/thread CRUD, turn start, approvals) and internal commands
//   (session/runtime lifecycle), plus their discriminated-union groupings.
// Layer: contracts (schema-only)
// Exports: ThreadHandoffImportedMessage, ThreadTurnStartCommand, ProjectCreateCommand,
//   DispatchableClientOrchestrationCommand, ClientOrchestrationCommand,
//   InternalOrchestrationCommand, OrchestrationCommand.
import { Schema } from "effect";
import { ProviderMentionReference, ProviderSkillReference } from "./providerDiscovery";
import { ProjectKind } from "./project";
import {
  ExecutionTargetKind,
  ExecutionRuntimeProvider,
  RuntimeInstanceStatus,
  RuntimePlan,
  RuntimeRole,
} from "./executionRuntime";
import {
  ApprovalRequestId,
  CheckpointRef,
  CommandId,
  ExecutionInstanceId,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  RuntimeActivityLeaseId,
  RuntimeProcessId,
  RuntimeRouteId,
  RuntimeSnapshotId,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
} from "./baseSchemas";
import {
  AssistantDeliveryMode,
  ChatAttachment,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  DEFAULT_TURN_DISPATCH_MODE,
  ModelSelection,
  OrchestrationCheckpointFile,
  OrchestrationCheckpointStatus,
  OrchestrationMessageSource,
  OrchestrationProposedPlan,
  OrchestrationReviewChatTarget,
  OrchestrationSession,
  OrchestrationThreadActivity,
  OrchestrationThreadPullRequest,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  ProjectScript,
  ProviderApprovalDecision,
  ProviderInteractionMode,
  ProviderReviewTarget,
  ProviderStartOptions,
  ProviderThreadInjectTextItem,
  ProviderUserInputAnswers,
  RuntimeMode,
  SidechatSourceThreadId,
  SourceProposedPlanReference,
  ThreadEnvironmentMode,
  ThreadHandoff,
  TurnDispatchMode,
  UploadChatAttachment,
} from "./orchestration.core";

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

const ThreadContextInjectCommand = Schema.Struct({
  type: Schema.Literal("thread.context.inject"),
  commandId: CommandId,
  threadId: ThreadId,
  items: Schema.Array(ProviderThreadInjectTextItem).check(Schema.isMinLength(1)),
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
  ThreadContextInjectCommand,
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
  ThreadContextInjectCommand,
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
