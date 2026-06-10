import {
  type AssistantDeliveryMode,
  CommandId,
  type ProviderRuntimeEvent,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { Duration } from "effect";

// FILE: ProviderRuntimeIngestion.config.ts
// Purpose: Constants and key/id builders for provider runtime ingestion.
// Layer: Server orchestration ingestion
// Exports: providerTurnKey, providerCommandId, ingestion tuning constants

export const providerTurnKey = (threadId: ThreadId, turnId: TurnId) => `${threadId}:${turnId}`;

export const providerCommandId = (event: ProviderRuntimeEvent, tag: string): CommandId =>
  CommandId.makeUnsafe(`provider:${event.eventId}:${tag}:${crypto.randomUUID()}`);

export const DEFAULT_ASSISTANT_DELIVERY_MODE: AssistantDeliveryMode = "buffered";
export const TURN_MESSAGE_IDS_BY_TURN_CACHE_CAPACITY = 10_000;
export const TURN_MESSAGE_IDS_BY_TURN_TTL = Duration.minutes(120);
export const BUFFERED_MESSAGE_TEXT_BY_MESSAGE_ID_CACHE_CAPACITY = 20_000;
export const BUFFERED_MESSAGE_TEXT_BY_MESSAGE_ID_TTL = Duration.minutes(120);
export const BUFFERED_PROPOSED_PLAN_BY_ID_CACHE_CAPACITY = 10_000;
export const BUFFERED_PROPOSED_PLAN_BY_ID_TTL = Duration.minutes(120);
export const MAX_BUFFERED_ASSISTANT_CHARS = 24_000;
export const MAX_ACTIVITY_DATA_JSON_CHARS = 16_000;
export const MAX_ACTIVITY_DATA_STRING_CHARS = 2_000;
export const MAX_ACTIVITY_DATA_ARRAY_ITEMS = 24;
export const MAX_ACTIVITY_DATA_OBJECT_KEYS = 64;
export const ACTIVITY_DATA_TRUNCATION_MARKER = "__synaraTruncated";
export const STRICT_PROVIDER_LIFECYCLE_GUARD =
  process.env.T3CODE_STRICT_PROVIDER_LIFECYCLE_GUARD !== "0";
