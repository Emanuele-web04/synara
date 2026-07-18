import { Option, Schema, SchemaIssue } from "effect";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";

import {
  ApprovalRequestId,
  AuthSessionId,
  EventId,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
} from "./baseSchemas";
import {
  ChatAttachment,
  ModelSelection,
  OrchestrationLatestTurn,
  OrchestrationMessageRole,
  OrchestrationMessageSource,
  OrchestrationProposedPlan,
  OrchestrationSessionStatus,
  OrchestrationThreadActivityTone,
  MessageDispatchOrigin,
  ProviderApprovalDecision,
  ProviderInteractionMode,
  ProviderKind,
  ProviderRequestKind,
  ProviderUserInputAnswers,
  RuntimeMode,
  ThreadTurnDiff,
  TurnDispatchMode,
} from "./orchestration";
import { ProjectKind } from "./project";
import {
  ProviderComposerCapabilities,
  ProviderModelDescriptor,
} from "./providerDiscovery";
import { UserInputQuestion } from "./providerRuntime";

export const COMPANION_PROTOCOL_VERSION = 1 as const;
export const COMPANION_HTTP_BASE_PATH = "/api/companion/v1" as const;
export const COMPANION_WS_PATH = `${COMPANION_HTTP_BASE_PATH}/ws` as const;
export const COMPANION_WS_PROTOCOL = "synara.companion.v1" as const;
export const COMPANION_WS_AUTH_PROTOCOL_PREFIX = "synara.auth." as const;

export const COMPANION_RPC_METHODS = {
  hello: "companion.hello",
  subscribeShell: "companion.subscribeShell",
  listProjects: "companion.listProjects",
  listThreads: "companion.listThreads",
  getThread: "companion.getThread",
  subscribeThread: "companion.subscribeThread",
  listComposerOptions: "companion.listComposerOptions",
  createThread: "companion.createThread",
  sendTurn: "companion.sendTurn",
  interruptTurn: "companion.interruptTurn",
  respondToApproval: "companion.respondToApproval",
  respondToUserInput: "companion.respondToUserInput",
  getTurnDiff: "companion.getTurnDiff",
  getThreadDiff: "companion.getThreadDiff",
} as const;

export const COMPANION_RPC_METHOD_ALLOWLIST = [
  COMPANION_RPC_METHODS.hello,
  COMPANION_RPC_METHODS.subscribeShell,
  COMPANION_RPC_METHODS.listProjects,
  COMPANION_RPC_METHODS.listThreads,
  COMPANION_RPC_METHODS.getThread,
  COMPANION_RPC_METHODS.subscribeThread,
  COMPANION_RPC_METHODS.listComposerOptions,
  COMPANION_RPC_METHODS.createThread,
  COMPANION_RPC_METHODS.sendTurn,
  COMPANION_RPC_METHODS.interruptTurn,
  COMPANION_RPC_METHODS.respondToApproval,
  COMPANION_RPC_METHODS.respondToUserInput,
  COMPANION_RPC_METHODS.getTurnDiff,
  COMPANION_RPC_METHODS.getThreadDiff,
] as const;

export const CompanionRequestId = TrimmedNonEmptyString.check(
  Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i),
).pipe(Schema.brand("CompanionRequestId"));
export type CompanionRequestId = typeof CompanionRequestId.Type;

export const CompanionUploadId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^[a-z0-9_-]+$/i),
).pipe(Schema.brand("CompanionUploadId"));
export type CompanionUploadId = typeof CompanionUploadId.Type;

export const CompanionCapability = Schema.Literals([
  "projects.read",
  "threads.read",
  "threads.create",
  "turns.send",
  "turns.interrupt",
  "approvals.respond",
  "user-input.respond",
  "diffs.read",
  "attachments.write",
  "notifications.push",
]);
export type CompanionCapability = typeof CompanionCapability.Type;

export const CompanionClientPlatform = Schema.Literals(["web", "ios", "android", "unknown"]);
export type CompanionClientPlatform = typeof CompanionClientPlatform.Type;

export const CompanionClientDescriptor = Schema.Struct({
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(80)),
  version: TrimmedNonEmptyString.check(Schema.isMaxLength(80)),
  platform: CompanionClientPlatform,
});
export type CompanionClientDescriptor = typeof CompanionClientDescriptor.Type;

export const CompanionHelloInput = Schema.Struct({
  // Accept a bounded numeric version so the server can return the protocol's typed
  // ProtocolMismatch error instead of failing request decoding generically.
  protocolVersion: NonNegativeInt,
  client: CompanionClientDescriptor,
});
export type CompanionHelloInput = typeof CompanionHelloInput.Type;

export const CompanionHello = Schema.Struct({
  protocolVersion: Schema.Literal(COMPANION_PROTOCOL_VERSION),
  serverVersion: TrimmedNonEmptyString,
  capabilities: Schema.Array(CompanionCapability),
  session: Schema.Struct({
    id: AuthSessionId,
    deviceLabel: TrimmedNonEmptyString,
    accessProfile: Schema.Literal("companion"),
    expiresAt: Schema.DateTimeUtc,
  }),
});
export type CompanionHello = typeof CompanionHello.Type;

/** Current-device metadata that a Companion client may update without owner access. */
export const CompanionUpdateDeviceLabelInput = Schema.Struct({
  deviceLabel: TrimmedNonEmptyString.check(Schema.isMaxLength(80)),
});
export type CompanionUpdateDeviceLabelInput = typeof CompanionUpdateDeviceLabelInput.Type;

export const CompanionUpdateDeviceLabelResult = Schema.Struct({
  deviceLabel: TrimmedNonEmptyString.check(Schema.isMaxLength(80)),
});
export type CompanionUpdateDeviceLabelResult = typeof CompanionUpdateDeviceLabelResult.Type;

export const CompanionErrorCode = Schema.Literals([
  "Unauthenticated",
  "SessionExpired",
  "Forbidden",
  "ProtocolMismatch",
  "NotFound",
  "Conflict",
  "ValidationFailed",
  "PayloadTooLarge",
  "RateLimited",
  "ProviderUnavailable",
  "HostUnavailable",
  "InternalError",
]);
export type CompanionErrorCode = typeof CompanionErrorCode.Type;

export const CompanionError = Schema.Struct({
  _tag: CompanionErrorCode,
  message: TrimmedNonEmptyString.check(Schema.isMaxLength(500)),
  retryable: Schema.Boolean,
  requestId: Schema.optional(CompanionRequestId),
  retryAfterMs: Schema.optional(PositiveInt),
});
export type CompanionError = typeof CompanionError.Type;

/** A project view deliberately omitting workspace roots, scripts, and other paths. */
export const CompanionProject = Schema.Struct({
  id: ProjectId,
  kind: ProjectKind,
  title: TrimmedNonEmptyString,
  defaultModelSelection: Schema.NullOr(ModelSelection),
  isPinned: Schema.Boolean,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type CompanionProject = typeof CompanionProject.Type;

export const CompanionThreadRuntime = Schema.Struct({
  status: OrchestrationSessionStatus,
  activeTurnId: Schema.NullOr(TurnId),
  lastError: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(500))),
  updatedAt: IsoDateTime,
});
export type CompanionThreadRuntime = typeof CompanionThreadRuntime.Type;

/** A thread view deliberately omitting branches, worktree paths, and provider credentials. */
export const CompanionThreadSummary = Schema.Struct({
  id: ThreadId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  latestTurn: Schema.NullOr(OrchestrationLatestTurn),
  runtime: Schema.NullOr(CompanionThreadRuntime),
  hasPendingApprovals: Schema.Boolean,
  hasPendingUserInput: Schema.Boolean,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  archivedAt: Schema.NullOr(IsoDateTime),
});
export type CompanionThreadSummary = typeof CompanionThreadSummary.Type;

/** An activity view that never exposes the raw provider/tool payload. */
export const CompanionActivity = Schema.Struct({
  id: EventId,
  tone: OrchestrationThreadActivityTone,
  kind: TrimmedNonEmptyString,
  summary: TrimmedNonEmptyString,
  turnId: Schema.NullOr(TurnId),
  sequence: NonNegativeInt,
  createdAt: IsoDateTime,
});
export type CompanionActivity = typeof CompanionActivity.Type;

export const CompanionApprovalRequest = Schema.Struct({
  requestId: ApprovalRequestId,
  threadId: ThreadId,
  turnId: Schema.NullOr(TurnId),
  requestKind: ProviderRequestKind,
  summary: TrimmedNonEmptyString.check(Schema.isMaxLength(1_000)),
  createdAt: IsoDateTime,
});
export type CompanionApprovalRequest = typeof CompanionApprovalRequest.Type;

export const CompanionUserInputRequest = Schema.Struct({
  requestId: ApprovalRequestId,
  threadId: ThreadId,
  turnId: Schema.NullOr(TurnId),
  questions: Schema.Array(UserInputQuestion).check(Schema.isMaxLength(3)),
  createdAt: IsoDateTime,
});
export type CompanionUserInputRequest = typeof CompanionUserInputRequest.Type;

/**
 * Message projection safe for a remotely reachable Companion client.
 *
 * Provider skill and mention references are deliberately absent because their
 * desktop contracts contain absolute filesystem paths.
 */
export const CompanionMessage = Schema.Struct({
  id: MessageId,
  role: OrchestrationMessageRole,
  text: Schema.String,
  attachments: Schema.optional(Schema.Array(ChatAttachment)),
  dispatchMode: Schema.optional(TurnDispatchMode),
  dispatchOrigin: Schema.optional(MessageDispatchOrigin),
  turnId: Schema.NullOr(TurnId),
  streaming: Schema.Boolean,
  source: OrchestrationMessageSource.pipe(Schema.withDecodingDefault(() => "native")),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type CompanionMessage = typeof CompanionMessage.Type;

export const CompanionThreadDetail = Schema.Struct({
  thread: CompanionThreadSummary,
  messages: Schema.Array(CompanionMessage),
  activities: Schema.Array(CompanionActivity),
  proposedPlans: Schema.Array(OrchestrationProposedPlan),
  approvals: Schema.Array(CompanionApprovalRequest),
  userInputRequests: Schema.Array(CompanionUserInputRequest),
});
export type CompanionThreadDetail = typeof CompanionThreadDetail.Type;

export const CompanionShellSnapshot = Schema.Struct({
  snapshotSequence: NonNegativeInt,
  projects: Schema.Array(CompanionProject),
  threads: Schema.Array(CompanionThreadSummary),
  updatedAt: IsoDateTime,
});
export type CompanionShellSnapshot = typeof CompanionShellSnapshot.Type;

export const CompanionShellEvent = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("project-upserted"),
    sequence: NonNegativeInt,
    project: CompanionProject,
  }),
  Schema.Struct({
    kind: Schema.Literal("project-removed"),
    sequence: NonNegativeInt,
    projectId: ProjectId,
  }),
  Schema.Struct({
    kind: Schema.Literal("thread-upserted"),
    sequence: NonNegativeInt,
    thread: CompanionThreadSummary,
  }),
  Schema.Struct({
    kind: Schema.Literal("thread-removed"),
    sequence: NonNegativeInt,
    threadId: ThreadId,
  }),
]);
export type CompanionShellEvent = typeof CompanionShellEvent.Type;

export const CompanionShellStreamItem = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("snapshot"),
    snapshot: CompanionShellSnapshot,
  }),
  CompanionShellEvent,
]);
export type CompanionShellStreamItem = typeof CompanionShellStreamItem.Type;

export const CompanionThreadEvent = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("thread-updated"),
    sequence: NonNegativeInt,
    thread: CompanionThreadSummary,
  }),
  Schema.Struct({
    kind: Schema.Literal("message-upserted"),
    sequence: NonNegativeInt,
    message: CompanionMessage,
  }),
  Schema.Struct({
    kind: Schema.Literal("message-removed"),
    sequence: NonNegativeInt,
    messageId: MessageId,
  }),
  Schema.Struct({
    kind: Schema.Literal("activity-upserted"),
    sequence: NonNegativeInt,
    activity: CompanionActivity,
  }),
  Schema.Struct({
    kind: Schema.Literal("approval-upserted"),
    sequence: NonNegativeInt,
    approval: CompanionApprovalRequest,
  }),
  Schema.Struct({
    kind: Schema.Literal("approval-removed"),
    sequence: NonNegativeInt,
    requestId: ApprovalRequestId,
  }),
  Schema.Struct({
    kind: Schema.Literal("user-input-upserted"),
    sequence: NonNegativeInt,
    request: CompanionUserInputRequest,
  }),
  Schema.Struct({
    kind: Schema.Literal("user-input-removed"),
    sequence: NonNegativeInt,
    requestId: ApprovalRequestId,
  }),
  Schema.Struct({
    kind: Schema.Literal("resync-required"),
    sequence: NonNegativeInt,
    reason: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  }),
]);
export type CompanionThreadEvent = typeof CompanionThreadEvent.Type;

export const CompanionThreadStreamItem = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("snapshot"),
    snapshot: Schema.Struct({
      snapshotSequence: NonNegativeInt,
      detail: CompanionThreadDetail,
    }),
  }),
  CompanionThreadEvent,
]);
export type CompanionThreadStreamItem = typeof CompanionThreadStreamItem.Type;

export const CompanionSubscribeShellInput = Schema.Struct({});
export type CompanionSubscribeShellInput = typeof CompanionSubscribeShellInput.Type;

export const CompanionListProjectsInput = Schema.Struct({});
export type CompanionListProjectsInput = typeof CompanionListProjectsInput.Type;
export const CompanionListProjectsResult = Schema.Struct({
  projects: Schema.Array(CompanionProject),
});
export type CompanionListProjectsResult = typeof CompanionListProjectsResult.Type;

export const CompanionThreadFilterStatus = Schema.Literals([
  "running",
  "attention",
  "completed",
  "failed",
  "interrupted",
  "idle",
  "archived",
]);
export type CompanionThreadFilterStatus = typeof CompanionThreadFilterStatus.Type;

export const CompanionListThreadsInput = Schema.Struct({
  projectId: Schema.optional(ProjectId),
  status: Schema.optional(CompanionThreadFilterStatus),
  cursor: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(500))),
  limit: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(100))),
});
export type CompanionListThreadsInput = typeof CompanionListThreadsInput.Type;
export const CompanionListThreadsResult = Schema.Struct({
  threads: Schema.Array(CompanionThreadSummary),
  nextCursor: Schema.NullOr(TrimmedNonEmptyString),
});
export type CompanionListThreadsResult = typeof CompanionListThreadsResult.Type;

export const CompanionGetThreadInput = Schema.Struct({ threadId: ThreadId });
export type CompanionGetThreadInput = typeof CompanionGetThreadInput.Type;
export const CompanionGetThreadResult = CompanionThreadDetail;
export type CompanionGetThreadResult = typeof CompanionGetThreadResult.Type;

export const CompanionSubscribeThreadInput = Schema.Struct({ threadId: ThreadId });
export type CompanionSubscribeThreadInput = typeof CompanionSubscribeThreadInput.Type;

export const CompanionProviderOption = Schema.Struct({
  provider: ProviderKind,
  displayName: TrimmedNonEmptyString,
  models: Schema.Array(ProviderModelDescriptor),
  capabilities: ProviderComposerCapabilities,
});
export type CompanionProviderOption = typeof CompanionProviderOption.Type;

export const CompanionListComposerOptionsInput = Schema.Struct({ projectId: ProjectId });
export type CompanionListComposerOptionsInput = typeof CompanionListComposerOptionsInput.Type;
export const CompanionListComposerOptionsResult = Schema.Struct({
  providers: Schema.Array(CompanionProviderOption),
  defaultModelSelection: Schema.NullOr(ModelSelection),
  runtimeModes: Schema.Array(RuntimeMode),
  interactionModes: Schema.Array(ProviderInteractionMode),
});
export type CompanionListComposerOptionsResult = typeof CompanionListComposerOptionsResult.Type;

export const CompanionCreateThreadInput = Schema.Struct({
  requestId: CompanionRequestId,
  threadId: ThreadId,
  projectId: ProjectId,
  providerId: ProviderKind,
  modelId: TrimmedNonEmptyString,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  fullAccessConfirmed: Schema.optional(Schema.Literal(true)),
  initialTitle: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(200))),
}).check(
  Schema.makeFilter(
    (input) =>
      input.runtimeMode !== "full-access" ||
      input.fullAccessConfirmed === true ||
      new SchemaIssue.InvalidValue(Option.some(input.runtimeMode), {
        message: "fullAccessConfirmed must be true when runtimeMode is full-access",
      }),
    { identifier: "CompanionCreateThreadInput" },
  ),
);
export type CompanionCreateThreadInput = typeof CompanionCreateThreadInput.Type;

export const CompanionSendTurnInput = Schema.Struct({
  requestId: CompanionRequestId,
  threadId: ThreadId,
  text: Schema.String.check(Schema.isMaxLength(120_000)),
  attachmentIds: Schema.Array(CompanionUploadId).check(Schema.isMaxLength(8)),
  delivery: TurnDispatchMode,
});
export type CompanionSendTurnInput = typeof CompanionSendTurnInput.Type;

export const CompanionInterruptTurnInput = Schema.Struct({
  requestId: CompanionRequestId,
  threadId: ThreadId,
  turnId: Schema.optional(TurnId),
});
export type CompanionInterruptTurnInput = typeof CompanionInterruptTurnInput.Type;

export const CompanionRespondToApprovalInput = Schema.Struct({
  requestId: CompanionRequestId,
  threadId: ThreadId,
  approvalRequestId: ApprovalRequestId,
  decision: ProviderApprovalDecision,
});
export type CompanionRespondToApprovalInput = typeof CompanionRespondToApprovalInput.Type;

export const CompanionRespondToUserInputInput = Schema.Struct({
  requestId: CompanionRequestId,
  threadId: ThreadId,
  userInputRequestId: ApprovalRequestId,
  answers: ProviderUserInputAnswers,
});
export type CompanionRespondToUserInputInput = typeof CompanionRespondToUserInputInput.Type;

export const CompanionMutationReceipt = Schema.Struct({
  requestId: CompanionRequestId,
  accepted: Schema.Literal(true),
  sequence: NonNegativeInt,
});
export type CompanionMutationReceipt = typeof CompanionMutationReceipt.Type;

export const CompanionGetTurnDiffInput = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
  ignoreWhitespace: Schema.optional(Schema.Boolean),
});
export type CompanionGetTurnDiffInput = typeof CompanionGetTurnDiffInput.Type;
export const CompanionGetTurnDiffResult = ThreadTurnDiff;
export type CompanionGetTurnDiffResult = typeof CompanionGetTurnDiffResult.Type;

export const CompanionGetThreadDiffInput = Schema.Struct({
  threadId: ThreadId,
  ignoreWhitespace: Schema.optional(Schema.Boolean),
});
export type CompanionGetThreadDiffInput = typeof CompanionGetThreadDiffInput.Type;
export const CompanionGetThreadDiffResult = ThreadTurnDiff;
export type CompanionGetThreadDiffResult = typeof CompanionGetThreadDiffResult.Type;

export const CompanionUploadAttachment = Schema.Struct({
  id: CompanionUploadId,
  threadId: ThreadId,
  attachment: ChatAttachment,
  expiresAt: Schema.DateTimeUtc,
});
export type CompanionUploadAttachment = typeof CompanionUploadAttachment.Type;

export const CompanionDeleteUploadResult = Schema.Struct({ deleted: Schema.Boolean });
export type CompanionDeleteUploadResult = typeof CompanionDeleteUploadResult.Type;

export const CompanionPushTransport = Schema.Literal("webpush");
export type CompanionPushTransport = typeof CompanionPushTransport.Type;
export const CompanionNotificationKind = Schema.Literals([
  "task_completed",
  "task_failed",
  "approval_required",
  "user_input_required",
]);
export type CompanionNotificationKind = typeof CompanionNotificationKind.Type;
export const CompanionNotificationPayload = Schema.Struct({
  kind: CompanionNotificationKind,
  threadId: ThreadId,
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(100)),
  preview: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(160))),
  createdAt: IsoDateTime,
});
export type CompanionNotificationPayload = typeof CompanionNotificationPayload.Type;

export const CompanionWebPushSubscription = Schema.Struct({
  transport: Schema.Literal("webpush"),
  endpoint: TrimmedNonEmptyString.check(Schema.isMaxLength(4_096)),
  keys: Schema.Struct({
    p256dh: TrimmedNonEmptyString.check(Schema.isMaxLength(500)),
    auth: TrimmedNonEmptyString.check(Schema.isMaxLength(500)),
  }),
});
export type CompanionWebPushSubscription = typeof CompanionWebPushSubscription.Type;

export const CompanionPushSubscriptionInput = Schema.Struct({
  subscription: CompanionWebPushSubscription,
  previewEnabled: Schema.Boolean,
});
export type CompanionPushSubscriptionInput = typeof CompanionPushSubscriptionInput.Type;

export const CompanionPushSubscription = Schema.Struct({
  id: TrimmedNonEmptyString,
  transport: CompanionPushTransport,
  previewEnabled: Schema.Boolean,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type CompanionPushSubscription = typeof CompanionPushSubscription.Type;

export const CompanionPushSubscriptionResult = Schema.Struct({
  subscription: CompanionPushSubscription,
});
export type CompanionPushSubscriptionResult = typeof CompanionPushSubscriptionResult.Type;

export const CompanionDeletePushSubscriptionResult = Schema.Struct({ deleted: Schema.Boolean });
export type CompanionDeletePushSubscriptionResult =
  typeof CompanionDeletePushSubscriptionResult.Type;

export const CompanionPushConfigResult = Schema.Struct({
  supported: Schema.Boolean,
  vapidPublicKey: Schema.NullOr(TrimmedNonEmptyString),
});
export type CompanionPushConfigResult = typeof CompanionPushConfigResult.Type;

export const CompanionTestPushResult = Schema.Struct({ accepted: Schema.Boolean });
export type CompanionTestPushResult = typeof CompanionTestPushResult.Type;

export const CompanionHelloRpc = Rpc.make(COMPANION_RPC_METHODS.hello, {
  payload: CompanionHelloInput,
  success: CompanionHello,
  error: CompanionError,
});
export const CompanionSubscribeShellRpc = Rpc.make(COMPANION_RPC_METHODS.subscribeShell, {
  payload: CompanionSubscribeShellInput,
  success: CompanionShellStreamItem,
  error: CompanionError,
  stream: true,
});
export const CompanionListProjectsRpc = Rpc.make(COMPANION_RPC_METHODS.listProjects, {
  payload: CompanionListProjectsInput,
  success: CompanionListProjectsResult,
  error: CompanionError,
});
export const CompanionListThreadsRpc = Rpc.make(COMPANION_RPC_METHODS.listThreads, {
  payload: CompanionListThreadsInput,
  success: CompanionListThreadsResult,
  error: CompanionError,
});
export const CompanionGetThreadRpc = Rpc.make(COMPANION_RPC_METHODS.getThread, {
  payload: CompanionGetThreadInput,
  success: CompanionGetThreadResult,
  error: CompanionError,
});
export const CompanionSubscribeThreadRpc = Rpc.make(COMPANION_RPC_METHODS.subscribeThread, {
  payload: CompanionSubscribeThreadInput,
  success: CompanionThreadStreamItem,
  error: CompanionError,
  stream: true,
});
export const CompanionListComposerOptionsRpc = Rpc.make(
  COMPANION_RPC_METHODS.listComposerOptions,
  {
    payload: CompanionListComposerOptionsInput,
    success: CompanionListComposerOptionsResult,
    error: CompanionError,
  },
);
export const CompanionCreateThreadRpc = Rpc.make(COMPANION_RPC_METHODS.createThread, {
  payload: CompanionCreateThreadInput,
  success: CompanionMutationReceipt,
  error: CompanionError,
});
export const CompanionSendTurnRpc = Rpc.make(COMPANION_RPC_METHODS.sendTurn, {
  payload: CompanionSendTurnInput,
  success: CompanionMutationReceipt,
  error: CompanionError,
});
export const CompanionInterruptTurnRpc = Rpc.make(COMPANION_RPC_METHODS.interruptTurn, {
  payload: CompanionInterruptTurnInput,
  success: CompanionMutationReceipt,
  error: CompanionError,
});
export const CompanionRespondToApprovalRpc = Rpc.make(COMPANION_RPC_METHODS.respondToApproval, {
  payload: CompanionRespondToApprovalInput,
  success: CompanionMutationReceipt,
  error: CompanionError,
});
export const CompanionRespondToUserInputRpc = Rpc.make(COMPANION_RPC_METHODS.respondToUserInput, {
  payload: CompanionRespondToUserInputInput,
  success: CompanionMutationReceipt,
  error: CompanionError,
});
export const CompanionGetTurnDiffRpc = Rpc.make(COMPANION_RPC_METHODS.getTurnDiff, {
  payload: CompanionGetTurnDiffInput,
  success: CompanionGetTurnDiffResult,
  error: CompanionError,
});
export const CompanionGetThreadDiffRpc = Rpc.make(COMPANION_RPC_METHODS.getThreadDiff, {
  payload: CompanionGetThreadDiffInput,
  success: CompanionGetThreadDiffResult,
  error: CompanionError,
});

/** The complete and intentionally closed Companion Protocol v1 RPC surface. */
export const CompanionRpcGroup = RpcGroup.make(
  CompanionHelloRpc,
  CompanionSubscribeShellRpc,
  CompanionListProjectsRpc,
  CompanionListThreadsRpc,
  CompanionGetThreadRpc,
  CompanionSubscribeThreadRpc,
  CompanionListComposerOptionsRpc,
  CompanionCreateThreadRpc,
  CompanionSendTurnRpc,
  CompanionInterruptTurnRpc,
  CompanionRespondToApprovalRpc,
  CompanionRespondToUserInputRpc,
  CompanionGetTurnDiffRpc,
  CompanionGetThreadDiffRpc,
);
