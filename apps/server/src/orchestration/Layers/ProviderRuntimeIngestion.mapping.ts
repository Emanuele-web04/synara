import { type ProviderRuntimeEvent, ThreadId, TurnId } from "@t3tools/contracts";
import {
  buildSubagentIdentityDirectory,
  extractSubagentIdentityHints,
  resolveSubagentIdentityFromDirectory,
} from "@t3tools/shared/subagents";

import {
  asObject,
  runtimePayloadRecord,
  toTurnId,
} from "./ProviderRuntimeIngestion.mapping.normalize.ts";
import type { SubagentIdentity } from "./ProviderRuntimeIngestion.types.ts";

// FILE: ProviderRuntimeIngestion.mapping.ts
// Purpose: Subagent-identity and proposed-plan id helpers, plus the stable public
//   re-export surface for the normalize and activities mapping sub-modules.
// Layer: Server orchestration ingestion
// Exports: subagent/plan helpers consumed by the ingestion projection, re-exported normalizers + activity mappers.

export {
  asObject,
  asPositiveFiniteNumber,
  asString,
  inferRuntimeModeFromUserInputAnswers,
  normalizeIdentifier,
  normalizeRuntimeTurnState,
  orchestrationSessionStatusFromRuntimeState,
  requestKindFromCanonicalRequestType,
  resolveTerminalTurnId,
  runtimeErrorMessageFromEvent,
  runtimePayloadRecord,
  runtimeTurnErrorMessage,
  runtimeTurnState,
  sameId,
  toActivityPayload,
  toApprovalRequestId,
  toTurnId,
  truncateDetail,
} from "./ProviderRuntimeIngestion.mapping.normalize.ts";

export {
  activityDataField,
  activityPayloadKeyRank,
  boundActivityData,
  buildConfiguredContextWindowPayload,
  buildContextWindowActivityPayload,
  buildToolProgressActivityPayload,
  isJsonObject,
  runtimeEventToActivities,
  runtimeWarningActivityCopy,
  stringifyJsonLike,
  truncateJsonString,
  truncateJsonValue,
} from "./ProviderRuntimeIngestion.mapping.activities.ts";

export function normalizeProposedPlanMarkdown(
  planMarkdown: string | undefined,
): string | undefined {
  const trimmed = planMarkdown?.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed;
}

export function hasRenderableAssistantText(text: string | undefined): boolean {
  return (text?.trim().length ?? 0) > 0;
}

export function proposedPlanIdForTurn(threadId: ThreadId, turnId: TurnId): string {
  return `plan:${threadId}:turn:${turnId}`;
}

export function proposedPlanIdFromEvent(event: ProviderRuntimeEvent, threadId: ThreadId): string {
  const turnId = toTurnId(event.turnId);
  if (turnId) {
    return proposedPlanIdForTurn(threadId, turnId);
  }
  if (event.itemId) {
    return `plan:${threadId}:item:${event.itemId}`;
  }
  return `plan:${threadId}:event:${event.eventId}`;
}

export function subagentThreadId(parentThreadId: ThreadId, providerThreadId: string): ThreadId {
  return ThreadId.makeUnsafe(`subagent:${parentThreadId}:${providerThreadId}`);
}

export function extractCollabPayload(
  event: ProviderRuntimeEvent,
): Record<string, unknown> | undefined {
  const payload = runtimePayloadRecord(event);
  return asObject(payload?.data);
}

export function extractSubagentIdentity(
  event: ProviderRuntimeEvent,
  providerThreadId: string,
): SubagentIdentity | undefined {
  const collabPayload = extractCollabPayload(event);
  const item = asObject(collabPayload?.item) ?? collabPayload;
  if (!item) {
    return undefined;
  }
  return resolveSubagentIdentityFromDirectory(
    buildSubagentIdentityDirectory(extractSubagentIdentityHints(item)),
    {
      providerThreadId,
    },
  ) as SubagentIdentity | undefined;
}

export function subagentThreadTitle(identity: {
  nickname?: string | undefined;
  role?: string | undefined;
  providerThreadId?: string | undefined;
}): string {
  if (identity.nickname && identity.role) {
    return `${identity.nickname} [${identity.role}]`;
  }
  if (identity.nickname) {
    return identity.nickname;
  }
  if (identity.role) {
    return `Subagent [${identity.role}]`;
  }
  return identity.providerThreadId ? `Subagent ${identity.providerThreadId}` : "Subagent";
}
