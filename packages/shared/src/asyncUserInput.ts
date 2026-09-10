import {
  AsyncUserInputActivityPayload,
  CODEX_ASYNC_USER_INPUT_ACTIVITY_KIND,
  type AsyncUserInputQuestion,
  type OrchestrationThreadActivity,
} from "@synara/contracts";
import { Schema } from "effect";

const isAsyncUserInputPayload = Schema.is(AsyncUserInputActivityPayload);

type ActivityFields = { readonly kind: string; readonly payload: unknown };

function asyncUserInputPayload(
  activity: ActivityFields,
): AsyncUserInputActivityPayload | undefined {
  return activity.kind === CODEX_ASYNC_USER_INPUT_ACTIVITY_KIND &&
    isAsyncUserInputPayload(activity.payload)
    ? activity.payload
    : undefined;
}

export type AsyncUserInputActivity = Omit<OrchestrationThreadActivity, "payload"> & {
  payload: AsyncUserInputActivityPayload;
};

export function isAsyncUserInputActivity(
  activity: OrchestrationThreadActivity,
): activity is AsyncUserInputActivity {
  return asyncUserInputPayload(activity) !== undefined;
}

export function isPendingAsyncUserInputActivity(activity: ActivityFields): boolean {
  const payload = asyncUserInputPayload(activity);
  return payload !== undefined && payload.response === undefined;
}

export function canRespondToAsyncUserInput(thread: {
  readonly id: string;
  readonly parentThreadId?: string | null | undefined;
}): boolean {
  return !thread.parentThreadId && !thread.id.startsWith("subagent:");
}

export function reopenAsyncUserInputAfterMessageRemoval<T extends ActivityFields>(
  activities: readonly T[],
  removedMessageIds: ReadonlySet<string>,
): T[] {
  return activities.map((activity) => {
    const payload = asyncUserInputPayload(activity);
    if (!payload?.response || !removedMessageIds.has(payload.response.messageId)) {
      return activity;
    }
    return { ...activity, payload: { questions: payload.questions } };
  });
}

export function formatAsyncUserInputResponse(
  questions: readonly AsyncUserInputQuestion[],
  answers: readonly string[],
): string {
  return questions.map((question, index) => `${question.title}\n${answers[index]}`).join("\n\n");
}
