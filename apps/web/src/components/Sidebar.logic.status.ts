// FILE: Sidebar.logic.status.ts
// Purpose: Thread/project/terminal/PR status indicator derivation for sidebar rows.
// Layer: Sidebar logic (pure).
// Exports: status pill + terminal/PR indicator types and their resolvers.

import type { GitStatusResult } from "@t3tools/contracts";
import type { Thread } from "../types";
import { GitMergedSimpleIcon, GitPullRequestIcon, type LucideIcon } from "~/lib/icons";
import {
  hasLiveLatestTurn,
  findLatestProposedPlan,
  hasActionableProposedPlan,
  isLatestTurnSettled,
} from "../session-logic";

export interface ThreadStatusPill {
  label:
    | "Working"
    | "Connecting"
    | "Completed"
    | "Pending Approval"
    | "Awaiting Input"
    | "Plan Ready";
  colorClass: string;
  dotClass: string;
  pulse: boolean;
  dismissible?: boolean;
  dismissalKey?: string;
}

const THREAD_STATUS_PRIORITY: Record<ThreadStatusPill["label"], number> = {
  "Pending Approval": 5,
  "Awaiting Input": 4,
  Working: 3,
  Connecting: 3,
  "Plan Ready": 2,
  Completed: 1,
};

export type ThreadStatusInput = Pick<
  Thread,
  "interactionMode" | "latestTurn" | "lastVisitedAt" | "session" | "updatedAt"
> & {
  proposedPlans?: Thread["proposedPlans"] | undefined;
  hasActionableProposedPlan?: boolean | undefined;
  hasLiveTailWork?: boolean | undefined;
  dismissedStatusKey?: string | undefined;
};

function createThreadStatusDismissalKey(
  label: Extract<ThreadStatusPill["label"], "Pending Approval" | "Awaiting Input" | "Plan Ready">,
  thread: ThreadStatusInput,
): string {
  return [
    label,
    thread.updatedAt ?? "",
    thread.latestTurn?.turnId ?? "",
    thread.latestTurn?.completedAt ?? "",
    thread.session?.updatedAt ?? "",
  ].join(":");
}

function createCompletedDismissalKey(thread: ThreadStatusInput): string | null {
  if (!thread.latestTurn?.completedAt) {
    return null;
  }

  return ["Completed", thread.latestTurn.turnId, thread.latestTurn.completedAt].join(":");
}

export function hasUnseenCompletion(thread: ThreadStatusInput): boolean {
  if (!thread.latestTurn?.completedAt) return false;
  const completedAt = Date.parse(thread.latestTurn.completedAt);
  if (Number.isNaN(completedAt)) return false;
  if (!thread.lastVisitedAt) return true;

  const lastVisitedAt = Date.parse(thread.lastVisitedAt);
  if (Number.isNaN(lastVisitedAt)) return true;
  return completedAt > lastVisitedAt;
}

export function resolveThreadStatusPill(input: {
  thread: ThreadStatusInput;
  hasPendingApprovals: boolean;
  hasPendingUserInput: boolean;
}): ThreadStatusPill | null {
  const { hasPendingApprovals, hasPendingUserInput, thread } = input;

  if (hasPendingApprovals) {
    const dismissalKey = createThreadStatusDismissalKey("Pending Approval", thread);
    if (thread.dismissedStatusKey === dismissalKey) {
      return null;
    }
    return {
      label: "Pending Approval",
      colorClass: "text-amber-600 dark:text-amber-300/90",
      dotClass: "bg-amber-500 dark:bg-amber-300/90",
      pulse: false,
      dismissible: true,
      dismissalKey,
    };
  }

  if (hasPendingUserInput) {
    const dismissalKey = createThreadStatusDismissalKey("Awaiting Input", thread);
    if (thread.dismissedStatusKey === dismissalKey) {
      return null;
    }
    return {
      label: "Awaiting Input",
      colorClass: "text-indigo-600 dark:text-indigo-300/90",
      dotClass: "bg-indigo-500 dark:bg-indigo-300/90",
      pulse: false,
      dismissible: true,
      dismissalKey,
    };
  }

  if (thread.hasLiveTailWork) {
    return {
      label: "Working",
      colorClass: "text-sky-600 dark:text-sky-300/80",
      dotClass: "bg-sky-500 dark:bg-sky-300/80",
      pulse: true,
      dismissible: false,
    };
  }

  if (
    thread.session?.status === "running" &&
    (thread.latestTurn === null || hasLiveLatestTurn(thread.latestTurn, thread.session))
  ) {
    return {
      label: "Working",
      colorClass: "text-sky-600 dark:text-sky-300/80",
      dotClass: "bg-sky-500 dark:bg-sky-300/80",
      pulse: true,
      dismissible: false,
    };
  }

  if (thread.session?.status === "connecting") {
    return {
      label: "Connecting",
      colorClass: "text-sky-600 dark:text-sky-300/80",
      dotClass: "bg-sky-500 dark:bg-sky-300/80",
      pulse: true,
      dismissible: false,
    };
  }

  const hasPlanReadyPrompt =
    !hasPendingUserInput &&
    !thread.hasLiveTailWork &&
    thread.interactionMode === "plan" &&
    isLatestTurnSettled(thread.latestTurn, thread.session) &&
    (thread.hasActionableProposedPlan ??
      hasActionableProposedPlan(
        findLatestProposedPlan(thread.proposedPlans ?? [], thread.latestTurn?.turnId ?? null),
      ));
  if (hasPlanReadyPrompt) {
    const dismissalKey = createThreadStatusDismissalKey("Plan Ready", thread);
    if (thread.dismissedStatusKey === dismissalKey) {
      return null;
    }
    return {
      label: "Plan Ready",
      colorClass: "text-violet-600 dark:text-violet-300/90",
      dotClass: "bg-violet-500 dark:bg-violet-300/90",
      pulse: false,
      dismissible: true,
      dismissalKey,
    };
  }

  if (!thread.hasLiveTailWork && hasUnseenCompletion(thread)) {
    const dismissalKey = createCompletedDismissalKey(thread);
    if (dismissalKey && thread.dismissedStatusKey === dismissalKey) {
      return null;
    }
    return {
      label: "Completed",
      colorClass: "text-emerald-600 dark:text-emerald-300/90",
      dotClass: "bg-emerald-500 dark:bg-emerald-300/90",
      pulse: false,
      dismissible: true,
      ...(dismissalKey ? { dismissalKey } : {}),
    };
  }

  return null;
}

export function resolveProjectStatusIndicator(
  statuses: ReadonlyArray<ThreadStatusPill | null>,
): ThreadStatusPill | null {
  let highestPriorityStatus: ThreadStatusPill | null = null;

  for (const status of statuses) {
    if (status === null) continue;
    if (
      highestPriorityStatus === null ||
      THREAD_STATUS_PRIORITY[status.label] > THREAD_STATUS_PRIORITY[highestPriorityStatus.label]
    ) {
      highestPriorityStatus = status;
    }
  }

  return highestPriorityStatus;
}

export interface TerminalStatusIndicator {
  label: "Terminal input needed" | "Terminal task completed" | "Terminal process running";
  colorClass: string;
  pulse: boolean;
}

export interface PrStatusIndicator {
  label: "PR open" | "PR closed" | "PR merged";
  colorClass: string;
  icon: LucideIcon;
  tooltip: string;
  url: string;
}

export interface PrStatePresentation {
  label: "PR open" | "PR closed" | "PR merged";
  colorClass: string;
  iconKind: "pull-request" | "merged-simple";
}

export function resolvePrStatePresentation(
  state: "open" | "closed" | "merged",
): PrStatePresentation {
  if (state === "open") {
    return {
      label: "PR open",
      colorClass: "text-[var(--color-decoration-added)]",
      iconKind: "pull-request",
    };
  }
  if (state === "closed") {
    return {
      label: "PR closed",
      colorClass: "text-zinc-500 dark:text-zinc-400/80",
      iconKind: "pull-request",
    };
  }
  return {
    label: "PR merged",
    colorClass: "text-violet-500 dark:text-violet-400",
    iconKind: "merged-simple",
  };
}

export type ThreadPr = GitStatusResult["pr"];

export function toThreadPr(
  pr:
    | NonNullable<ThreadPr>
    | {
        number: number;
        title: string;
        url: string;
        baseBranch: string;
        headBranch: string;
        state: "open" | "closed" | "merged";
      },
): ThreadPr {
  return {
    number: pr.number,
    title: pr.title,
    url: pr.url,
    baseBranch: pr.baseBranch,
    headBranch: pr.headBranch,
    state: pr.state,
  };
}

export function terminalStatusFromThreadState(input: {
  runningTerminalIds: string[];
  terminalAttentionStatesById: Record<string, "attention" | "review">;
}): TerminalStatusIndicator | null {
  const terminalAttentionStates = Object.values(input.terminalAttentionStatesById ?? {});
  if (terminalAttentionStates.includes("attention")) {
    return {
      label: "Terminal input needed",
      colorClass: "text-amber-600 dark:text-amber-300/90",
      pulse: false,
    };
  }
  if ((input.runningTerminalIds?.length ?? 0) > 0) {
    return {
      label: "Terminal process running",
      colorClass: "text-teal-600 dark:text-teal-300/90",
      pulse: true,
    };
  }
  if (terminalAttentionStates.includes("review")) {
    return {
      label: "Terminal task completed",
      colorClass: "text-emerald-600 dark:text-emerald-300/90",
      pulse: false,
    };
  }
  return null;
}

export function prStatusIndicator(pr: ThreadPr): PrStatusIndicator | null {
  if (!pr) return null;

  if (pr.state === "open") {
    return {
      label: "PR open",
      // Match the diff "+" green so an opened PR reads as the same positive signal.
      colorClass: "text-[var(--color-decoration-added)]",
      icon: GitPullRequestIcon,
      tooltip: `#${pr.number} PR open: ${pr.title}`,
      url: pr.url,
    };
  }
  if (pr.state === "closed") {
    return {
      label: "PR closed",
      colorClass: "text-zinc-500 dark:text-zinc-400/80",
      icon: GitPullRequestIcon,
      tooltip: `#${pr.number} PR closed: ${pr.title}`,
      url: pr.url,
    };
  }
  if (pr.state === "merged") {
    return {
      label: "PR merged",
      colorClass: "text-violet-500 dark:text-violet-400",
      icon: GitMergedSimpleIcon,
      tooltip: `#${pr.number} PR merged: ${pr.title}`,
      url: pr.url,
    };
  }
  return null;
}
