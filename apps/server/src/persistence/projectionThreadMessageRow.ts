import {
  ChatAttachment,
  MessageDispatchOrigin,
  NonNegativeInt,
  ProviderMentionReference,
  ProviderSkillReference,
  TurnDispatchMode,
  type OrchestrationMessage,
} from "@synara/contracts";
import { Schema, Struct } from "effect";
import { joinMessageTextChunks } from "./messageTextChunks.ts";

import {
  ProjectionThreadMessage,
  type ProjectionThreadMessage as ProjectionThreadMessageRecord,
} from "./Services/ProjectionThreadMessages.ts";

export const ProjectionThreadMessageDbRowSchema = ProjectionThreadMessage.mapFields(
  Struct.assign({
    isStreaming: Schema.Number,
    textChunks: Schema.optional(Schema.fromJsonString(Schema.Array(Schema.String))),
    encodedText: Schema.optional(Schema.NullOr(Schema.fromJsonString(Schema.String))),
    attachments: Schema.NullOr(Schema.fromJsonString(Schema.Array(ChatAttachment))),
    skills: Schema.NullOr(Schema.fromJsonString(Schema.Array(ProviderSkillReference))),
    mentions: Schema.NullOr(Schema.fromJsonString(Schema.Array(ProviderMentionReference))),
    dispatchMode: Schema.NullOr(TurnDispatchMode),
    dispatchOrigin: Schema.NullOr(MessageDispatchOrigin),
    startsNewTurn: Schema.NullOr(Schema.Number),
    sequence: Schema.NullOr(NonNegativeInt),
  }),
);

export type ProjectionThreadMessageDbRow = Schema.Schema.Type<
  typeof ProjectionThreadMessageDbRowSchema
>;

export function orchestrationMessageFromStoredMessage(
  row: ProjectionThreadMessageRecord,
): OrchestrationMessage {
  const { messageId, isStreaming, sequence: _sequence, ...fields } = row;
  return { ...fields, id: messageId, streaming: isStreaming };
}

export function projectionThreadMessageFromRow(
  row: ProjectionThreadMessageDbRow,
): ProjectionThreadMessageRecord {
  return {
    messageId: row.messageId,
    threadId: row.threadId,
    turnId: row.turnId,
    role: row.role,
    text: joinMessageTextChunks(row),
    ...(row.textSegments !== undefined ? { textSegments: row.textSegments } : {}),
    isStreaming: row.isStreaming === 1,
    source: row.source,
    ...(row.sequence !== null ? { sequence: row.sequence } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(row.attachments !== null ? { attachments: row.attachments } : {}),
    ...(row.skills !== null ? { skills: row.skills } : {}),
    ...(row.mentions !== null ? { mentions: row.mentions } : {}),
    ...(row.dispatchMode ? { dispatchMode: row.dispatchMode } : {}),
    ...(row.dispatchOrigin ? { dispatchOrigin: row.dispatchOrigin } : {}),
    ...(row.startsNewTurn !== null ? { startsNewTurn: row.startsNewTurn === 1 } : {}),
  };
}

export function orchestrationMessageFromProjectionRow(
  row: ProjectionThreadMessageDbRow,
): OrchestrationMessage {
  return {
    id: row.messageId,
    role: row.role,
    text: joinMessageTextChunks(row),
    ...(row.textSegments !== undefined ? { textSegments: row.textSegments } : {}),
    ...(row.attachments !== null ? { attachments: row.attachments } : {}),
    ...(row.skills !== null ? { skills: row.skills } : {}),
    ...(row.mentions !== null ? { mentions: row.mentions } : {}),
    ...(row.dispatchMode ? { dispatchMode: row.dispatchMode } : {}),
    ...(row.dispatchOrigin ? { dispatchOrigin: row.dispatchOrigin } : {}),
    ...(row.startsNewTurn !== null ? { startsNewTurn: row.startsNewTurn === 1 } : {}),
    turnId: row.turnId,
    streaming: row.isStreaming === 1,
    source: row.source,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
