import {
  AsyncUserInput,
  ChatAttachment,
  MessageDispatchOrigin,
  OrchestrationMessageRole,
  OrchestrationMessageSource,
  TurnDispatchMode,
  MessageId,
  ProviderMentionReference,
  ProviderSkillReference,
  ThreadId,
  TurnId,
  IsoDateTime,
  NonNegativeInt,
} from "@synara/contracts";
import { Schema, ServiceMap } from "effect";
import type { Effect, Option } from "effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionThreadMessageTextSegment = Schema.Struct({
  sequence: NonNegativeInt,
  startedAt: IsoDateTime,
  endedAt: IsoDateTime,
  text: Schema.String,
});
export type ProjectionThreadMessageTextSegment = typeof ProjectionThreadMessageTextSegment.Type;

export const ProjectionThreadMessage = Schema.Struct({
  asyncUserInput: Schema.optional(AsyncUserInput),
  messageId: MessageId,
  threadId: ThreadId,
  turnId: Schema.NullOr(TurnId),
  role: OrchestrationMessageRole,
  text: Schema.String,
  textSegments: Schema.optional(Schema.Array(ProjectionThreadMessageTextSegment)),
  attachments: Schema.optional(Schema.Array(ChatAttachment)),
  skills: Schema.optional(Schema.Array(ProviderSkillReference)),
  mentions: Schema.optional(Schema.Array(ProviderMentionReference)),
  dispatchMode: Schema.optional(TurnDispatchMode),
  dispatchOrigin: Schema.optional(MessageDispatchOrigin),
  startsNewTurn: Schema.optional(Schema.Boolean),
  isStreaming: Schema.Boolean,
  source: OrchestrationMessageSource,
  /** server-owned orchestration sequence for causal ordering */
  sequence: Schema.optional(NonNegativeInt),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ProjectionThreadMessage = typeof ProjectionThreadMessage.Type;

export const ProjectionThreadMessageSegmentDbRow = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  sequence: NonNegativeInt,
  startedAt: IsoDateTime,
  endedAt: IsoDateTime,
  text: Schema.String,
  textChunks: Schema.optional(Schema.fromJsonString(Schema.Array(Schema.String))),
  encodedText: Schema.optional(Schema.NullOr(Schema.fromJsonString(Schema.String))),
});
export type ProjectionThreadMessageSegmentDbRow = typeof ProjectionThreadMessageSegmentDbRow.Type;

export const ListProjectionThreadMessagesInput = Schema.Struct({
  threadId: ThreadId,
});
export type ListProjectionThreadMessagesInput = typeof ListProjectionThreadMessagesInput.Type;

export const GetProjectionThreadMessageInput = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
});
export type GetProjectionThreadMessageInput = typeof GetProjectionThreadMessageInput.Type;

export const DeleteProjectionThreadMessagesInput = Schema.Struct({
  threadId: ThreadId,
});
export type DeleteProjectionThreadMessagesInput = typeof DeleteProjectionThreadMessagesInput.Type;

export interface ProjectionThreadMessageRepositoryShape {
  /** upserts by thread-scoped (threadId, messageId) */
  readonly upsert: (
    message: ProjectionThreadMessage,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  readonly getByThreadAndMessageId: (
    input: GetProjectionThreadMessageInput,
  ) => Effect.Effect<Option.Option<ProjectionThreadMessage>, ProjectionRepositoryError>;

  /** ascending server-owned causal order; legacy unsequenced rows keep timestamp order ahead of sequenced ones */
  readonly listByThreadId: (
    input: ListProjectionThreadMessagesInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionThreadMessage>, ProjectionRepositoryError>;

  /** last human send, excluding agent and automation dispatches */
  readonly getLatestHumanMessageAt: (
    input: ListProjectionThreadMessagesInput,
  ) => Effect.Effect<string | null, ProjectionRepositoryError>;

  /** newest user-message timestamp for sidebar summary state */
  readonly getLatestUserMessageAt: (
    input: ListProjectionThreadMessagesInput,
  ) => Effect.Effect<string | null, ProjectionRepositoryError>;

  readonly deleteByThreadId: (
    input: DeleteProjectionThreadMessagesInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class ProjectionThreadMessageRepository extends ServiceMap.Service<
  ProjectionThreadMessageRepository,
  ProjectionThreadMessageRepositoryShape
>()("synara/persistence/Services/ProjectionThreadMessages/ProjectionThreadMessageRepository") {}
