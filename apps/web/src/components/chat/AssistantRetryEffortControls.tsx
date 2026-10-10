// FILE: AssistantRetryEffortControls.tsx
// Purpose: Settled-assistant effort-retry controls and variant-aware message text.
// Layer: Chat transcript presentation
// Depends on: retry effort logic/action components and composer trait resolution.

import { type MessageId, type RuntimeMode, type ThreadId, type TurnId } from "@synara/contracts";
import type { ComponentProps, ReactNode } from "react";

import type { ChatMessage, TurnDiffSummary } from "../../types";
import ChatMarkdown from "../ChatMarkdown";
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
  type VerifiedRetryEffortTarget,
} from "./retryWithDifferentEffort.logic";
import { getComposerTraitSelection } from "./composerTraits";
import { rewriteThreadIdsAsMarkdownLinks } from "./project/projectPanel.logic";

export type AssistantRetryEffortContext = {
  readonly threadId: ThreadId;
  readonly messages: ReadonlyArray<
    Pick<ChatMessage, "id" | "role" | "text" | "turnId" | "streaming">
  >;
  readonly runtimeMode: RuntimeMode;
  readonly retryTarget: VerifiedRetryEffortTarget | null;
  readonly activeTurnId: TurnId | null | undefined;
  readonly isBusy: boolean;
  readonly onRetryWithEffort: (assistantMessageId: MessageId, effort: string) => void;
};

function buildLiveVariant(input: {
  readonly message: Pick<ChatMessage, "id" | "text" | "turnId" | "createdAt">;
  readonly retryTarget: VerifiedRetryEffortTarget | null;
  readonly prompt: string;
  readonly turnDiffSummary: TurnDiffSummary | undefined;
}): RetryEffortVariant {
  const target =
    input.retryTarget?.assistantMessageId === input.message.id &&
    input.retryTarget.turnId === input.message.turnId
      ? input.retryTarget
      : null;
  const modelSelection = target?.modelSelection;
  const effort = resolveEffortFromModelSelection(modelSelection, {
    prompt: input.prompt,
    runtimeModel: target?.runtimeModel,
  });
  const trait = modelSelection
    ? getComposerTraitSelection(
        modelSelection.provider,
        modelSelection.model,
        input.prompt,
        modelSelection.options,
        target?.runtimeModel,
      )
    : null;
  const effortLabel = effort
    ? (trait?.effortLevels.find((level) => level.value === effort)?.label ?? effort)
    : null;
  return {
    id: `live:${input.message.id}`,
    assistantMessageId: input.message.id,
    turnId: input.message.turnId ?? null,
    text: input.message.text,
    effort,
    effortLabel,
    provider: modelSelection?.provider ?? null,
    model: modelSelection?.model ?? null,
    createdAt: input.message.createdAt,
    checkpointTurnCount: input.turnDiffSummary?.checkpointTurnCount ?? null,
    changedFileCount: input.turnDiffSummary?.files.length ?? 0,
  };
}

export function AssistantRetryEffortMessageText(props: {
  readonly context: AssistantRetryEffortContext;
  readonly message: Pick<ChatMessage, "id" | "text" | "turnId" | "createdAt" | "streaming">;
  readonly liveText: string;
  readonly turnDiffSummary: TurnDiffSummary | undefined;
  readonly markdownProps: ComponentProps<typeof ChatMarkdown>;
  readonly threadLinks?: Parameters<typeof rewriteThreadIdsAsMarkdownLinks>[1] | undefined;
}): ReactNode {
  const precedingUser = resolvePrecedingUserMessage({
    messages: props.context.messages,
    assistantMessageId: props.message.id,
  });
  const live = buildLiveVariant({
    message: props.message,
    retryTarget: props.context.retryTarget,
    prompt: precedingUser?.text ?? "",
    turnDiffSummary: props.turnDiffSummary,
  });
  const displayedText = useDisplayedRetryVariantText({
    threadId: props.context.threadId,
    userMessageId: precedingUser?.messageId ?? null,
    live,
    liveText: props.liveText,
  });
  const markdownText = props.threadLinks
    ? rewriteThreadIdsAsMarkdownLinks(displayedText, props.threadLinks)
    : displayedText;
  return <ChatMarkdown {...props.markdownProps} text={markdownText} />;
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
    retryTarget: props.context.retryTarget,
    turnDiffSummary: props.turnDiffSummary,
    activeTurnId: props.context.activeTurnId,
    isBusy: props.context.isBusy,
  });

  const precedingUser = resolvePrecedingUserMessage({
    messages: props.context.messages,
    assistantMessageId: props.message.id,
  });
  const live = buildLiveVariant({
    message: props.message,
    retryTarget: props.context.retryTarget,
    prompt: precedingUser?.text ?? "",
    turnDiffSummary: props.turnDiffSummary,
  });

  return (
    <>
      {precedingUser ? (
        <RetryEffortVariantPager
          threadId={props.context.threadId}
          userMessageId={precedingUser.messageId}
          live={live}
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
