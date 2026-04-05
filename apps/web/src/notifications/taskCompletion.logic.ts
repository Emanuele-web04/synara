// FILE: taskCompletion.logic.ts
// Purpose: Detects newly completed thread turns and builds notification copy.
// Layer: Notification logic
// Exports: completion detection helpers and notification copy helpers

import type { Thread, ThreadSession } from "../types";

export interface CompletedThreadCandidate {
  threadId: Thread["id"];
  projectId: Thread["projectId"];
  title: string;
  completedAt: string;
  assistantSummary: string | null;
}

type ThreadSessionStatus = ThreadSession["status"];

// Treat sidebar "working" states as the only notification-worthy starting point.
function isRunningStatus(status: ThreadSessionStatus | null | undefined): boolean {
  return status === "running" || status === "connecting";
}

// Build a short body from the latest assistant message without dumping long output into OS chrome.
function summarizeLatestAssistantMessage(thread: Thread): string | null {
  for (let index = thread.messages.length - 1; index >= 0; index -= 1) {
    const message = thread.messages[index];
    if (!message || message.role !== "assistant") {
      continue;
    }
    const trimmed = message.text.trim().replace(/\s+/g, " ");
    if (trimmed.length === 0) {
      continue;
    }
    return trimmed.length <= 140 ? trimmed : `${trimmed.slice(0, 137)}...`;
  }
  return null;
}

// Compare consecutive snapshots and emit only fresh working -> completed transitions.
export function collectCompletedThreadCandidates(
  previousThreads: readonly Thread[],
  nextThreads: readonly Thread[],
): CompletedThreadCandidate[] {
  const previousById = new Map(previousThreads.map((thread) => [thread.id, thread] as const));
  const candidates: CompletedThreadCandidate[] = [];

  for (const thread of nextThreads) {
    const previousThread = previousById.get(thread.id);
    if (!previousThread) {
      continue;
    }
    if (!isRunningStatus(previousThread.session?.status)) {
      continue;
    }
    if (isRunningStatus(thread.session?.status)) {
      continue;
    }

    const completedAt = thread.latestTurn?.completedAt;
    if (!completedAt || completedAt === previousThread.latestTurn?.completedAt) {
      continue;
    }

    candidates.push({
      threadId: thread.id,
      projectId: thread.projectId,
      title: thread.title,
      completedAt,
      assistantSummary: summarizeLatestAssistantMessage(thread),
    });
  }

  return candidates;
}

// Keep toast and OS notification copy aligned across browser and desktop surfaces.
export function buildTaskCompletionCopy(candidate: CompletedThreadCandidate): {
  title: string;
  body: string;
} {
  const normalizedTitle = candidate.title.trim();
  const threadLabel = normalizedTitle.length > 0 ? normalizedTitle : "Untitled thread";

  return {
    title: "Task completed",
    body: candidate.assistantSummary
      ? `${threadLabel}: ${candidate.assistantSummary}`
      : `${threadLabel} finished working.`,
  };
}
