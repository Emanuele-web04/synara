// FILE: islandViewModel.ts
// Purpose: Project renderer thread state into the small, bounded snapshot understood by the
//          native macOS island. Interactive modes the native helper cannot represent stay in React.

import {
  DESKTOP_ISLAND_MAX_SESSIONS,
  DESKTOP_ISLAND_TEXT_LIMITS,
  type DesktopIslandApprovalSnapshot,
  type DesktopIslandMode,
  type DesktopIslandSessionSnapshot,
  type DesktopIslandSessionStatus,
  type DesktopIslandSnapshot,
} from "@synara/contracts";
import { PROVIDER_DESCRIPTOR_BY_KIND } from "@synara/shared/providerMetadata";

import { derivePendingApprovals, type PendingApproval } from "~/pendingInteractionDerivation";
import { formatClockDuration, isThreadRunningTurn } from "~/session-logic";
import { deriveWorkLogEntries, type WorkLogEntry } from "~/workLog";
import { selectActiveIslandThread, threadActivityTimestamp } from "~/lib/islandThreadTracker";
import { isGenericToolTitle } from "~/lib/toolCallLabel";
import { classifyWorkEntry, type WorkEntryCategory } from "~/lib/workEntryClassification";
import type { Thread } from "~/types";

export const NATIVE_ISLAND_MAX_SESSIONS = DESKTOP_ISLAND_MAX_SESSIONS;
export const NATIVE_ISLAND_TEXT_LIMITS = DESKTOP_ISLAND_TEXT_LIMITS;
export type NativeIslandMode = DesktopIslandMode;
export type NativeIslandSessionStatus = DesktopIslandSessionStatus;
export type NativeIslandSessionSnapshot = DesktopIslandSessionSnapshot;
export type NativeIslandApprovalSnapshot = DesktopIslandApprovalSnapshot;
export type NativeIslandSnapshot = DesktopIslandSnapshot;

export type IslandViewModel =
  | { target: "native"; snapshot: NativeIslandSnapshot }
  | { target: "react"; reason: "user-input" | "plan"; threadId: string }
  | { target: "react"; reason: "idle"; threadId: string | null };

interface ThreadApproval {
  thread: Thread;
  approval: PendingApproval;
}

interface ActivityPresentation {
  activity: string;
  status: NativeIslandSessionStatus;
}

const CONTROL_AND_BIDI_CHARACTERS =
  // Keep the native label boundary consistent with the existing action-state sanitizer.
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/gu;

function boundedDisplayText(value: string, maxCharacters: number, fallback = ""): string {
  const normalized = value.replace(CONTROL_AND_BIDI_CHARACTERS, "").replace(/\s+/gu, " ").trim();
  const source = normalized || fallback;
  const characters = Array.from(source);
  if (characters.length <= maxCharacters) {
    return source;
  }
  return `${characters.slice(0, maxCharacters - 1).join("")}…`;
}

function compareThreadRecency(left: Thread, right: Thread): number {
  const leftTimestamp = threadActivityTimestamp(left);
  const rightTimestamp = threadActivityTimestamp(right);
  return rightTimestamp.localeCompare(leftTimestamp);
}

function selectMostRecentThread(threads: ReadonlyArray<Thread>): Thread | null {
  return threads.toSorted(compareThreadRecency).at(0) ?? null;
}

function collectOpenApprovals(threads: ReadonlyArray<Thread>): Map<string, PendingApproval> {
  const approvalsByThreadId = new Map<string, PendingApproval>();
  for (const thread of threads) {
    if (thread.hasPendingApprovals !== true) {
      continue;
    }
    const approval = derivePendingApprovals(thread.activities, thread.pendingInteractions).at(0);
    if (approval) {
      approvalsByThreadId.set(thread.id, approval);
    }
  }
  return approvalsByThreadId;
}

function selectApproval(
  threads: ReadonlyArray<Thread>,
  approvalsByThreadId: ReadonlyMap<string, PendingApproval>,
): ThreadApproval | null {
  const candidates = threads.flatMap((thread) => {
    const approval = approvalsByThreadId.get(thread.id);
    return approval ? [{ thread, approval }] : [];
  });
  return (
    candidates.toSorted((left, right) => compareThreadRecency(left.thread, right.thread)).at(0) ??
    null
  );
}

function orderSessions(primaryThread: Thread | null, candidates: ReadonlyArray<Thread>): Thread[] {
  const ordered = candidates.toSorted(compareThreadRecency);
  if (!primaryThread) {
    return ordered.slice(0, NATIVE_ISLAND_MAX_SESSIONS);
  }
  return [primaryThread, ...ordered.filter((thread) => thread.id !== primaryThread.id)].slice(
    0,
    NATIVE_ISLAND_MAX_SESSIONS,
  );
}

function latestWorkEntry(thread: Thread): WorkLogEntry | null {
  return (
    deriveWorkLogEntries(thread.activities, thread.latestTurn?.turnId ?? undefined).at(-1) ?? null
  );
}

function workEntryDetail(workEntry: WorkLogEntry | null, fallback: string): string {
  if (!workEntry) {
    return fallback;
  }
  if (isGenericToolTitle(workEntry.label) && workEntry.toolTitle) {
    return workEntry.toolTitle;
  }
  return workEntry.label;
}

function activityPresentation(
  thread: Thread,
  workEntry: WorkLogEntry | null,
): ActivityPresentation {
  if (thread.error || workEntry?.tone === "error") {
    return { activity: "Needs attention", status: "error" };
  }

  const category = workEntry ? classifyWorkEntry(workEntry) : "thinking";
  if (category !== "thinking") {
    return activityPresentationForCategory(category);
  }

  const latestMessage = thread.messages.at(-1);
  if (latestMessage?.role === "assistant" && latestMessage.streaming) {
    return { activity: "Responding", status: "responding" };
  }

  return activityPresentationForCategory(category);
}

function activityPresentationForCategory(category: WorkEntryCategory): ActivityPresentation {
  switch (category) {
    case "reading":
      return { activity: "Reading file", status: "working" };
    case "editing":
      return { activity: "Editing file", status: "working" };
    case "running-command":
      return { activity: "Running command", status: "working" };
    case "error":
      return { activity: "Needs attention", status: "error" };
    case "thinking":
      return { activity: "Thinking", status: "responding" };
  }
}

function elapsedFor(thread: Thread, nowMs: number, approval: PendingApproval | null): string {
  const startedAt = thread.latestTurn?.startedAt ?? approval?.createdAt ?? null;
  if (!startedAt) {
    return "";
  }
  const startedAtMs = Date.parse(startedAt);
  if (!Number.isFinite(startedAtMs)) {
    return "";
  }
  return formatClockDuration(Math.max(0, nowMs - startedAtMs));
}

function changeSummaryFor(thread: Thread): string {
  const latestTurnId = thread.latestTurn?.turnId;
  const summary = latestTurnId
    ? (thread.turnDiffSummaries.findLast((entry) => entry.turnId === latestTurnId) ?? null)
    : (thread.turnDiffSummaries.at(-1) ?? null);
  if (!summary) {
    return "";
  }

  const totals = summary.files.reduce(
    (result, file) => ({
      additions: result.additions + (file.additions ?? 0),
      deletions: result.deletions + (file.deletions ?? 0),
    }),
    { additions: 0, deletions: 0 },
  );
  if (totals.additions === 0 && totals.deletions === 0) {
    return "";
  }
  return `+${totals.additions} −${totals.deletions}`;
}

function approvalFallbackDetail(requestKind: PendingApproval["requestKind"]): string {
  switch (requestKind) {
    case "command":
      return "Command approval";
    case "file-read":
      return "File read approval";
    case "file-change":
      return "File change approval";
  }
}

function projectSession(
  thread: Thread,
  nowMs: number,
  mode: Exclude<NativeIslandMode, "idle">,
  approval: PendingApproval | null,
): NativeIslandSessionSnapshot {
  const workEntry = latestWorkEntry(thread);
  const action = activityPresentation(thread, workEntry);
  const providerKind = thread.session?.provider ?? thread.modelSelection.provider;
  const detail =
    mode === "approval" && approval
      ? (approval.detail ?? approvalFallbackDetail(approval.requestKind))
      : workEntryDetail(workEntry, thread.title);

  return {
    id: thread.id,
    title: boundedDisplayText(thread.title, NATIVE_ISLAND_TEXT_LIMITS.title, "Untitled thread"),
    provider: boundedDisplayText(
      PROVIDER_DESCRIPTOR_BY_KIND[providerKind].displayName,
      NATIVE_ISLAND_TEXT_LIMITS.provider,
      "Provider",
    ),
    elapsed: boundedDisplayText(
      elapsedFor(thread, nowMs, approval),
      NATIVE_ISLAND_TEXT_LIMITS.elapsed,
    ),
    activity: boundedDisplayText(
      mode === "approval" && approval ? "Waiting for permission" : action.activity,
      NATIVE_ISLAND_TEXT_LIMITS.activity,
    ),
    detail: boundedDisplayText(detail, NATIVE_ISLAND_TEXT_LIMITS.detail),
    status: mode === "approval" && approval ? "approval" : action.status,
    changeSummary: boundedDisplayText(
      changeSummaryFor(thread),
      NATIVE_ISLAND_TEXT_LIMITS.changeSummary,
    ),
  };
}

/**
 * Converts the renderer's full thread model into a deterministic, JSON-safe native island view.
 * Approval wins globally. User-input, plan, and idle modes stay in React because their controls
 * or hover affordances do not have a native representation. Every native display string and
 * session list is bounded.
 */
export function projectNativeIslandViewModel(
  threads: ReadonlyArray<Thread>,
  nowMs = Date.now(),
): IslandViewModel {
  const visibleThreads = threads.filter((thread) => !thread.archivedAt);
  const approvalsByThreadId = collectOpenApprovals(visibleThreads);
  const approvalSelection = selectApproval(visibleThreads, approvalsByThreadId);

  if (approvalSelection) {
    const nativeActiveThreads = visibleThreads.filter(
      (thread) => approvalsByThreadId.has(thread.id) || isThreadRunningTurn(thread),
    );
    const sessions = orderSessions(approvalSelection.thread, nativeActiveThreads).map((thread) =>
      projectSession(thread, nowMs, "approval", approvalsByThreadId.get(thread.id) ?? null),
    );
    return {
      target: "native",
      snapshot: {
        version: 1,
        mode: "approval",
        primaryThreadId: approvalSelection.thread.id,
        sessions,
        approval: {
          threadId: approvalSelection.thread.id,
          requestId: approvalSelection.approval.requestId,
          requestKind: approvalSelection.approval.requestKind,
        },
      },
    };
  }

  const userInputThread = selectMostRecentThread(
    visibleThreads.filter((thread) => thread.hasPendingUserInput === true),
  );
  if (userInputThread) {
    return { target: "react", reason: "user-input", threadId: userInputThread.id };
  }

  const planThread = selectMostRecentThread(
    visibleThreads.filter((thread) => thread.hasActionableProposedPlan === true),
  );
  if (planThread) {
    return { target: "react", reason: "plan", threadId: planThread.id };
  }

  const runningThreads = visibleThreads.filter(isThreadRunningTurn);
  const activeThread = selectActiveIslandThread(runningThreads);
  if (activeThread) {
    const sessions = orderSessions(activeThread, runningThreads).map((thread) =>
      projectSession(thread, nowMs, "activity", null),
    );
    return {
      target: "native",
      snapshot: {
        version: 1,
        mode: "activity",
        primaryThreadId: activeThread.id,
        sessions,
      },
    };
  }

  const idleThread = selectMostRecentThread(visibleThreads);
  return { target: "react", reason: "idle", threadId: idleThread?.id ?? null };
}
