import {
  ModelSelection,
  MessageId,
  ProviderKind,
  TurnId,
  type OrchestrationThreadActivity,
  type ProviderModelDescriptor,
} from "@synara/contracts";
import { Option, Schema } from "effect";
import { parseRetryAttemptMetrics } from "@synara/shared/effortRetryMetrics";

import {
  resolveEffortFromModelSelection,
  type RetryEffortVariant,
} from "./retryWithDifferentEffort.logic";

type Receipt = {
  readonly activity: OrchestrationThreadActivity;
  readonly sourcePrompt: string;
  readonly retryPrompt: string;
  readonly variant: RetryEffortVariant;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Receipts survive projection rollback and make prior attempts readable on another client. */
export function resolveDurableRetryEffortVariants(input: {
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
  readonly userMessageId: MessageId | null;
  readonly userMessageText: string;
  readonly runtimeModel?: ProviderModelDescriptor | undefined;
}): ReadonlyArray<RetryEffortVariant> {
  if (input.userMessageId === null) return [];
  const receipts: Receipt[] = [];
  for (const activity of input.activities) {
    const payload = activity.payload;
    if (
      activity.kind !== "turn.effort-retry.snapshot" ||
      !isRecord(payload) ||
      payload.userMessageId !== input.userMessageId ||
      typeof payload.sourceUserMessageText !== "string" ||
      typeof payload.retryUserMessageText !== "string" ||
      !isRecord(payload.sourceModelSelection) ||
      !Schema.is(ProviderKind)(payload.sourceModelSelection.provider) ||
      typeof payload.sourceModelSelection.model !== "string" ||
      payload.sourceModelSelection.model.trim().length === 0 ||
      typeof payload.assistantMessageId !== "string" ||
      payload.assistantMessageId.length === 0 ||
      typeof payload.assistantMessageText !== "string" ||
      typeof payload.assistantMessageCreatedAt !== "string" ||
      !Number.isFinite(Date.parse(payload.assistantMessageCreatedAt)) ||
      typeof payload.sourceTurnId !== "string" ||
      payload.sourceTurnId.length === 0
    )
      continue;
    const selection = Schema.decodeUnknownOption(ModelSelection)(payload.sourceModelSelection);
    if (Option.isNone(selection)) continue;
    const effort = resolveEffortFromModelSelection(
      selection.value,
      input.runtimeModel?.slug === selection.value.model ? input.runtimeModel : undefined,
      payload.sourceUserMessageText,
    );
    receipts.push({
      activity,
      sourcePrompt: payload.sourceUserMessageText,
      retryPrompt: payload.retryUserMessageText,
      variant: {
        id: activity.id,
        assistantMessageId: MessageId.makeUnsafe(payload.assistantMessageId),
        turnId: TurnId.makeUnsafe(payload.sourceTurnId),
        text: payload.assistantMessageText,
        effort,
        effortLabel: effort,
        provider: selection.value.provider,
        model: selection.value.model,
        createdAt: payload.assistantMessageCreatedAt,
        checkpointTurnCount:
          typeof payload.checkpointTurnCount === "number" &&
          Number.isSafeInteger(payload.checkpointTurnCount) &&
          payload.checkpointTurnCount >= 1
            ? payload.checkpointTurnCount
            : null,
        changedFileCount: 0,
        metrics: parseRetryAttemptMetrics(payload.sourceMetrics),
      },
    });
  }
  receipts.sort(
    (left, right) =>
      (left.activity.sequence ?? 0) - (right.activity.sequence ?? 0) ||
      left.activity.createdAt.localeCompare(right.activity.createdAt),
  );
  // A prompt-injected effort can add the canonical Ultrathink prefix. Walk
  // valid recorded transitions backwards; unrelated ordinary edits never join.
  const matchingPrompts = new Set([input.userMessageText]);
  const variants: RetryEffortVariant[] = [];
  for (const receipt of receipts.toReversed()) {
    if (!matchingPrompts.has(receipt.retryPrompt)) continue;
    matchingPrompts.add(receipt.sourcePrompt);
    variants.push(receipt.variant);
  }
  return variants.toReversed();
}

export function mergeArchivedRetryEffortVariants(input: {
  readonly durable: ReadonlyArray<RetryEffortVariant>;
  readonly local: ReadonlyArray<RetryEffortVariant>;
}): ReadonlyArray<RetryEffortVariant> {
  const byMessage = new Map<MessageId, RetryEffortVariant>();
  for (const variant of [...input.durable, ...input.local]) {
    byMessage.set(variant.assistantMessageId, variant);
  }
  return Array.from(byMessage.values()).toSorted((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  );
}
