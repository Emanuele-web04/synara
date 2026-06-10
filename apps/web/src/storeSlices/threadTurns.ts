// FILE: storeSlices/threadTurns.ts
// Purpose: Pure thread-level turn transforms — latest-turn derivation, turn-diff merge,
//   assistant-message application, and revert/rollback retention.
// Layer: (Thread, ...) => Thread transforms consumed by store.ts event reducers; no store state.
// Exports: buildLatestTurn, reconcileLatestTurnFromSession, checkpointStatusToLatestTurnState,
//   applyTurnDiffSummaryToThread, applyThreadMessageSentEvent, retain*/rollback* revert helpers.

import { type OrchestrationEvent, type OrchestrationReadModel } from "@t3tools/contracts";
import { type ChatMessage, type Thread } from "../types";
import { arraysShallowEqual } from "./equality";
import { normalizeTurnDiffFiles } from "./threadNormalization";
import { MAX_THREAD_MESSAGES, mergeStreamingMessage, normalizeChatMessage } from "./threadMessages";

type ReadModelThread = OrchestrationReadModel["threads"][number];
type ThreadMessageSentEvent = Extract<OrchestrationEvent, { type: "thread.message-sent" }>;

function normalizeSingleTurnDiffSummary(
  incoming: Thread["turnDiffSummaries"][number],
  previous: Thread["turnDiffSummaries"][number] | undefined,
): Thread["turnDiffSummaries"][number] {
  const files = normalizeTurnDiffFiles(incoming.files, previous?.files);
  if (
    previous &&
    previous.turnId === incoming.turnId &&
    previous.completedAt === incoming.completedAt &&
    previous.status === incoming.status &&
    previous.assistantMessageId === incoming.assistantMessageId &&
    previous.checkpointTurnCount === incoming.checkpointTurnCount &&
    previous.checkpointRef === incoming.checkpointRef &&
    previous.files === files
  ) {
    return previous;
  }
  return {
    ...incoming,
    files,
  };
}

function sortTurnDiffSummaries(
  summaries: ReadonlyArray<Thread["turnDiffSummaries"][number]>,
): Thread["turnDiffSummaries"] {
  return [...summaries].toSorted(
    (left, right) =>
      (left.checkpointTurnCount ?? Number.MAX_SAFE_INTEGER) -
        (right.checkpointTurnCount ?? Number.MAX_SAFE_INTEGER) ||
      left.completedAt.localeCompare(right.completedAt) ||
      left.turnId.localeCompare(right.turnId),
  );
}

export function checkpointStatusToLatestTurnState(
  status: Thread["turnDiffSummaries"][number]["status"],
): NonNullable<Thread["latestTurn"]>["state"] {
  if (status === "error") {
    return "error";
  }
  if (status === "missing") {
    return "interrupted";
  }
  return "completed";
}

function isProviderDiffPlaceholderRef(checkpointRef: string | null | undefined): boolean {
  return checkpointRef?.startsWith("provider-diff:") === true;
}

// Preserve proposed-plan linkage across live turn updates until the snapshot catches up.
export function buildLatestTurn(params: {
  previous: Thread["latestTurn"];
  turnId: NonNullable<Thread["latestTurn"]>["turnId"];
  state: NonNullable<Thread["latestTurn"]>["state"];
  requestedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  assistantMessageId: NonNullable<Thread["latestTurn"]>["assistantMessageId"];
  sourceProposedPlan?: Thread["pendingSourceProposedPlan"];
}): NonNullable<Thread["latestTurn"]> {
  const sourceProposedPlan =
    params.previous?.turnId === params.turnId
      ? (params.previous.sourceProposedPlan ?? params.sourceProposedPlan)
      : params.sourceProposedPlan;
  return {
    turnId: params.turnId,
    state: params.state,
    requestedAt: params.requestedAt,
    startedAt: params.startedAt,
    completedAt: params.completedAt,
    assistantMessageId: params.assistantMessageId,
    ...(sourceProposedPlan ? { sourceProposedPlan } : {}),
  };
}

export function reconcileLatestTurnFromSession(
  thread: Thread,
  session: NonNullable<ReadModelThread["session"]>,
  error: string | null,
): Thread["latestTurn"] {
  if (session.status === "running" && session.activeTurnId !== null) {
    return buildLatestTurn({
      previous: thread.latestTurn,
      turnId: session.activeTurnId,
      state: "running",
      requestedAt:
        thread.latestTurn?.turnId === session.activeTurnId
          ? thread.latestTurn.requestedAt
          : session.updatedAt,
      startedAt:
        thread.latestTurn?.turnId === session.activeTurnId
          ? (thread.latestTurn.startedAt ?? session.updatedAt)
          : session.updatedAt,
      completedAt: null,
      assistantMessageId:
        thread.latestTurn?.turnId === session.activeTurnId
          ? thread.latestTurn.assistantMessageId
          : null,
      sourceProposedPlan: thread.pendingSourceProposedPlan,
    });
  }

  if (session.status === "error" && thread.latestTurn?.state === "running") {
    return buildLatestTurn({
      previous: thread.latestTurn,
      turnId: thread.latestTurn.turnId,
      state: "error",
      requestedAt: thread.latestTurn.requestedAt,
      startedAt: thread.latestTurn.startedAt,
      completedAt: session.updatedAt,
      assistantMessageId: thread.latestTurn.assistantMessageId,
      sourceProposedPlan: thread.pendingSourceProposedPlan,
    });
  }

  void error;
  return thread.latestTurn;
}

function rebindTurnDiffSummariesForAssistantMessage(
  turnDiffSummaries: ReadonlyArray<Thread["turnDiffSummaries"][number]>,
  turnId: Thread["turnDiffSummaries"][number]["turnId"],
  assistantMessageId: NonNullable<Thread["latestTurn"]>["assistantMessageId"],
): Thread["turnDiffSummaries"] {
  let changed = false;
  const nextSummaries = turnDiffSummaries.map((summary) => {
    if (summary.turnId !== turnId || summary.assistantMessageId === assistantMessageId) {
      return summary;
    }
    changed = true;
    return {
      ...summary,
      assistantMessageId: assistantMessageId ?? undefined,
    };
  });
  return changed ? nextSummaries : [...turnDiffSummaries];
}

export function retainThreadMessagesAfterRevert(
  messages: ReadonlyArray<ChatMessage>,
  retainedTurnIds: ReadonlySet<string>,
  turnCount: number,
): ChatMessage[] {
  const retainedMessageIds = new Set<string>();
  for (const message of messages) {
    if (message.role === "system") {
      retainedMessageIds.add(message.id);
      continue;
    }
    if (
      message.turnId !== undefined &&
      message.turnId !== null &&
      retainedTurnIds.has(message.turnId)
    ) {
      retainedMessageIds.add(message.id);
    }
  }

  const retainedUserCount = messages.filter(
    (message) => message.role === "user" && retainedMessageIds.has(message.id),
  ).length;
  const missingUserCount = Math.max(0, turnCount - retainedUserCount);
  if (missingUserCount > 0) {
    const fallbackUserMessages = messages
      .filter(
        (message) =>
          message.role === "user" &&
          !retainedMessageIds.has(message.id) &&
          (message.turnId === undefined ||
            message.turnId === null ||
            retainedTurnIds.has(message.turnId)),
      )
      .toSorted(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
      )
      .slice(0, missingUserCount);
    for (const message of fallbackUserMessages) {
      retainedMessageIds.add(message.id);
    }
  }

  const retainedAssistantCount = messages.filter(
    (message) => message.role === "assistant" && retainedMessageIds.has(message.id),
  ).length;
  const missingAssistantCount = Math.max(0, turnCount - retainedAssistantCount);
  if (missingAssistantCount > 0) {
    const fallbackAssistantMessages = messages
      .filter(
        (message) =>
          message.role === "assistant" &&
          !retainedMessageIds.has(message.id) &&
          (message.turnId === undefined ||
            message.turnId === null ||
            retainedTurnIds.has(message.turnId)),
      )
      .toSorted(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
      )
      .slice(0, missingAssistantCount);
    for (const message of fallbackAssistantMessages) {
      retainedMessageIds.add(message.id);
    }
  }

  return messages.filter((message) => retainedMessageIds.has(message.id));
}

export function retainThreadActivitiesAfterRevert(
  activities: ReadonlyArray<Thread["activities"][number]>,
  retainedTurnIds: ReadonlySet<string>,
): Thread["activities"] {
  return activities.filter(
    (activity) => activity.turnId === null || retainedTurnIds.has(activity.turnId),
  );
}

export function retainThreadProposedPlansAfterRevert(
  proposedPlans: ReadonlyArray<Thread["proposedPlans"][number]>,
  retainedTurnIds: ReadonlySet<string>,
): Thread["proposedPlans"] {
  return proposedPlans.filter(
    (proposedPlan) => proposedPlan.turnId === null || retainedTurnIds.has(proposedPlan.turnId),
  );
}

export function rollbackThreadMessagesFromMessage(
  messages: ReadonlyArray<ChatMessage>,
  messageId: string,
): {
  readonly messages: ChatMessage[];
  readonly removedTurnIds: ReadonlySet<string>;
} {
  const targetIndex = messages.findIndex((message) => message.id === messageId);
  if (targetIndex < 0) {
    return { messages: [...messages], removedTurnIds: new Set() };
  }

  const removedMessages = messages.slice(targetIndex);
  return {
    messages: messages.slice(0, targetIndex),
    removedTurnIds: new Set(
      removedMessages.flatMap((message) =>
        message.turnId === undefined || message.turnId === null ? [] : [message.turnId],
      ),
    ),
  };
}

export function applyTurnDiffSummaryToThread(
  thread: Thread,
  summary: Thread["turnDiffSummaries"][number],
): Thread {
  const previousSummary = thread.turnDiffSummaries.find(
    (existingSummary) => existingSummary.turnId === summary.turnId,
  );
  const nextSummary = normalizeSingleTurnDiffSummary(summary, previousSummary);
  if (previousSummary && previousSummary.status !== "missing" && nextSummary.status === "missing") {
    return thread;
  }
  const turnDiffSummaries = previousSummary
    ? thread.turnDiffSummaries.map((existingSummary) =>
        existingSummary.turnId === nextSummary.turnId ? nextSummary : existingSummary,
      )
    : sortTurnDiffSummaries([...thread.turnDiffSummaries, nextSummary]);

  const isActivePlaceholder =
    isProviderDiffPlaceholderRef(nextSummary.checkpointRef) &&
    nextSummary.status === "missing" &&
    thread.latestTurn?.turnId === nextSummary.turnId &&
    thread.latestTurn.state === "running";
  const latestTurn =
    thread.latestTurn === null || thread.latestTurn.turnId === nextSummary.turnId
      ? isActivePlaceholder
        ? thread.latestTurn
        : buildLatestTurn({
            previous: thread.latestTurn,
            turnId: nextSummary.turnId,
            state: checkpointStatusToLatestTurnState(nextSummary.status),
            requestedAt: thread.latestTurn?.requestedAt ?? nextSummary.completedAt,
            startedAt: thread.latestTurn?.startedAt ?? nextSummary.completedAt,
            completedAt: nextSummary.completedAt,
            // Prefer the incoming assistantMessageId when present; otherwise keep
            // the previous one from the same turn. Turn-diff events may arrive
            // before the message has been finalized and carry a null id — they
            // must not erase a real id already recorded by thread.message-sent.
            assistantMessageId:
              nextSummary.assistantMessageId ??
              (thread.latestTurn?.turnId === nextSummary.turnId
                ? thread.latestTurn.assistantMessageId
                : null) ??
              null,
            sourceProposedPlan: thread.pendingSourceProposedPlan,
          })
      : thread.latestTurn;

  if (
    previousSummary === nextSummary &&
    turnDiffSummaries === thread.turnDiffSummaries &&
    latestTurn === thread.latestTurn &&
    (thread.updatedAt ?? thread.createdAt) >= nextSummary.completedAt
  ) {
    return thread;
  }

  return {
    ...thread,
    turnDiffSummaries:
      arraysShallowEqual(thread.turnDiffSummaries, turnDiffSummaries) &&
      thread.turnDiffSummaries.length === turnDiffSummaries.length
        ? thread.turnDiffSummaries
        : turnDiffSummaries,
    latestTurn,
    updatedAt:
      (thread.updatedAt ?? thread.createdAt) > nextSummary.completedAt
        ? thread.updatedAt
        : nextSummary.completedAt,
  };
}

export function applyThreadMessageSentEvent(thread: Thread, event: ThreadMessageSentEvent): Thread {
  const payload = event.payload;
  const incomingMessage = normalizeChatMessage(
    {
      id: payload.messageId,
      role: payload.role,
      text: payload.text,
      dispatchMode: payload.dispatchMode,
      turnId: payload.turnId,
      attachments: payload.attachments ?? [],
      streaming: payload.streaming,
      source: payload.source,
      createdAt: payload.createdAt,
      updatedAt: payload.updatedAt,
    },
    thread.messages.find((message) => message.id === payload.messageId),
  );
  const existingIndex = thread.messages.findIndex((message) => message.id === payload.messageId);
  let messages = thread.messages;

  if (existingIndex >= 0) {
    const existingMessage = thread.messages[existingIndex];
    if (!existingMessage) {
      return thread;
    }
    const mergedMessage = mergeStreamingMessage(existingMessage, incomingMessage);
    if (mergedMessage !== null) {
      messages = thread.messages.map((message, index) =>
        index === existingIndex ? mergedMessage : message,
      );
    }
  } else {
    messages = [...thread.messages, incomingMessage].slice(-MAX_THREAD_MESSAGES);
  }

  const turnDiffSummaries =
    payload.role === "assistant" && payload.turnId !== null
      ? rebindTurnDiffSummariesForAssistantMessage(
          thread.turnDiffSummaries,
          payload.turnId,
          payload.messageId,
        )
      : thread.turnDiffSummaries;

  let latestTurn = thread.latestTurn;
  if (
    payload.role === "assistant" &&
    payload.turnId !== null &&
    (thread.latestTurn === null || thread.latestTurn.turnId === payload.turnId)
  ) {
    const previousTurn = thread.latestTurn;
    latestTurn = buildLatestTurn({
      previous: previousTurn,
      turnId: payload.turnId,
      state: payload.streaming
        ? "running"
        : previousTurn?.state === "interrupted"
          ? "interrupted"
          : previousTurn?.state === "error"
            ? "error"
            : "completed",
      requestedAt: previousTurn?.requestedAt ?? payload.createdAt,
      startedAt: previousTurn?.startedAt ?? payload.createdAt,
      completedAt: payload.streaming ? (previousTurn?.completedAt ?? null) : payload.updatedAt,
      assistantMessageId: payload.messageId,
      sourceProposedPlan: thread.pendingSourceProposedPlan,
    });
  }

  const updatedAt =
    thread.updatedAt && thread.updatedAt > payload.updatedAt ? thread.updatedAt : payload.updatedAt;
  if (
    messages === thread.messages &&
    turnDiffSummaries === thread.turnDiffSummaries &&
    latestTurn === thread.latestTurn &&
    updatedAt === thread.updatedAt
  ) {
    return thread;
  }

  return {
    ...thread,
    messages,
    turnDiffSummaries,
    latestTurn,
    updatedAt,
  };
}
