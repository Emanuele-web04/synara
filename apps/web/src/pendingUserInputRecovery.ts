import {
  ApprovalRequestId,
  UserInputQuestion,
  type OrchestrationThreadActivity,
} from "@synara/contracts";
import { createStalePendingInteractionMatcher } from "@synara/shared/pendingInteractions";
import { pendingRequestInstanceKey } from "@synara/shared/threadSummary";
import { Schema } from "effect";
import type { PendingUserInput } from "./pendingInteractionDerivation";
import {
  resolvePendingUserInputAnswer,
  type PendingUserInputDraftAnswer,
} from "./pendingUserInput";

export interface PendingUserInputRecoveryDraft {
  request: PendingUserInput;
  answers: Record<string, PendingUserInputDraftAnswer>;
}

const StoredDraft = Schema.Struct({
  request: Schema.Struct({
    requestId: ApprovalRequestId,
    lifecycleGeneration: Schema.optionalKey(Schema.String),
    createdAt: Schema.String,
    questions: Schema.Array(UserInputQuestion),
  }),
  answers: Schema.Record(
    Schema.String,
    Schema.Struct({
      customAnswer: Schema.optionalKey(Schema.String),
      selectedOptionLabels: Schema.optionalKey(Schema.Array(Schema.String)),
    }),
  ),
});

export function normalizePendingUserInputDrafts(
  value: unknown,
): Record<string, PendingUserInputRecoveryDraft> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, draft]) => {
      if (
        !Schema.is(StoredDraft)(draft) ||
        key !==
          pendingRequestInstanceKey(draft.request.requestId, draft.request.lifecycleGeneration)
      ) {
        return [];
      }
      const stored: typeof StoredDraft.Type = draft;
      const answers = Object.fromEntries(
        Object.entries(stored.answers).map(([id, answer]) => [
          id,
          {
            ...(answer.customAnswer !== undefined ? { customAnswer: answer.customAnswer } : {}),
            ...(answer.selectedOptionLabels
              ? { selectedOptionLabels: [...answer.selectedOptionLabels] }
              : {}),
          },
        ]),
      );
      return [[key, { request: stored.request, answers }]];
    }),
  );
}

export function expiredUserInputDrafts(
  drafts: Record<string, PendingUserInputRecoveryDraft>,
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): Array<[string, PendingUserInputRecoveryDraft]> {
  const isStale = createStalePendingInteractionMatcher(activities);
  return Object.entries(drafts).filter(([, draft]) =>
    isStale({ ...draft.request, interactionKind: "userInput" }),
  );
}

export function restoreUserInputDraft(
  prompt: string,
  draft: PendingUserInputRecoveryDraft,
): string {
  const pairs = draft.request.questions.flatMap((question) => {
    const answer = resolvePendingUserInputAnswer(question, draft.answers[question.id]);
    return answer === null
      ? []
      : [`${question.question}\n${Array.isArray(answer) ? answer.join(", ") : answer}`];
  });
  return [prompt, pairs.join("\n\n")].filter((part) => part.length > 0).join("\n\n");
}
