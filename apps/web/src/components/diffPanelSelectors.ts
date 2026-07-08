// FILE: diffPanelSelectors.ts
// Purpose: Lightweight Zustand selectors for the diff panel — avoid subscribing to the
//          full thread (messages/activities) when only catalog or live-refresh signals change.
// Layer: Diff panel data

import type { MessageId, ThreadId, TurnId } from "@synara/contracts";

import type { AppState } from "../store";
import { collectByIds } from "../threadDerivation";
import type { ChatMessage, Thread, ThreadShell, TurnDiffSummary } from "../types";
import { resolveDiffPanelRepoLiveRefresh } from "./DiffPanel.logic";

const EMPTY_TURN_DIFF_SUMMARIES: TurnDiffSummary[] = [];
const EMPTY_TURN_DIFF_IDS: TurnId[] = [];
const EMPTY_TURN_DIFF_MAP: Record<TurnId, TurnDiffSummary> = {};
const EMPTY_MESSAGES: ChatMessage[] = [];
const EMPTY_ACTIVITIES: Thread["activities"] = [];
const EMPTY_MESSAGE_IDS: MessageId[] = [];
const EMPTY_ACTIVITY_IDS: string[] = [];
const EMPTY_MESSAGE_MAP: Record<MessageId, ChatMessage> = {};
const EMPTY_ACTIVITY_MAP: Record<string, Thread["activities"][number]> = {};

export type DiffPanelThreadCatalog = {
  id: ThreadId;
  projectId: Thread["projectId"];
  envMode: Thread["envMode"];
  worktreePath: string | null;
  branch: string | null;
  turnDiffSummaries: TurnDiffSummary[];
};

export function toDiffPanelThreadCatalog(thread: Thread): DiffPanelThreadCatalog {
  return {
    id: thread.id,
    projectId: thread.projectId,
    envMode: thread.envMode,
    worktreePath: thread.worktreePath,
    branch: thread.branch,
    turnDiffSummaries: thread.turnDiffSummaries,
  };
}

export function createDiffPanelThreadCatalogSelector(
  threadId: ThreadId | null | undefined,
): (state: AppState) => DiffPanelThreadCatalog | undefined {
  let previousShell: ThreadShell | undefined;
  let previousTurnDiffSummaries: TurnDiffSummary[] | undefined;
  let previousCatalog: DiffPanelThreadCatalog | undefined;

  return (state) => {
    if (!threadId) {
      return undefined;
    }

    const shell = state.threadShellById?.[threadId];
    if (!shell) {
      return undefined;
    }

    const turnDiffIds = state.turnDiffIdsByThreadId?.[threadId];
    const turnDiffSummaryById = state.turnDiffSummaryByThreadId?.[threadId];
    const turnDiffSummaries = collectByIds(
      turnDiffIds ?? EMPTY_TURN_DIFF_IDS,
      turnDiffSummaryById ?? EMPTY_TURN_DIFF_MAP,
      EMPTY_TURN_DIFF_SUMMARIES,
    );

    if (
      shell === previousShell &&
      turnDiffSummaries === previousTurnDiffSummaries &&
      previousCatalog
    ) {
      return previousCatalog;
    }

    previousShell = shell;
    previousTurnDiffSummaries = turnDiffSummaries;
    previousCatalog = {
      id: shell.id,
      projectId: shell.projectId,
      envMode: shell.envMode,
      worktreePath: shell.worktreePath,
      branch: shell.branch,
      turnDiffSummaries,
    };
    return previousCatalog;
  };
}

function resolveLatestTurnAssistantStreaming(input: {
  latestTurnId: TurnId | null;
  latestTurnCompletedAt: string | null | undefined;
  messageIds: readonly MessageId[] | undefined;
  messageById: Record<MessageId, ChatMessage> | undefined;
}): boolean {
  if (!input.latestTurnId || input.latestTurnCompletedAt != null) {
    return false;
  }

  const messageIds = input.messageIds ?? EMPTY_MESSAGE_IDS;
  const messageById = input.messageById ?? EMPTY_MESSAGE_MAP;
  for (let index = messageIds.length - 1; index >= 0; index -= 1) {
    const message = messageById[messageIds[index]!];
    if (!message || message.turnId !== input.latestTurnId) {
      continue;
    }
    if (message.role === "assistant") {
      return message.streaming === true;
    }
  }
  return false;
}

function buildDiffPanelRepoLiveRefreshKey(input: {
  latestTurn: Thread["latestTurn"];
  session: Thread["session"];
  activityIds: readonly string[] | undefined;
  latestTurnAssistantStreaming: boolean;
}): string {
  return [
    input.latestTurn?.turnId ?? "",
    input.latestTurn?.startedAt ?? "",
    input.latestTurn?.completedAt ?? "",
    input.latestTurn?.state ?? "",
    input.session?.orchestrationStatus ?? "",
    input.session?.activeTurnId ?? "",
    input.activityIds?.length ?? 0,
    input.activityIds?.at(-1) ?? "",
    input.latestTurnAssistantStreaming ? "1" : "0",
  ].join("|");
}

/** Boolean selector: only re-renders when live repo-diff polling should start or stop. */
export function createDiffPanelRepoLiveRefreshSelector(
  threadId: ThreadId | null | undefined,
): (state: AppState) => boolean {
  let previousKey: string | undefined;
  let previousShouldPoll = false;

  return (state) => {
    if (!threadId) {
      return false;
    }

    const turnState = state.threadTurnStateById?.[threadId];
    const latestTurn = turnState?.latestTurn ?? null;
    const session = state.threadSessionById?.[threadId] ?? null;
    const messageIds = state.messageIdsByThreadId?.[threadId];
    const messageById = state.messageByThreadId?.[threadId];
    const activityIds = state.activityIdsByThreadId?.[threadId];
    const latestTurnAssistantStreaming = resolveLatestTurnAssistantStreaming({
      latestTurnId: latestTurn?.turnId ?? null,
      latestTurnCompletedAt: latestTurn?.completedAt,
      messageIds,
      messageById,
    });
    const key = buildDiffPanelRepoLiveRefreshKey({
      latestTurn,
      session,
      activityIds,
      latestTurnAssistantStreaming,
    });

    if (key === previousKey) {
      return previousShouldPoll;
    }

    previousKey = key;
    const messages = collectByIds(
      messageIds ?? EMPTY_MESSAGE_IDS,
      messageById ?? EMPTY_MESSAGE_MAP,
      EMPTY_MESSAGES,
    );
    const activities = collectByIds(
      activityIds ?? EMPTY_ACTIVITY_IDS,
      state.activityByThreadId?.[threadId] ?? EMPTY_ACTIVITY_MAP,
      EMPTY_ACTIVITIES,
    );
    previousShouldPoll = resolveDiffPanelRepoLiveRefresh({
      latestTurn,
      session,
      messages,
      activities,
    });
    return previousShouldPoll;
  };
}
