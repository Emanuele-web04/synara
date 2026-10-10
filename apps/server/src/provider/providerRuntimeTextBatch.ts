import type { ProviderRuntimeEvent } from "@synara/contracts";
import { isDeepStrictEqual } from "node:util";

export const PROVIDER_RUNTIME_TEXT_BATCH_WINDOW_MS = 25;
export const PROVIDER_RUNTIME_TEXT_BATCH_MAX_BYTES = 32 * 1024;
export const PROVIDER_RUNTIME_TEXT_BATCH_MAX_EVENTS = 256;

type TextEvent = Extract<ProviderRuntimeEvent, { readonly type: "content.delta" }>;

const EVENT_KEYS = new Set([
  "type",
  "eventId",
  "provider",
  "providerInstanceId",
  "threadId",
  "createdAt",
  "turnId",
  "parentTurnId",
  "itemId",
  "requestId",
  "lifecycleGeneration",
  "providerRefs",
  "raw",
  "payload",
]);
const PAYLOAD_KEYS = new Set(["streamKind", "delta", "contentIndex", "summaryIndex"]);
const REF_KEYS = new Set([
  "providerThreadId",
  "providerParentThreadId",
  "providerTurnId",
  "parentProviderTurnId",
  "providerItemId",
  "providerRequestId",
]);
const RAW_KEYS = new Set(["source", "method", "messageType", "payload"]);
const knownKeys = (value: object, allowed: ReadonlySet<string>) =>
  Object.keys(value).every((key) => allowed.has(key));
const emptyPlainRecord = (value: unknown) => {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return (
    (prototype === Object.prototype || prototype === null) && Reflect.ownKeys(value).length === 0
  );
};

/** Unknown metadata can encode ordering/segmentation semantics: never discard it. */
export function isBatchableAssistantText(event: ProviderRuntimeEvent): event is TextEvent {
  return (
    event.type === "content.delta" &&
    event.payload.streamKind === "assistant_text" &&
    event.turnId !== undefined &&
    knownKeys(event, EVENT_KEYS) &&
    knownKeys(event.payload, PAYLOAD_KEYS) &&
    (event.providerRefs === undefined || knownKeys(event.providerRefs, REF_KEYS)) &&
    (event.raw === undefined ||
      (knownKeys(event.raw, RAW_KEYS) && emptyPlainRecord(event.raw.payload)))
  );
}

export function compatibleAssistantText(
  first: TextEvent,
  next: ProviderRuntimeEvent,
): next is TextEvent {
  if (!isBatchableAssistantText(next) || first.eventId === next.eventId) return false;
  const { eventId: _firstId, createdAt: _firstAt, payload: firstPayload, ...firstEnvelope } = first;
  const { eventId: _nextId, createdAt: _nextAt, payload: nextPayload, ...nextEnvelope } = next;
  const { delta: _firstDelta, ...firstIndices } = firstPayload;
  const { delta: _nextDelta, ...nextIndices } = nextPayload;
  return (
    isDeepStrictEqual(firstEnvelope, nextEnvelope) && isDeepStrictEqual(firstIndices, nextIndices)
  );
}
