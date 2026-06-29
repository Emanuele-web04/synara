import {
  ProviderItemId,
  RuntimeItemId,
  type OrchestrationProviderItem,
  type OrchestrationProviderItemContentPart,
  type ProviderRuntimeEvent,
  type RuntimeContentStreamKind,
  type RuntimeItemStatus,
  type TurnId,
} from "@t3tools/contracts";
import { Option, Schema } from "effect";

import {
  asObject,
  asString,
  runtimeErrorMessageFromEvent,
  runtimePayloadRecord,
  runtimeTurnState,
  runtimeTurnErrorMessage,
} from "./ProviderRuntimeIngestion.mapping.normalize.ts";

type JsonValue = typeof Schema.Json.Type;

function toJsonValue(value: unknown): JsonValue | null {
  if (value === undefined) {
    return null;
  }
  return Option.getOrNull(Schema.decodeUnknownOption(Schema.Json)(value));
}

function toNullableItemId(event: ProviderRuntimeEvent): ProviderItemId | null {
  if (event.providerRefs?.providerItemId !== undefined) {
    return event.providerRefs.providerItemId;
  }
  return event.itemId === undefined ? null : ProviderItemId.makeUnsafe(event.itemId);
}

function nonNegativeOrNull(value: number | undefined): number | null {
  if (value === undefined || !Number.isInteger(value) || value < 0) {
    return null;
  }
  return value;
}

function fallbackItemIdForEvent(event: ProviderRuntimeEvent): RuntimeItemId {
  const turnSegment = event.turnId ?? "turnless";
  switch (event.type) {
    case "content.delta": {
      const payload = runtimePayloadRecord(event);
      return RuntimeItemId.makeUnsafe(
        `provider-item:${event.threadId}:${turnSegment}:${asString(payload?.streamKind) ?? "unknown"}:${
          payload?.contentIndex ?? payload?.summaryIndex ?? event.eventId
        }`,
      );
    }
    case "turn.proposed.delta":
    case "turn.proposed.completed":
      return RuntimeItemId.makeUnsafe(`provider-item:${event.threadId}:${turnSegment}:plan`);
    case "turn.diff.updated":
      return RuntimeItemId.makeUnsafe(`provider-item:${event.threadId}:${turnSegment}:diff`);
    case "mcp.status.updated": {
      const status = asObject(event.payload.status);
      const name = asString(status?.name) ?? asString(status?.server) ?? event.eventId;
      return RuntimeItemId.makeUnsafe(`provider-item:${event.threadId}:mcp:${name}`);
    }
    case "mcp.oauth.completed": {
      const name = event.payload.name ?? event.eventId;
      return RuntimeItemId.makeUnsafe(`provider-item:${event.threadId}:mcp-oauth:${name}`);
    }
    default:
      return RuntimeItemId.makeUnsafe(`provider-item:${event.threadId}:${event.eventId}`);
  }
}

export function providerItemIdFromRuntimeEvent(event: ProviderRuntimeEvent): RuntimeItemId {
  if (event.itemId !== undefined) {
    return event.itemId;
  }
  if (event.providerRefs?.providerItemId !== undefined) {
    return RuntimeItemId.makeUnsafe(event.providerRefs.providerItemId);
  }
  return event.sourceRef?.itemId ?? fallbackItemIdForEvent(event);
}

function itemTypeForContentStream(
  streamKind: RuntimeContentStreamKind,
  existing: OrchestrationProviderItem | undefined,
): OrchestrationProviderItem["itemType"] {
  switch (streamKind) {
    case "assistant_text":
      return "assistant_message";
    case "reasoning_text":
    case "reasoning_summary_text":
      return "reasoning";
    case "plan_text":
      return "plan";
    case "command_output":
      return "command_execution";
    case "file_change_output":
      return "file_change";
    case "unknown":
      return existing?.itemType ?? "unknown";
  }
}

function runtimeContentStreamKind(value: unknown): RuntimeContentStreamKind | undefined {
  switch (value) {
    case "assistant_text":
    case "reasoning_text":
    case "reasoning_summary_text":
    case "plan_text":
    case "command_output":
    case "file_change_output":
    case "unknown":
      return value;
    default:
      return undefined;
  }
}

function runtimeItemStatus(value: unknown): RuntimeItemStatus | undefined {
  switch (value) {
    case "inProgress":
    case "completed":
    case "failed":
    case "declined":
      return value;
    case "in_progress":
      return "inProgress";
    default:
      return undefined;
  }
}

function upsertContentPart(input: {
  readonly existing: OrchestrationProviderItem | undefined;
  readonly streamKind: RuntimeContentStreamKind;
  readonly delta: string;
  readonly contentIndex: number | undefined;
  readonly summaryIndex: number | undefined;
  readonly updatedAt: string;
}): ReadonlyArray<OrchestrationProviderItemContentPart> {
  const contentIndex = nonNegativeOrNull(input.contentIndex);
  const summaryIndex = nonNegativeOrNull(input.summaryIndex);
  const existingParts = input.existing?.content ?? [];
  let matched = false;
  const nextParts = existingParts.map((part) => {
    if (
      part.streamKind !== input.streamKind ||
      part.contentIndex !== contentIndex ||
      part.summaryIndex !== summaryIndex
    ) {
      return part;
    }
    matched = true;
    return {
      ...part,
      text: `${part.text}${input.delta}`,
      updatedAt: input.updatedAt,
    };
  });
  if (matched) {
    return nextParts;
  }
  return [
    ...nextParts,
    {
      streamKind: input.streamKind,
      text: input.delta,
      contentIndex,
      summaryIndex,
      updatedAt: input.updatedAt,
    },
  ];
}

export function providerItemFromRuntimeEvent(input: {
  readonly event: ProviderRuntimeEvent;
  readonly existing: OrchestrationProviderItem | undefined;
  readonly turnId: TurnId | null;
  readonly createdAt: string;
}): OrchestrationProviderItem | undefined {
  const { event, existing } = input;
  const id = providerItemIdFromRuntimeEvent(event);
  const base = {
    id,
    providerItemId: toNullableItemId(event) ?? existing?.providerItemId ?? null,
    provider: event.provider,
    turnId: input.turnId ?? existing?.turnId ?? null,
    sourceRef: event.sourceRef ?? existing?.sourceRef ?? null,
    createdAt: existing?.createdAt ?? input.createdAt,
    updatedAt: input.createdAt,
  } as const;

  switch (event.type) {
    case "item.started":
    case "item.updated":
    case "item.completed": {
      const status =
        runtimeItemStatus(event.payload.status) ??
        (event.type === "item.completed" ? "completed" : (existing?.status ?? "inProgress"));
      return {
        ...base,
        itemType: event.payload.itemType,
        status,
        title: event.payload.title ?? existing?.title ?? null,
        detail: event.payload.detail ?? existing?.detail ?? null,
        data:
          event.payload.data !== undefined
            ? toJsonValue(event.payload.data)
            : (existing?.data ?? null),
        content: existing?.content ?? [],
      };
    }

    case "content.delta": {
      const payload = runtimePayloadRecord(event);
      const delta = asString(payload?.delta);
      const streamKind = runtimeContentStreamKind(payload?.streamKind);
      if (delta === undefined || streamKind === undefined) {
        return undefined;
      }
      return {
        ...base,
        itemType: itemTypeForContentStream(streamKind, existing),
        status: existing?.status ?? "inProgress",
        title: existing?.title ?? null,
        detail: existing?.detail ?? null,
        data: existing?.data ?? null,
        content: upsertContentPart({
          existing,
          streamKind,
          delta,
          contentIndex:
            typeof payload?.contentIndex === "number" ? payload.contentIndex : undefined,
          summaryIndex:
            typeof payload?.summaryIndex === "number" ? payload.summaryIndex : undefined,
          updatedAt: input.createdAt,
        }),
      };
    }

    case "turn.proposed.delta":
      return {
        ...base,
        itemType: "plan",
        status: existing?.status ?? "inProgress",
        title: existing?.title ?? "Proposed plan",
        detail: existing?.detail ?? null,
        data: existing?.data ?? null,
        content: upsertContentPart({
          existing,
          streamKind: "plan_text",
          delta: event.payload.delta,
          contentIndex: undefined,
          summaryIndex: undefined,
          updatedAt: input.createdAt,
        }),
      };

    case "turn.proposed.completed":
      return {
        ...base,
        itemType: "plan",
        status: "completed",
        title: existing?.title ?? "Proposed plan",
        detail: event.payload.planMarkdown,
        data: existing?.data ?? null,
        content:
          existing?.content.length === 0
            ? upsertContentPart({
                existing,
                streamKind: "plan_text",
                delta: event.payload.planMarkdown,
                contentIndex: undefined,
                summaryIndex: undefined,
                updatedAt: input.createdAt,
              })
            : (existing?.content ?? []),
      };

    case "turn.diff.updated":
      return {
        ...base,
        itemType: "file_change",
        status: existing?.status ?? "inProgress",
        title: existing?.title ?? "Code changes",
        detail: existing?.detail ?? null,
        data: toJsonValue({ unifiedDiff: event.payload.unifiedDiff }),
        content: existing?.content ?? [],
      };

    case "tool.progress":
      return {
        ...base,
        itemType: "mcp_tool_call",
        status: "inProgress",
        title: event.payload.toolName ?? existing?.title ?? "Tool call",
        detail: event.payload.summary ?? existing?.detail ?? null,
        data: toJsonValue(event.payload),
        content: existing?.content ?? [],
      };

    case "mcp.status.updated":
      return {
        ...base,
        itemType: "mcp_tool_call",
        status: existing?.status ?? "inProgress",
        title: existing?.title ?? "MCP server status",
        detail: existing?.detail ?? null,
        data: toJsonValue(event.payload.status),
        content: existing?.content ?? [],
      };

    case "mcp.oauth.completed":
      return {
        ...base,
        itemType: "mcp_tool_call",
        status: event.payload.success ? "completed" : "failed",
        title: event.payload.name ?? existing?.title ?? "MCP OAuth",
        detail: event.payload.error ?? existing?.detail ?? null,
        data: toJsonValue(event.payload),
        content: existing?.content ?? [],
      };

    case "runtime.error": {
      const message = runtimeErrorMessageFromEvent(event) ?? "Provider runtime error";
      return {
        ...base,
        itemType: "error",
        status: "failed",
        title: "Provider runtime error",
        detail: message,
        data: toJsonValue(runtimePayloadRecord(event)),
        content: existing?.content ?? [],
      };
    }

    case "turn.completed": {
      if (event.payload === undefined) {
        return undefined;
      }
      const state = runtimeTurnState(event);
      if (state !== "failed" && state !== "cancelled" && state !== "interrupted") {
        return undefined;
      }
      return {
        ...base,
        itemType: "error",
        status: state === "cancelled" || state === "interrupted" ? "declined" : "failed",
        title:
          state === "cancelled"
            ? "Turn cancelled"
            : state === "interrupted"
              ? "Turn interrupted"
              : "Turn failed",
        detail: runtimeTurnErrorMessage(event) ?? event.payload.stopReason ?? null,
        data: toJsonValue(event.payload),
        content: existing?.content ?? [],
      };
    }

    case "turn.aborted": {
      const payload = runtimePayloadRecord(event);
      return {
        ...base,
        itemType: "error",
        status: "declined",
        title: "Turn interrupted",
        detail: asString(payload?.reason) ?? null,
        data: toJsonValue(payload),
        content: existing?.content ?? [],
      };
    }

    default:
      return undefined;
  }
}
