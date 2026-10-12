// FILE: retryWithDifferentEffort.logic.ts
// Purpose: Pure eligibility, effort filtering, and model-selection helpers for
//   "Retry with different effort" on settled assistant turns.
// Layer: Chat transcript logic
// Depends on: composer trait resolution and provider option patch helpers.

import {
  type CheckpointRef,
  type MessageId,
  type ModelSelection,
  type ProviderInstanceId,
  type ProviderKind,
  type ProviderModelDescriptor,
  type RuntimeMode,
  type TurnId,
} from "@synara/contracts";
import { resolveTailUserMessageEditTarget } from "@synara/shared/conversationEdit";
import type { RetryAttemptMetrics } from "@synara/shared/effortRetryMetrics";

import {
  buildModelSelection,
  buildNextProviderOptions,
  type ProviderOptions,
} from "../../providerModelOptions";
import type { ChatMessage, TurnDiffSummary } from "../../types";
import {
  getComposerTraitSelection,
  planComposerEffortChange,
  type ComposerEffortChangePlan,
} from "./composerTraits";

export type RetryEffortOption = {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
  readonly isDefault?: boolean;
  readonly isCurrent: boolean;
};

export type RetryWithDifferentEffortDisabledReason =
  | "not-settled"
  | "not-tail"
  | "not-approval-required"
  | "no-effort-levels"
  | "no-alternate-effort"
  | "no-checkpoint"
  | "prompt-controlled"
  | "busy"
  | "missing-user-message";

export type RetryWithDifferentEffortAvailability =
  | {
      readonly enabled: true;
      readonly userMessageId: MessageId;
      readonly userMessageText: string;
      readonly turnId: TurnId;
      readonly currentEffort: string | null;
      readonly effortOptions: ReadonlyArray<RetryEffortOption>;
      readonly checkpointTurnCount: number;
      readonly checkpointRef: CheckpointRef;
      readonly changedFileCount: number;
    }
  | {
      readonly enabled: false;
      readonly reason: RetryWithDifferentEffortDisabledReason;
      readonly detail: string;
      readonly effortOptions: ReadonlyArray<RetryEffortOption>;
      readonly currentEffort: string | null;
    };

export type RetryEffortVariant = {
  readonly id: string;
  readonly assistantMessageId: MessageId;
  readonly turnId: TurnId | null;
  readonly text: string;
  readonly effort: string | null;
  readonly effortLabel: string | null;
  readonly provider: ProviderKind;
  readonly model: string;
  readonly createdAt: string;
  readonly checkpointTurnCount: number | null;
  readonly changedFileCount: number;
  readonly metrics?: RetryAttemptMetrics | undefined;
};

export function retryEffortDisabledReasonLabel(
  reason: RetryWithDifferentEffortDisabledReason,
): string {
  switch (reason) {
    case "not-settled":
      return "Wait for the turn to finish before retrying with a different effort.";
    case "not-tail":
      return "Only the latest settled assistant turn can be retried with a different effort.";
    case "not-approval-required":
      return "Retry with different effort is available in approval-required mode.";
    case "no-effort-levels":
      return "This model does not expose alternate effort levels.";
    case "no-alternate-effort":
      return "This model only exposes the current effort level.";
    case "no-checkpoint":
      return "Retry is disabled because no pre-turn workspace checkpoint exists for this turn.";
    case "prompt-controlled":
      return "This prompt fixes the effort level. Edit the prompt to change it.";
    case "busy":
      return "Wait for the current send or checkpoint restore to finish.";
    case "missing-user-message":
      return "Could not find the user prompt that produced this turn.";
  }
}

function effectiveEffort(selection: ReturnType<typeof getComposerTraitSelection>): string | null {
  return selection.ultrathinkPromptControlled
    ? (selection.effortLevels.find((level) => selection.promptInjectedValues.includes(level.value))
        ?.value ?? selection.effort)
    : selection.effort;
}

export function resolveEffortFromModelSelection(
  modelSelection: ModelSelection | null | undefined,
  runtimeModel?: ProviderModelDescriptor,
  prompt = "",
): string | null {
  if (!modelSelection) return null;
  return effectiveEffort(
    getComposerTraitSelection(
      modelSelection.provider,
      modelSelection.model,
      prompt,
      modelSelection.options,
      runtimeModel,
    ),
  );
}

export function resolvePrecedingUserMessage(input: {
  readonly messages: ReadonlyArray<Pick<ChatMessage, "id" | "role" | "text" | "turnId">>;
  readonly assistantMessageId: MessageId;
}): { readonly messageId: MessageId; readonly text: string; readonly index: number } | null {
  const assistantIndex = input.messages.findIndex(
    (message) => message.id === input.assistantMessageId,
  );
  if (assistantIndex < 0) return null;
  for (let index = assistantIndex - 1; index >= 0; index -= 1) {
    const message = input.messages[index];
    if (!message) continue;
    if (message.role === "user") {
      return { messageId: message.id, text: message.text, index };
    }
  }
  return null;
}

export function isTerminalSettledAssistantMessage(input: {
  readonly showAssistantCopyButton: boolean;
  readonly assistantTurnInProgress: boolean | undefined;
  readonly streaming: boolean;
}): boolean {
  return input.showAssistantCopyButton && !input.assistantTurnInProgress && !input.streaming;
}

function buildEffortOptions(input: {
  readonly selection: ReturnType<typeof getComposerTraitSelection>;
  readonly currentEffort: string | null;
}): ReadonlyArray<RetryEffortOption> {
  return input.selection.effortLevels.map((level) => ({
    value: level.value,
    label: level.label,
    ...(level.description ? { description: level.description } : {}),
    ...(level.isDefault ? { isDefault: true as const } : {}),
    isCurrent: input.currentEffort !== null && level.value === input.currentEffort,
  }));
}

export function resolveRetryWithDifferentEffortAvailability(input: {
  readonly messages: ReadonlyArray<
    Pick<ChatMessage, "id" | "role" | "text" | "turnId" | "streaming">
  >;
  readonly assistantMessageId: MessageId;
  readonly assistantTurnId: TurnId | null | undefined;
  readonly showAssistantCopyButton: boolean;
  readonly assistantTurnInProgress: boolean | undefined;
  readonly runtimeMode: RuntimeMode;
  readonly modelSelection: ModelSelection;
  readonly modelOptions: ProviderOptions | null | undefined;
  readonly runtimeModel?: ProviderModelDescriptor | undefined;
  readonly turnDiffSummary: TurnDiffSummary | undefined;
  readonly activeTurnId: TurnId | null | undefined;
  readonly isBusy: boolean;
}): RetryWithDifferentEffortAvailability {
  const precedingUser = resolvePrecedingUserMessage({
    messages: input.messages,
    assistantMessageId: input.assistantMessageId,
  });
  const selection = getComposerTraitSelection(
    input.modelSelection.provider,
    input.modelSelection.model,
    precedingUser?.text ?? "",
    input.modelOptions ?? input.modelSelection.options,
    input.runtimeModel,
  );
  const currentEffort = effectiveEffort(selection);
  const effortOptions = buildEffortOptions({ selection, currentEffort });

  const disabled = (
    reason: RetryWithDifferentEffortDisabledReason,
  ): RetryWithDifferentEffortAvailability => ({
    enabled: false,
    reason,
    detail: retryEffortDisabledReasonLabel(reason),
    effortOptions,
    currentEffort,
  });

  if (input.isBusy || input.activeTurnId != null) {
    return disabled("busy");
  }

  const assistantMessage = input.messages.find(
    (message) => message.id === input.assistantMessageId,
  );
  if (
    !assistantMessage ||
    !isTerminalSettledAssistantMessage({
      showAssistantCopyButton: input.showAssistantCopyButton,
      assistantTurnInProgress: input.assistantTurnInProgress,
      streaming: assistantMessage.streaming,
    })
  ) {
    return disabled("not-settled");
  }

  if (input.runtimeMode !== "approval-required") {
    return disabled("not-approval-required");
  }

  if (!precedingUser) {
    return disabled("missing-user-message");
  }

  const editTarget = resolveTailUserMessageEditTarget({
    messages: input.messages,
    messageId: precedingUser.messageId,
    activeTurnId: input.activeTurnId ?? null,
  });
  if (!editTarget.editable) {
    return disabled("not-tail");
  }
  if (
    input.messages.findLast((message) => message.role === "assistant")?.id !==
    input.assistantMessageId
  ) {
    return disabled("not-tail");
  }

  if (effortOptions.length === 0) {
    return disabled("no-effort-levels");
  }
  if (selection.ultrathinkPromptControlled) {
    return disabled("prompt-controlled");
  }
  if (!effortOptions.some((option) => !option.isCurrent)) {
    return disabled("no-alternate-effort");
  }

  const turnId = input.assistantTurnId ?? assistantMessage.turnId;
  if (!turnId) {
    return disabled("not-settled");
  }
  const checkpointTurnCount = input.turnDiffSummary?.checkpointTurnCount;
  const checkpointRef = input.turnDiffSummary?.checkpointRef;
  if (
    typeof checkpointTurnCount !== "number" ||
    !Number.isSafeInteger(checkpointTurnCount) ||
    checkpointTurnCount < 1 ||
    typeof checkpointRef !== "string" ||
    checkpointRef.length === 0 ||
    (input.turnDiffSummary?.status !== undefined && input.turnDiffSummary.status !== "ready") ||
    input.turnDiffSummary?.turnId !== turnId ||
    (assistantMessage.turnId != null && assistantMessage.turnId !== turnId)
  ) {
    return disabled("no-checkpoint");
  }

  return {
    enabled: true,
    userMessageId: precedingUser.messageId,
    userMessageText: precedingUser.text,
    turnId,
    currentEffort,
    effortOptions,
    checkpointTurnCount,
    checkpointRef,
    changedFileCount: input.turnDiffSummary?.files.length ?? 0,
  };
}

export function planRetryEffortChange(input: {
  readonly provider: ProviderKind;
  readonly instanceId?: ProviderInstanceId | undefined;
  readonly supportsAutoMode?: boolean | undefined;
  readonly model: string;
  readonly modelOptions: ProviderOptions | null | undefined;
  readonly prompt: string;
  readonly runtimeModel?: ProviderModelDescriptor | undefined;
  readonly nextEffort: string;
}): {
  readonly effortPlan: ComposerEffortChangePlan;
  readonly nextModelSelection: ModelSelection;
  readonly nextPrompt: string;
  readonly effortLabel: string;
} | null {
  const selection = getComposerTraitSelection(
    input.provider,
    input.model,
    input.prompt,
    input.modelOptions,
    input.runtimeModel,
  );
  if (input.nextEffort === effectiveEffort(selection)) return null;
  const effortPlan = planComposerEffortChange({
    provider: input.provider,
    selection,
    prompt: input.prompt,
    value: input.nextEffort,
  });
  if (!effortPlan) return null;

  const effortLabel =
    selection.effortLevels.find((level) => level.value === input.nextEffort)?.label ??
    input.nextEffort;

  if (effortPlan.kind === "prompt") {
    return {
      effortPlan,
      nextModelSelection: buildModelSelection(
        input.provider,
        input.model,
        input.modelOptions ?? undefined,
        input.supportsAutoMode,
        { instanceId: input.instanceId },
      ),
      nextPrompt: effortPlan.prompt,
      effortLabel,
    };
  }

  const nextOptions = buildNextProviderOptions(
    input.provider,
    input.modelOptions,
    effortPlan.patch,
  );
  return {
    effortPlan,
    nextModelSelection: buildModelSelection(
      input.provider,
      input.model,
      nextOptions,
      input.supportsAutoMode,
      { instanceId: input.instanceId },
    ),
    nextPrompt: input.prompt,
    effortLabel,
  };
}

export function filterSupportedRetryEfforts(
  effortOptions: ReadonlyArray<RetryEffortOption>,
): ReadonlyArray<RetryEffortOption> {
  // getComposerTraitSelection already filters to model-supported levels; keep
  // this helper so callers never invent unsupported values.
  return effortOptions.filter((option) => option.value.trim().length > 0);
}

export function buildRetryConfirmCopy(input: {
  readonly changedFileCount: number;
  readonly checkpointTurnCount: number;
  readonly nextEffortLabel: string;
  readonly currentEffortLabel: string | null;
}): string {
  const effortLine =
    input.currentEffortLabel && input.currentEffortLabel !== input.nextEffortLabel
      ? `Retry with ${input.nextEffortLabel} effort (currently ${input.currentEffortLabel}).`
      : `Retry with ${input.nextEffortLabel} effort.`;
  if (input.changedFileCount <= 0) {
    return [
      effortLine,
      "The previous answer stays available in the variant pager.",
      `Workspace checkpoint ${Math.max(0, input.checkpointTurnCount - 1)} will be restored before the new attempt.`,
      "A pre-retry snapshot is captured so current files are not discarded silently.",
    ].join("\n");
  }
  return [
    effortLine,
    `${input.changedFileCount} file${input.changedFileCount === 1 ? "" : "s"} changed in this turn.`,
    `Workspace will restore to checkpoint ${Math.max(0, input.checkpointTurnCount - 1)} before retrying.`,
    "A pre-retry snapshot is captured so those file changes are not discarded silently.",
    "The previous answer stays available in the variant pager.",
  ].join("\n");
}

export function mergeRetryVariants(input: {
  readonly archived: ReadonlyArray<RetryEffortVariant>;
  readonly live: RetryEffortVariant | null;
}): ReadonlyArray<RetryEffortVariant> {
  if (!input.live) return input.archived;
  const withoutLive = input.archived.filter(
    (variant) => variant.assistantMessageId !== input.live!.assistantMessageId,
  );
  return [...withoutLive, input.live];
}
