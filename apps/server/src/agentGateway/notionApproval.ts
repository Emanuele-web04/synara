import {
  CommandId,
  EventId,
  ThreadId,
  TurnId,
  type NotionWriteInput,
  type OrchestrationCommand,
} from "@synara/contracts";
import { Effect, Schema } from "effect";
import { computerApprovalGate } from "../computer/ComputerApprovalGate.ts";
import type { NotionAgentToolOptions } from "./notionTools.ts";

/** Reuses Synara's existing per-call consent queue, cards and response routing. */
export function makeNotionApproval(
  dispatch: (command: OrchestrationCommand) => Effect.Effect<unknown, unknown>,
): NonNullable<NotionAgentToolOptions["approve"]> {
  return async ({ mappingName, input }, context, signal) => {
    await Effect.runPromise(context.assertCallerTurnActive());
    if (!context.callerTurnId) return false;
    const reviewed: NotionWriteInput = structuredClone(input);
    return computerApprovalGate.request({
      threadId: context.callerThreadId,
      turnId: context.callerTurnId,
      signal,
      publish: async (requestId, decision) => {
        const createdAt = new Date().toISOString();
        const key = `${requestId}:${decision === undefined ? "open" : "resolved"}`;
        await Effect.runPromise(
          dispatch({
            type: "thread.activity.append",
            commandId: CommandId.makeUnsafe(key),
            threadId: ThreadId.makeUnsafe(context.callerThreadId),
            activity: {
              id: EventId.makeUnsafe(key),
              tone: "info",
              kind: decision === undefined ? "approval.requested" : "approval.resolved",
              summary:
                decision === undefined
                  ? `Review Notion change · ${mappingName}`
                  : "Notion approval resolved",
              payload: Schema.decodeUnknownSync(Schema.Json)({
                requestId,
                requestKind: "tool",
                requestType: "tool",
                toolName: "synara_notion_write",
                toolParamsDisplay: [
                  { name: "source", displayName: "Source", value: mappingName },
                  { name: "operation", displayName: "Operation", value: reviewed.kind },
                  { name: "resourceId", displayName: "Resource", value: reviewed.id },
                  { name: "original", displayName: "Original values", value: reviewed.base },
                  { name: "proposed", displayName: "Proposed changes", value: reviewed.changes },
                ],
                sessionApprovalAvailable: false,
                ...(decision === undefined ? {} : { decision }),
              }),
              turnId: TurnId.makeUnsafe(context.callerTurnId!),
              createdAt,
            },
            createdAt,
          }),
        );
      },
    });
  };
}
