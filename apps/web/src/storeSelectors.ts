// FILE: storeSelectors.ts
// Purpose: Stable Zustand selectors for entity lookups and lightweight sidebar projections.
// Exports: Selector factories used by routes and sidebar-heavy components.

import type {
  MessageId,
  OrchestrationReviewChatTarget,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";

import type { AppState } from "./store";
import { collectByIds, getThreadFromState, getThreadsFromState } from "./threadDerivation";
import type {
  ChatMessage,
  Project,
  SidebarThreadSummary,
  Thread,
  ThreadShell,
  ThreadTurnState,
} from "./types";

const EMPTY_REVIEW_SIDECHAT_MESSAGES: ChatMessage[] = [];
const EMPTY_REVIEW_SIDECHAT_ACTIVITIES: Thread["activities"] = [];
const EMPTY_REVIEW_SIDECHAT_MESSAGE_MAP: Record<MessageId, ChatMessage> = {};
const EMPTY_REVIEW_SIDECHAT_ACTIVITY_MAP: Record<string, Thread["activities"][number]> = {};

export interface ReviewSidechatThreadSlice {
  readonly modelSelection: Thread["modelSelection"];
  readonly latestTurn: Thread["latestTurn"];
  readonly messages: Thread["messages"];
  readonly activities: Thread["activities"];
}

function reviewChatTargetsMatch(
  left: OrchestrationReviewChatTarget | null | undefined,
  right: OrchestrationReviewChatTarget | null | undefined,
): boolean {
  if (!left || !right) {
    return left === right;
  }
  const repositoriesMatch =
    !left.repositoryId || !right.repositoryId || left.repositoryId === right.repositoryId;
  return (
    left.projectId === right.projectId &&
    left.cwd === right.cwd &&
    left.number === right.number &&
    repositoriesMatch
  );
}

function isStaleReviewResumeError(message: string | undefined): boolean {
  if (!message) {
    return false;
  }
  const normalized = message.toLowerCase();
  return (
    normalized.includes("thread/resume") &&
    (normalized.includes("no rollout found") ||
      normalized.includes("thread not found") ||
      normalized.includes("missing thread") ||
      normalized.includes("unknown thread"))
  );
}

function createStableEntitySelector<T extends { id: string }>(
  selectItems: (state: AppState) => readonly T[],
  id: string | null | undefined,
): (state: AppState) => T | undefined {
  let previousItems: readonly T[] | undefined;
  let previousMatch: T | undefined;

  return (state) => {
    if (!id) {
      return undefined;
    }

    const items = selectItems(state);
    if (items === previousItems) {
      return previousMatch;
    }

    previousItems = items;
    previousMatch = items.find((item) => item.id === id);
    return previousMatch;
  };
}

export function createProjectSelector(
  projectId: ProjectId | null | undefined,
): (state: AppState) => Project | undefined {
  return createStableEntitySelector((state) => state.projects, projectId);
}

export function createThreadSelector(
  threadId: ThreadId | null | undefined,
): (state: AppState) => Thread | undefined {
  return (state) =>
    threadId
      ? (getThreadFromState(state, threadId) ??
        state.threads.find((thread) => thread.id === threadId))
      : undefined;
}

export function createReviewSidechatThreadSelector(
  threadId: ThreadId | null | undefined,
): (state: AppState) => ReviewSidechatThreadSlice | undefined {
  let previousShell: ThreadShell | undefined;
  let previousTurnState: ThreadTurnState | undefined;
  let previousLatestTurn: Thread["latestTurn"] | undefined;
  let previousMessages: Thread["messages"] | undefined;
  let previousActivities: Thread["activities"] | undefined;
  let previousSlice: ReviewSidechatThreadSlice | undefined;

  return (state) => {
    if (!threadId) {
      return undefined;
    }

    const legacyThread = state.threadShellById?.[threadId]
      ? undefined
      : state.threads.find((thread) => thread.id === threadId);
    const shell = state.threadShellById?.[threadId] ?? legacyThread;
    if (!shell) {
      return undefined;
    }
    const turnState = state.threadTurnStateById?.[threadId];
    const messages =
      legacyThread?.messages ??
      collectByIds(
        state.messageIdsByThreadId?.[threadId],
        state.messageByThreadId?.[threadId] ?? EMPTY_REVIEW_SIDECHAT_MESSAGE_MAP,
        EMPTY_REVIEW_SIDECHAT_MESSAGES,
      );
    const activities =
      legacyThread?.activities ??
      collectByIds(
        state.activityIdsByThreadId?.[threadId],
        state.activityByThreadId?.[threadId] ?? EMPTY_REVIEW_SIDECHAT_ACTIVITY_MAP,
        EMPTY_REVIEW_SIDECHAT_ACTIVITIES,
      );
    const latestTurn = turnState?.latestTurn ?? legacyThread?.latestTurn ?? null;

    if (
      previousSlice &&
      previousShell?.modelSelection === shell.modelSelection &&
      previousTurnState === turnState &&
      previousLatestTurn === latestTurn &&
      previousMessages === messages &&
      previousActivities === activities
    ) {
      return previousSlice;
    }

    previousShell = shell;
    previousTurnState = turnState;
    previousLatestTurn = latestTurn;
    previousMessages = messages;
    previousActivities = activities;
    previousSlice = {
      modelSelection: shell.modelSelection,
      latestTurn,
      messages,
      activities,
    };
    return previousSlice;
  };
}

export function createReviewChatThreadIdSelector(
  target: OrchestrationReviewChatTarget | null,
): (state: AppState) => ThreadId | null {
  let previousThreadIds: readonly ThreadId[] | undefined;
  let previousThreads: readonly Thread[] | undefined;
  let previousShellById: AppState["threadShellById"] | undefined;
  let previousSessionById: AppState["threadSessionById"] | undefined;
  let previousThreadId: ThreadId | null = null;

  return (state) => {
    if (!target) {
      return null;
    }
    if (
      previousThreadIds === state.threadIds &&
      previousThreads === state.threads &&
      previousShellById === state.threadShellById &&
      previousSessionById === state.threadSessionById
    ) {
      return previousThreadId;
    }

    previousThreadIds = state.threadIds;
    previousThreads = state.threads;
    previousShellById = state.threadShellById;
    previousSessionById = state.threadSessionById;
    const normalizedThreadIds = state.threadIds ?? [];
    let bestUpdatedAt = Number.NEGATIVE_INFINITY;
    let bestThreadId: ThreadId | null = null;

    const considerThread = (
      shell: Pick<Thread, "id" | "archivedAt" | "createdAt" | "reviewChatTarget" | "updatedAt">,
      session: Thread["session"] | undefined,
    ) => {
      if (shell.archivedAt != null || !reviewChatTargetsMatch(shell.reviewChatTarget, target)) {
        return;
      }
      if (
        (session?.orchestrationStatus === "stopped" || session?.orchestrationStatus === "error") &&
        isStaleReviewResumeError(session.lastError)
      ) {
        return;
      }
      const updatedAt = Date.parse(shell.updatedAt ?? shell.createdAt);
      if (updatedAt >= bestUpdatedAt) {
        bestUpdatedAt = updatedAt;
        bestThreadId = shell.id;
      }
    };

    for (const threadId of normalizedThreadIds) {
      const shell = state.threadShellById?.[threadId];
      if (!shell) {
        continue;
      }
      considerThread(shell, state.threadSessionById?.[threadId]);
    }
    if (normalizedThreadIds.length === 0) {
      for (const thread of state.threads) {
        considerThread(thread, thread.session);
      }
    }
    previousThreadId = bestThreadId;
    return previousThreadId;
  };
}

export function createAllThreadsSelector(): (state: AppState) => readonly Thread[] {
  let previousThreadIds: readonly ThreadId[] | undefined;
  let previousThreadShellById = {} as AppState["threadShellById"];
  let previousThreadSessionById = {} as AppState["threadSessionById"];
  let previousThreadTurnStateById = {} as AppState["threadTurnStateById"];
  let previousMessageIdsByThreadId = {} as AppState["messageIdsByThreadId"];
  let previousMessageByThreadId = {} as AppState["messageByThreadId"];
  let previousActivityIdsByThreadId = {} as AppState["activityIdsByThreadId"];
  let previousActivityByThreadId = {} as AppState["activityByThreadId"];
  let previousProposedPlanIdsByThreadId = {} as AppState["proposedPlanIdsByThreadId"];
  let previousProposedPlanByThreadId = {} as AppState["proposedPlanByThreadId"];
  let previousTurnDiffIdsByThreadId = {} as AppState["turnDiffIdsByThreadId"];
  let previousTurnDiffSummaryByThreadId = {} as AppState["turnDiffSummaryByThreadId"];
  let previousThreads: readonly Thread[] = [];

  return (state) => {
    if (
      previousThreadIds === state.threadIds &&
      previousThreadShellById === state.threadShellById &&
      previousThreadSessionById === state.threadSessionById &&
      previousThreadTurnStateById === state.threadTurnStateById &&
      previousMessageIdsByThreadId === state.messageIdsByThreadId &&
      previousMessageByThreadId === state.messageByThreadId &&
      previousActivityIdsByThreadId === state.activityIdsByThreadId &&
      previousActivityByThreadId === state.activityByThreadId &&
      previousProposedPlanIdsByThreadId === state.proposedPlanIdsByThreadId &&
      previousProposedPlanByThreadId === state.proposedPlanByThreadId &&
      previousTurnDiffIdsByThreadId === state.turnDiffIdsByThreadId &&
      previousTurnDiffSummaryByThreadId === state.turnDiffSummaryByThreadId
    ) {
      return previousThreads;
    }

    previousThreadIds = state.threadIds;
    previousThreadShellById = state.threadShellById;
    previousThreadSessionById = state.threadSessionById;
    previousThreadTurnStateById = state.threadTurnStateById;
    previousMessageIdsByThreadId = state.messageIdsByThreadId;
    previousMessageByThreadId = state.messageByThreadId;
    previousActivityIdsByThreadId = state.activityIdsByThreadId;
    previousActivityByThreadId = state.activityByThreadId;
    previousProposedPlanIdsByThreadId = state.proposedPlanIdsByThreadId;
    previousProposedPlanByThreadId = state.proposedPlanByThreadId;
    previousTurnDiffIdsByThreadId = state.turnDiffIdsByThreadId;
    previousTurnDiffSummaryByThreadId = state.turnDiffSummaryByThreadId;
    previousThreads = getThreadsFromState(state);
    return previousThreads;
  };
}

export function createThreadShellsSelector(): (state: AppState) => readonly ThreadShell[] {
  let previousThreadIds: readonly ThreadId[] | undefined;
  let previousThreadShellById = {} as AppState["threadShellById"];
  let previousShells: readonly ThreadShell[] = [];

  return (state) => {
    if (
      previousThreadIds === state.threadIds &&
      previousThreadShellById === state.threadShellById
    ) {
      return previousShells;
    }

    previousThreadIds = state.threadIds;
    previousThreadShellById = state.threadShellById;
    previousShells = (state.threadIds ?? []).flatMap((threadId) => {
      const shell = state.threadShellById?.[threadId];
      return shell ? [shell] : [];
    });
    return previousShells;
  };
}

export function createAllThreadsMessagelessSelector(): (state: AppState) => boolean {
  let previousThreadIds: readonly ThreadId[] | undefined;
  let previousMessageIdsByThreadId = {} as AppState["messageIdsByThreadId"];
  let previousResult = true;

  return (state) => {
    if (
      previousThreadIds === state.threadIds &&
      previousMessageIdsByThreadId === state.messageIdsByThreadId
    ) {
      return previousResult;
    }

    previousThreadIds = state.threadIds;
    previousMessageIdsByThreadId = state.messageIdsByThreadId;
    previousResult = (state.threadIds ?? []).every(
      (threadId) => (state.messageIdsByThreadId?.[threadId]?.length ?? 0) === 0,
    );
    return previousResult;
  };
}

export function createThreadProjectIdSelector(
  threadId: ThreadId | null | undefined,
): (state: AppState) => ProjectId | null {
  return (state) => {
    if (!threadId) {
      return null;
    }
    return (
      state.threadShellById?.[threadId]?.projectId ??
      state.threads.find((thread) => thread.id === threadId)?.projectId ??
      null
    );
  };
}

export function createThreadExistsSelector(
  threadId: ThreadId | null | undefined,
): (state: AppState) => boolean {
  return (state) => {
    if (!threadId) {
      return false;
    }
    return (
      state.threadShellById?.[threadId] !== undefined ||
      state.threads.some((thread) => thread.id === threadId)
    );
  };
}

export function createSidebarThreadSummarySelector(
  threadId: ThreadId | null | undefined,
): (state: AppState) => SidebarThreadSummary | undefined {
  return (state) => (threadId ? state.sidebarThreadSummaryById[threadId] : undefined);
}

export function createSidebarThreadSummariesSelector(): (
  state: AppState,
) => readonly SidebarThreadSummary[] {
  let previousThreadIds: readonly ThreadId[] | undefined;
  let previousSummaryById: Record<string, SidebarThreadSummary> | undefined;
  let previousSummaries: readonly SidebarThreadSummary[] = [];

  return (state) => {
    const threadIds = state.threadIds ?? state.threads.map((thread) => thread.id);
    if (threadIds === previousThreadIds && state.sidebarThreadSummaryById === previousSummaryById) {
      return previousSummaries;
    }

    previousThreadIds = threadIds;
    previousSummaryById = state.sidebarThreadSummaryById;
    previousSummaries = threadIds.flatMap((threadId) => {
      const summary = state.sidebarThreadSummaryById[threadId];
      return summary ? [summary] : [];
    });
    return previousSummaries;
  };
}

export function createSidebarDisplayThreadsSelector(): (
  state: AppState,
) => readonly SidebarThreadSummary[] {
  const selectSidebarSummaries = createSidebarThreadSummariesSelector();
  let previousSummaries: readonly SidebarThreadSummary[] | undefined;
  let previousDisplaySummaries: readonly SidebarThreadSummary[] = [];

  return (state) => {
    const sidebarSummaries = selectSidebarSummaries(state);
    if (sidebarSummaries === previousSummaries) {
      return previousDisplaySummaries;
    }

    previousSummaries = sidebarSummaries;
    previousDisplaySummaries = sidebarSummaries.filter(
      (thread) =>
        !thread.parentThreadId && thread.archivedAt == null && thread.reviewChatTarget == null,
    );
    return previousDisplaySummaries;
  };
}

export function createFirstProjectSelector(): (state: AppState) => Project | undefined {
  let previousProjects: readonly Project[] | undefined;
  let previousFirstProject: Project | undefined;

  return (state) => {
    if (state.projects === previousProjects) {
      return previousFirstProject;
    }

    previousProjects = state.projects;
    previousFirstProject = state.projects.find((project) => project.kind === "project");
    return previousFirstProject;
  };
}

export function createProjectsByKindSelector(
  kind: Project["kind"],
): (state: AppState) => readonly Project[] {
  let previousProjects: readonly Project[] | undefined;
  let previousFiltered: readonly Project[] = [];

  return (state) => {
    if (state.projects === previousProjects) {
      return previousFiltered;
    }

    previousProjects = state.projects;
    previousFiltered = state.projects.filter((project) => project.kind === kind);
    return previousFiltered;
  };
}
