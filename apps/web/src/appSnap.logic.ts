// FILE: appSnap.logic.ts
// Purpose: Resolves recent-task targeting for incoming AppSnaps.
// Layer: Web UI logic
// Depends on: Thread identity only; no React or desktop APIs.

import type { ThreadId } from "@synara/contracts";

export const APPSNAP_RECENT_TARGET_WINDOW_MS = 60_000;

export interface AppSnapThreadTarget {
  threadId: ThreadId;
  splitViewId?: string | undefined;
}

export interface TimedAppSnapThreadTarget extends AppSnapThreadTarget {
  atMs: number;
}

export type ResolvedAppSnapTarget =
  | { kind: "existing"; target: AppSnapThreadTarget }
  | { kind: "fresh" };

export interface LatestAppSnapRequestGuard {
  begin: () => number;
  isCurrent: (requestId: number) => boolean;
}

export function createLatestAppSnapRequestGuard(): LatestAppSnapRequestGuard {
  let latestRequestId = 0;
  return {
    begin: () => {
      latestRequestId += 1;
      return latestRequestId;
    },
    isCurrent: (requestId) => requestId === latestRequestId,
  };
}

interface AppSnapSourceCarrier {
  source?:
    | {
        kind?: unknown;
        captureId?: unknown;
      }
    | null
    | undefined;
}

interface AppSnapCaptureDraft {
  persistedAttachments: ReadonlyArray<AppSnapSourceCarrier>;
  promptHistorySavedDraft?:
    | {
        persistedAttachments: ReadonlyArray<AppSnapSourceCarrier>;
      }
    | null
    | undefined;
}

function entriesContainCapture(
  entries: ReadonlyArray<AppSnapSourceCarrier>,
  captureId: string,
): boolean {
  return entries.some(
    (entry) =>
      (entry.source?.kind === "appsnap" || entry.source?.kind === "appshot") &&
      entry.source.captureId === captureId,
  );
}

export function hasPersistedAppSnapCapture(
  drafts: Iterable<AppSnapCaptureDraft | undefined>,
  captureId: string,
): boolean {
  if (captureId.length === 0) return false;
  for (const draft of drafts) {
    if (!draft) continue;
    if (
      entriesContainCapture(draft.persistedAttachments, captureId) ||
      (draft.promptHistorySavedDraft !== null &&
        draft.promptHistorySavedDraft !== undefined &&
        entriesContainCapture(draft.promptHistorySavedDraft.persistedAttachments, captureId))
    ) {
      return true;
    }
  }
  return false;
}

function isRecent(atMs: number, captureAtMs: number): boolean {
  const ageMs = captureAtMs - atMs;
  return Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= APPSNAP_RECENT_TARGET_WINDOW_MS;
}

export function resolveAppSnapTarget(input: {
  captureAtMs: number;
  lastInteraction: TimedAppSnapThreadTarget | null;
  lastAppSnap: TimedAppSnapThreadTarget | null;
  isThreadAvailable: (threadId: ThreadId) => boolean;
}): ResolvedAppSnapTarget {
  const { captureAtMs, lastInteraction, lastAppSnap, isThreadAvailable } = input;

  const recentInteraction =
    lastInteraction &&
    isRecent(lastInteraction.atMs, captureAtMs) &&
    isThreadAvailable(lastInteraction.threadId)
      ? lastInteraction
      : null;
  const recentAppSnap =
    lastAppSnap &&
    isRecent(lastAppSnap.atMs, captureAtMs) &&
    isThreadAvailable(lastAppSnap.threadId)
      ? lastAppSnap
      : null;

  // A newer explicit task interaction overrides the affinity created by an older AppSnap.
  if (recentInteraction && (!recentAppSnap || recentInteraction.atMs >= recentAppSnap.atMs)) {
    return {
      kind: "existing",
      target: {
        threadId: recentInteraction.threadId,
        ...(recentInteraction.splitViewId ? { splitViewId: recentInteraction.splitViewId } : {}),
      },
    };
  }

  // Consecutive AppSnaps stay together even while the user remains in the external app.
  if (recentAppSnap) {
    return {
      kind: "existing",
      target: {
        threadId: recentAppSnap.threadId,
        ...(recentAppSnap.splitViewId ? { splitViewId: recentAppSnap.splitViewId } : {}),
      },
    };
  }

  return { kind: "fresh" };
}
