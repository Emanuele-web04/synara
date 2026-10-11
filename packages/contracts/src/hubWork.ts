import { Schema } from "effect";

import { SynaraCreateThreadSpec } from "./agentGateway";
import {
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
} from "./baseSchemas";
import { ChatAttachment, RuntimeMode } from "./orchestration";

export const NEW_HUB_MAX_CONCURRENT_WORKERS = 3;

export const HubWorkState = Schema.Literals([
  "queued",
  "starting",
  "working",
  "waiting",
  "idle",
  "completed",
  "failed",
  "cancelled",
]);
export type HubWorkState = typeof HubWorkState.Type;

export const HubWorkProgressStep = Schema.Struct({
  id: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  text: TrimmedNonEmptyString.check(Schema.isMaxLength(1_000)),
  status: Schema.Literals(["pending", "inProgress", "completed"]),
});
export type HubWorkProgressStep = typeof HubWorkProgressStep.Type;

export const HubWorkProgress = Schema.Struct({
  revision: NonNegativeInt,
  steps: Schema.Array(HubWorkProgressStep).check(Schema.isMaxLength(32)),
  summary: Schema.optional(Schema.String.check(Schema.isMaxLength(2_000))),
});
export type HubWorkProgress = typeof HubWorkProgress.Type;

export const HubWorkItem = Schema.Struct({
  id: TrimmedNonEmptyString,
  sourceThreadId: ThreadId,
  sourceMessageId: Schema.NullOr(MessageId),
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(240)),
  workerThreadId: Schema.NullOr(ThreadId),
  state: HubWorkState,
  queueReason: Schema.NullOr(Schema.String),
  resultSummary: Schema.NullOr(Schema.String.check(Schema.isMaxLength(4_000))),
  progress: Schema.NullOr(HubWorkProgress),
  revision: NonNegativeInt,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type HubWorkItem = typeof HubWorkItem.Type;

export const HubWorkSourceMessage = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  turnId: Schema.NullOr(TurnId),
  text: Schema.String,
  attachments: Schema.Array(ChatAttachment),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type HubWorkSourceMessage = typeof HubWorkSourceMessage.Type;

export const HubWorkRecord = Schema.Struct({
  ...HubWorkItem.fields,
  projectId: ProjectId,
  delegationTurnId: Schema.optional(TurnId),
  targetProjectId: ProjectId,
  requestId: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  scopeKey: TrimmedNonEmptyString,
  fingerprint: TrimmedNonEmptyString,
  taskIndex: NonNegativeInt,
  creationSpec: Schema.Struct({
    ...SynaraCreateThreadSpec.fields,
    // Snapshot the coordinator mode at submission, including Auto, without
    // exposing additional explicit modes on the MCP creation input.
    inheritedRuntimeMode: Schema.optional(RuntimeMode),
  }),
  sourceMessages: Schema.Array(HubWorkSourceMessage),
  slotHeld: Schema.Boolean,
  admittedAt: Schema.NullOr(IsoDateTime),
  admissionCommandId: Schema.NullOr(Schema.String),
  admissionMessageId: Schema.NullOr(MessageId),
  admissionPreviousState: Schema.NullOr(HubWorkState),
  admissionPreviousSlotHeld: Schema.Boolean,
  revision: NonNegativeInt,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type HubWorkRecord = typeof HubWorkRecord.Type;

export function hubWorkItem(record: HubWorkRecord): HubWorkItem {
  return {
    id: record.id,
    sourceThreadId: record.sourceThreadId,
    sourceMessageId: record.sourceMessageId,
    title: record.title,
    workerThreadId: record.workerThreadId,
    state: record.state,
    queueReason: record.queueReason,
    resultSummary: record.resultSummary,
    progress: record.progress,
    revision: record.revision,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}
