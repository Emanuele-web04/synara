import { isDeepStrictEqual } from "node:util";
import type {
  EffortRetrySource,
  MessageId,
  ModelSelection,
  OrchestrationThread,
  ProviderInteractionMode,
  RuntimeMode,
} from "@synara/contracts";
import { applyClaudePromptEffortPrefix, isClaudeUltrathinkPrompt } from "@synara/shared/model";
import { threadHasInFlightTurn } from "./commandInvariants.ts";

type RetryRequest = {
  readonly messageId: MessageId;
  readonly text: string;
  readonly modelSelection?: ModelSelection | undefined;
  readonly retryFrom: EffortRetrySource;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
};

function withoutEffort(selection: ModelSelection) {
  const effortKey =
    selection.provider === "claudeAgent"
      ? "effort"
      : selection.provider === "opencode"
        ? "variant"
        : selection.provider === "pi" || selection.provider === "omp"
          ? "thinkingLevel"
          : "reasoningEffort";
  const options: Record<string, unknown> = { ...selection.options };
  delete options[effortKey];
  return { ...selection, options };
}

/** Revalidate the user's confirmed source before any destructive retry work. */
export function effortRetryPreconditionViolation(
  thread: OrchestrationThread,
  request: RetryRequest,
  admittedStartingAt?: string,
): string | null {
  const source = request.retryFrom;
  const ownStartingProjection =
    admittedStartingAt !== undefined &&
    thread.session?.status === "starting" &&
    thread.session.updatedAt === admittedStartingAt &&
    thread.session.activeTurnId === null &&
    thread.latestTurn?.state !== "running";
  if (threadHasInFlightTurn(thread) && !ownStartingProjection) {
    return "Effort retry requires a settled turn. Wait for the active turn to finish.";
  }
  if (thread.runtimeMode !== "approval-required" || request.runtimeMode !== "approval-required") {
    return "Effort retry is available only for approval-required turns.";
  }
  if (request.interactionMode !== thread.interactionMode) {
    return "Effort retry cannot change the thread's interaction mode.";
  }
  const user = thread.messages.findLast((message) => message.role === "user");
  const assistant = thread.messages.findLast((message) => message.role === "assistant");
  if (
    !user ||
    user.id !== request.messageId ||
    user.text !== source.userMessageText ||
    !assistant ||
    assistant.id !== source.assistantMessageId ||
    assistant.turnId !== source.turnId ||
    assistant.updatedAt !== source.assistantMessageUpdatedAt ||
    assistant.streaming ||
    thread.messages.indexOf(assistant) < thread.messages.indexOf(user) ||
    (thread.latestTurn !== null && thread.latestTurn.turnId !== source.turnId)
  ) {
    return "Effort retry source changed. Review the latest settled answer before retrying.";
  }
  if (!isDeepStrictEqual(thread.modelSelection, source.modelSelection)) {
    return "Effort retry model changed. Review the latest model selection before retrying.";
  }
  if (
    !request.modelSelection ||
    !isDeepStrictEqual(withoutEffort(source.modelSelection), withoutEffort(request.modelSelection))
  ) {
    return "Effort retry must keep the same provider, instance, model, and non-effort options.";
  }
  const isPromptEffortChange =
    source.modelSelection.provider === "claudeAgent" &&
    !isClaudeUltrathinkPrompt(source.userMessageText) &&
    request.text === applyClaudePromptEffortPrefix(source.userMessageText, "ultrathink");
  if (request.text !== source.userMessageText && !isPromptEffortChange) {
    return "Effort retry must keep the same user prompt.";
  }
  if (isDeepStrictEqual(source.modelSelection, request.modelSelection) && !isPromptEffortChange) {
    return "Effort retry requires a different effort.";
  }
  const checkpoint = thread.checkpoints.find((item) => item.turnId === source.turnId);
  if (
    !Number.isSafeInteger(source.checkpointTurnCount) ||
    source.checkpointTurnCount < 1 ||
    !checkpoint ||
    checkpoint.status !== "ready" ||
    checkpoint.checkpointTurnCount !== source.checkpointTurnCount ||
    checkpoint.checkpointRef !== source.checkpointRef
  ) {
    return "Effort retry checkpoint changed or is unavailable. Refresh the turn before retrying.";
  }
  return null;
}
