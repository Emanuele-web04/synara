// FILE: AssistantRetryEffortControls.tsx
// Purpose: Settled-assistant effort-retry controls and variant-aware message text.
// Layer: Chat transcript presentation
// Depends on: retry effort logic/action components and composer trait resolution.

import {
  type MessageId,
  type ModelSelection,
  type OrchestrationThreadActivity,
  type ProviderModelDescriptor,
  type RuntimeMode,
  type ThreadId,
  type TurnId,
} from "@synara/contracts";
import type { ComponentProps, ReactNode } from "react";
import { deriveRetryAttemptMetrics } from "@synara/shared/effortRetryMetrics";

import type { ProviderOptions } from "../../providerModelOptions";
import type { ChatMessage, TurnDiffSummary } from "../../types";
import ChatMarkdown from "../ChatMarkdown";
import { MessageCopyButton } from "./MessageCopyButton";
import {
  RetryEffortVariantPager,
  RetryWithDifferentEffortAction,
  useDisplayedRetryVariantText,
} from "./RetryWithDifferentEffortAction";
import {
  resolveEffortFromModelSelection,
  resolvePrecedingUserMessage,
  resolveRetryWithDifferentEffortAvailability,
  type RetryEffortVariant,
} from "./retryWithDifferentEffort.logic";
import { getComposerTraitSelection } from "./composerTraits";
import { resolveDurableRetryEffortVariants } from "./retryEffortArchive";

export type AssistantRetryEffortContext = {
  readonly threadId: ThreadId;
  readonly messages: ReadonlyArray<
    Pick<ChatMessage, "id" | "role" | "text" | "turnId" | "streaming">
  >;
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
  readonly runtimeMode: RuntimeMode;
  readonly modelSelection: ModelSelection;
  readonly modelOptions: ProviderOptions | null | undefined;
  readonly runtimeModel?: ProviderModelDescriptor | undefined;
  readonly activeTurnId: TurnId | null | undefined;
  readonly isBusy: boolean;
  readonly onRetryWithEffort: (assistantMessageId: MessageId, effort: string) => void;
};

function buildLiveVariant(input: {
  readonly message: Pick<ChatMessage, "id" | "text" | "turnId" | "createdAt">;
  readonly modelSelection: ModelSelection;
  readonly modelOptions: ProviderOptions | null | undefined;
  readonly runtimeModel?: ProviderModelDescriptor | undefined;
  readonly prompt: string;
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
  readonly turnDiffSummary: TurnDiffSummary | undefined;
}): RetryEffortVariant {
  const effort = resolveEffortFromModelSelection(
    input.modelSelection,
    input.runtimeModel,
    input.prompt,
  );
  const trait = getComposerTraitSelection(
    input.modelSelection.provider,
    input.modelSelection.model,
    input.prompt,
    input.modelOptions,
    input.runtimeModel,
  );
  const effortLabel = effort
    ? (trait.effortLevels.find((level) => level.value === effort)?.label ?? effort)
    : null;
  return {
    id: `live:${input.message.id}`,
    assistantMessageId: input.message.id,
    turnId: input.message.turnId ?? null,
    text: input.message.text,
    effort,
    effortLabel,
    provider: input.modelSelection.provider,
    model: input.modelSelection.model,
    createdAt: input.message.createdAt,
    checkpointTurnCount: input.turnDiffSummary?.checkpointTurnCount ?? null,
    changedFileCount: input.turnDiffSummary?.files.length ?? 0,
    metrics: deriveRetryAttemptMetrics(input.activities, input.message.turnId),
  };
}

export function AssistantRetryEffortMessageText(props: {
  readonly context: AssistantRetryEffortContext;
  readonly message: Pick<ChatMessage, "id" | "text" | "turnId" | "createdAt" | "streaming">;
  readonly liveText: string;
  readonly turnDiffSummary: TurnDiffSummary | undefined;
  readonly markdownProps: ComponentProps<typeof ChatMarkdown>;
}): ReactNode {
  const precedingUser = resolvePrecedingUserMessage({
    messages: props.context.messages,
    assistantMessageId: props.message.id,
  });
  const durableVariants = resolveDurableRetryEffortVariants({
    activities: props.context.activities,
    userMessageId: precedingUser?.messageId ?? null,
    userMessageText: precedingUser?.text ?? "",
    runtimeModel: props.context.runtimeModel,
  });
  const live = buildLiveVariant({
    message: props.message,
    modelSelection: props.context.modelSelection,
    modelOptions: props.context.modelOptions,
    runtimeModel: props.context.runtimeModel,
    prompt: precedingUser?.text ?? "",
    activities: props.context.activities,
    turnDiffSummary: props.turnDiffSummary,
  });
  const displayedText = useDisplayedRetryVariantText({
    threadId: props.context.threadId,
    userMessageId: precedingUser?.messageId ?? null,
    userMessageText: precedingUser?.text ?? "",
    live,
    durableVariants,
    liveText: props.liveText,
  });
  return <ChatMarkdown {...props.markdownProps} text={displayedText} />;
}

export function AssistantRetryEffortCopyButton(props: {
  readonly context: AssistantRetryEffortContext;
  readonly message: Pick<ChatMessage, "id" | "text" | "turnId" | "createdAt" | "streaming">;
  readonly liveText: string;
  readonly turnDiffSummary: TurnDiffSummary | undefined;
}): ReactNode {
  const precedingUser = resolvePrecedingUserMessage({
    messages: props.context.messages,
    assistantMessageId: props.message.id,
  });
  const durableVariants = resolveDurableRetryEffortVariants({
    activities: props.context.activities,
    userMessageId: precedingUser?.messageId ?? null,
    userMessageText: precedingUser?.text ?? "",
    runtimeModel: props.context.runtimeModel,
  });
  const live = buildLiveVariant({
    message: props.message,
    modelSelection: props.context.modelSelection,
    modelOptions: props.context.modelOptions,
    runtimeModel: props.context.runtimeModel,
    prompt: precedingUser?.text ?? "",
    activities: props.context.activities,
    turnDiffSummary: props.turnDiffSummary,
  });
  const text = useDisplayedRetryVariantText({
    threadId: props.context.threadId,
    userMessageId: precedingUser?.messageId ?? null,
    userMessageText: precedingUser?.text ?? "",
    live,
    durableVariants,
    liveText: props.liveText,
  });
  return <MessageCopyButton text={text} />;
}

export function AssistantRetryEffortFooterActions(props: {
  readonly context: AssistantRetryEffortContext;
  readonly message: Pick<ChatMessage, "id" | "text" | "turnId" | "createdAt" | "streaming">;
  readonly showAssistantCopyButton: boolean;
  readonly assistantTurnInProgress: boolean | undefined;
  readonly turnDiffSummary: TurnDiffSummary | undefined;
}): ReactNode {
  const availability = resolveRetryWithDifferentEffortAvailability({
    messages: props.context.messages,
    assistantMessageId: props.message.id,
    assistantTurnId: props.message.turnId,
    showAssistantCopyButton: props.showAssistantCopyButton,
    assistantTurnInProgress: props.assistantTurnInProgress,
    runtimeMode: props.context.runtimeMode,
    modelSelection: props.context.modelSelection,
    modelOptions: props.context.modelOptions,
    ...(props.context.runtimeModel ? { runtimeModel: props.context.runtimeModel } : {}),
    turnDiffSummary: props.turnDiffSummary,
    activeTurnId: props.context.activeTurnId,
    isBusy: props.context.isBusy,
  });

  const precedingUser = resolvePrecedingUserMessage({
    messages: props.context.messages,
    assistantMessageId: props.message.id,
  });
  const durableVariants = resolveDurableRetryEffortVariants({
    activities: props.context.activities,
    userMessageId: precedingUser?.messageId ?? null,
    userMessageText: precedingUser?.text ?? "",
    runtimeModel: props.context.runtimeModel,
  });
  const live = buildLiveVariant({
    message: props.message,
    modelSelection: props.context.modelSelection,
    modelOptions: props.context.modelOptions,
    runtimeModel: props.context.runtimeModel,
    prompt: precedingUser?.text ?? "",
    activities: props.context.activities,
    turnDiffSummary: props.turnDiffSummary,
  });

  return (
    <>
      {precedingUser ? (
        <RetryEffortVariantPager
          threadId={props.context.threadId}
          userMessageId={precedingUser.messageId}
          userMessageText={precedingUser.text}
          live={live}
          durableVariants={durableVariants}
        />
      ) : null}
      <RetryWithDifferentEffortAction
        threadId={props.context.threadId}
        availability={availability}
        onRetryWithEffort={(effort) => props.context.onRetryWithEffort(props.message.id, effort)}
      />
    </>
  );
}
