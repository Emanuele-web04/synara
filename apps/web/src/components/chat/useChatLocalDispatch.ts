import { shouldHoldLocalDispatchAcrossTurnStart } from "../ChatView.logic";
import { ThreadId } from "@synara/contracts";
import { useCallback, useEffect, useMemo, useSyncExternalStore, type SetStateAction } from "react";
import { create } from "zustand";
import { markPendingTurnDispatch } from "../../pendingTurnDispatch";
import { getWsSettlingThreadIds, subscribeWsTurnSettlements } from "../../wsTransportEvents";
import { derivePhase } from "../../session-logic";
import { type ChatMessage, type Thread, type WorktreeSetupResolutionAction } from "../../types";
import {
  LOCAL_DISPATCH_ACK_TIMEOUT_MS,
  LOCAL_DISPATCH_TURN_TAKEOVER_TIMEOUT_MS,
  WORKTREE_SETUP_ERROR_HOLD_MS,
  failWorktreeSetupSnapshot,
  hasLiveTurnTakenOver,
  hasServerAcknowledgedLocalDispatch,
  resolveNextLocalDispatchSnapshot,
  worktreeSetupHasError,
  type LocalDispatchSnapshot,
  type WorktreeSetupDispatchOptions,
  type WorktreeSetupResolution,
} from "../ChatView.logic";
import { useChatPendingInteractions } from "./useChatPendingInteractions";
// Preparation belongs to the task, so navigation can reconnect its controls.
interface ThreadDispatchState {
  localDispatch: LocalDispatchSnapshot | null;
  pendingAction: WorktreeSetupResolutionAction | null;
  serverAcknowledged?: boolean;
}
export const useThreadDispatchStore = create<{
  threads: Partial<Record<ThreadId, ThreadDispatchState>>;
}>(() => ({ threads: {} }));
const setupResolutions = new Map<ThreadId, WorktreeSetupResolution>();
function threadSetupResolutionRef(threadId: ThreadId) {
  return {
    get current() {
      return setupResolutions.get(threadId) ?? null;
    },
    set current(value: WorktreeSetupResolution | null) {
      if (value) setupResolutions.set(threadId, value);
      else setupResolutions.delete(threadId);
    },
  };
}
function updateThreadDispatch(
  threadId: ThreadId,
  patch: (current: ThreadDispatchState) => ThreadDispatchState,
) {
  useThreadDispatchStore.setState((state) => {
    const current = state.threads[threadId] ?? { localDispatch: null, pendingAction: null };
    const next = patch(current);
    const threads = { ...state.threads };
    if (next.localDispatch === null && next.pendingAction === null) delete threads[threadId];
    else threads[threadId] = next;
    return { threads };
  });
}
const EMPTY_MESSAGES: ChatMessage[] = [];
interface ChatLocalDispatchInput {
  threadId: ThreadId;
  phase: ReturnType<typeof derivePhase>;
  activeLatestTurn: Thread["latestTurn"];
  activeThread: Thread | undefined;
  activePendingApproval: ReturnType<typeof useChatPendingInteractions>["activePendingApproval"];
  activePendingUserInput: ReturnType<typeof useChatPendingInteractions>["activePendingUserInput"];
}

export function useChatLocalDispatch({
  threadId,
  phase,
  activeLatestTurn,
  activeThread,
  activePendingApproval,
  activePendingUserInput,
}: ChatLocalDispatchInput) {
  const isSettlingTurnDispatch = useSyncExternalStore(
    subscribeWsTurnSettlements,
    getWsSettlingThreadIds,
    getWsSettlingThreadIds,
  ).has(threadId);
  const localDispatch = useThreadDispatchStore(
    (state) => state.threads[threadId]?.localDispatch ?? null,
  );
  const worktreeSetupPendingAction = useThreadDispatchStore(
    (state) => state.threads[threadId]?.pendingAction ?? null,
  );
  const setLocalDispatch = useCallback(
    (next: SetStateAction<LocalDispatchSnapshot | null>) => {
      updateThreadDispatch(threadId, (current) => {
        const localDispatch = typeof next === "function" ? next(current.localDispatch) : next;
        const sameDispatch = localDispatch?.startedAt === current.localDispatch?.startedAt;
        const serverAcknowledged = current.serverAcknowledged ?? false;
        return {
          localDispatch,
          serverAcknowledged: sameDispatch && serverAcknowledged,
          pendingAction: localDispatch === null ? null : current.pendingAction,
        };
      });
    },
    [threadId],
  );
  const setWorktreeSetupPendingAction = useCallback(
    (pendingAction: WorktreeSetupResolutionAction | null) => {
      updateThreadDispatch(threadId, (current) => ({ ...current, pendingAction }));
    },
    [threadId],
  );
  const worktreeSetupResolutionRef = useMemo(() => threadSetupResolutionRef(threadId), [threadId]);

  const serverAcknowledgedLocalDispatch = useMemo(
    () =>
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase,
        latestTurn: activeLatestTurn,
        session: activeThread?.session ?? null,
        messages: activeThread?.messages ?? EMPTY_MESSAGES,
        hasPendingApproval: activePendingApproval !== null,
        hasPendingUserInput: activePendingUserInput !== null,
        claudeCacheReview: activeThread?.claudeCacheReview,
        threadError: activeThread?.error,
      }),
    [
      activeLatestTurn,
      activePendingApproval,
      activePendingUserInput,
      activeThread?.error,
      activeThread?.claudeCacheReview,
      activeThread?.messages,
      activeThread?.session,
      localDispatch,
      phase,
    ],
  );
  const turnTakenOver = useMemo(
    () =>
      hasLiveTurnTakenOver({
        localDispatch,
        phase,
        latestTurn: activeLatestTurn,
        session: activeThread?.session ?? null,
        hasPendingApproval: activePendingApproval !== null,
        hasPendingUserInput: activePendingUserInput !== null,
        claudeCacheReview: activeThread?.claudeCacheReview,
        threadError: activeThread?.error,
        now: Date.now(),
      }),
    [
      activeLatestTurn,
      activePendingApproval,
      activePendingUserInput,
      activeThread?.error,
      activeThread?.claudeCacheReview,
      activeThread?.session,
      localDispatch,
      phase,
    ],
  );
  const isSendBusy =
    isSettlingTurnDispatch || (localDispatch !== null && !serverAcknowledgedLocalDispatch);
  const holdDispatchAcrossTurnStart = shouldHoldLocalDispatchAcrossTurnStart({
    phase,
    latestTurn: activeLatestTurn,
    session: activeThread?.session ?? null,
    hasPendingApproval: activePendingApproval !== null,
    hasPendingUserInput: activePendingUserInput !== null,
    threadError: activeThread?.error,
  });
  const isAwaitingTurnStart =
    localDispatch !== null && (!turnTakenOver || holdDispatchAcrossTurnStart);
  const activeWorktreeSetup = localDispatch?.worktreeSetup ?? null;
  const isPreparingWorktree = activeWorktreeSetup !== null;

  const beginLocalDispatch = useCallback(
    (options?: WorktreeSetupDispatchOptions) => {
      setLocalDispatch((current) => {
        const next = resolveNextLocalDispatchSnapshot(
          options ? { current, activeThread, options } : { current, activeThread },
        );
        return next;
      });
    },
    [activeThread, setLocalDispatch],
  );

  const failLocalDispatchWorktreeSetup = useCallback(() => {
    setLocalDispatch((current) => {
      if (!current?.worktreeSetup) {
        return current;
      }
      const failed = failWorktreeSetupSnapshot(current.worktreeSetup);
      return failed === current.worktreeSetup ? current : { ...current, worktreeSetup: failed };
    });
  }, [setLocalDispatch]);

  const resetLocalDispatch = useCallback(() => {
    setLocalDispatch(null);
  }, [setLocalDispatch]);

  // Clears only the setup stepper from the dispatch marker: after "Work
  // locally" the send continues (composer stays busy, Thinking shimmer takes
  // over) but the worktree card animates out.
  const clearLocalDispatchWorktreeSetup = useCallback(() => {
    setLocalDispatch((current) =>
      current?.worktreeSetup ? { ...current, worktreeSetup: null } : current,
    );
  }, [setLocalDispatch]);

  const onResolveWorktreeSetup = useCallback(
    (action: WorktreeSetupResolutionAction) => {
      const resolution = worktreeSetupResolutionRef.current;
      if (!resolution || resolution.action !== null) {
        return;
      }
      resolution.resolve(action);
      setWorktreeSetupPendingAction(action);
    },
    [worktreeSetupResolutionRef, setWorktreeSetupPendingAction],
  );

  // The dispatch marker normally clears when the thread stream echoes the sent
  // turn. Once the turn RPC has resolved the server owns the turn, so a stream
  // that never echoes (dead subscription, lost event) must not lock the
  // composer forever: this fallback force-clears the marker after a bound. The
  // startedAt match keeps a stale timer from clearing a newer dispatch, and an
  // already-acknowledged dispatch is left alone — the send spinner has
  // released, and the awaiting-turn bridge legitimately keeps `localDispatch`
  // alive until takeover or its own fail-open bound.
  useEffect(() => {
    updateThreadDispatch(threadId, (current) => ({
      ...current,
      serverAcknowledged: serverAcknowledgedLocalDispatch,
    }));
  }, [threadId, serverAcknowledgedLocalDispatch]);
  const armLocalDispatchAckFallback = useCallback(
    (threadIdForSend: ThreadId) => {
      markPendingTurnDispatch(threadIdForSend);
      const armedStartedAt =
        useThreadDispatchStore.getState().threads[threadId]?.localDispatch?.startedAt;
      if (!armedStartedAt) return;
      window.setTimeout(() => {
        if (useThreadDispatchStore.getState().threads[threadId]?.serverAcknowledged) return;
        setLocalDispatch((current) =>
          current &&
          current.startedAt === armedStartedAt &&
          !worktreeSetupHasError(current.worktreeSetup)
            ? null
            : current,
        );
      }, LOCAL_DISPATCH_ACK_TIMEOUT_MS);
    },
    [threadId, setLocalDispatch],
  );

  // Fallback cleanup for a failed worktree setup: clears the dispatch after the
  // error hold unless a newer dispatch already replaced it.
  const scheduleFailedWorktreeSetupDispatchReset = useCallback(() => {
    const failedDispatchStartedAt =
      useThreadDispatchStore.getState().threads[threadId]?.localDispatch?.startedAt;
    window.setTimeout(() => {
      setLocalDispatch((current) => {
        if (
          !failedDispatchStartedAt ||
          !current ||
          current.startedAt !== failedDispatchStartedAt ||
          !worktreeSetupHasError(current.worktreeSetup)
        ) {
          return current;
        }
        return null;
      });
    }, WORKTREE_SETUP_ERROR_HOLD_MS);
  }, [threadId, setLocalDispatch]);

  const localDispatchWorktreeSetupFailed = worktreeSetupHasError(activeWorktreeSetup);
  useEffect(() => {
    if (!turnTakenOver || holdDispatchAcrossTurnStart) {
      return;
    }
    // A failed worktree setup would otherwise reset in the same commit that
    // painted the error (thread errors count as takeover), so hold the
    // row briefly before letting it animate out.
    if (localDispatchWorktreeSetupFailed) {
      const failedDispatchStartedAt = localDispatch?.startedAt;
      if (!failedDispatchStartedAt) {
        return;
      }
      const holdTimeout = window.setTimeout(() => {
        setLocalDispatch((current) => {
          if (
            !current ||
            current.startedAt !== failedDispatchStartedAt ||
            !worktreeSetupHasError(current.worktreeSetup)
          ) {
            return current;
          }
          return null;
        });
      }, WORKTREE_SETUP_ERROR_HOLD_MS);
      return () => window.clearTimeout(holdTimeout);
    }
    resetLocalDispatch();
  }, [
    setLocalDispatch,
    localDispatch?.startedAt,
    localDispatchWorktreeSetupFailed,
    resetLocalDispatch,
    turnTakenOver,
    holdDispatchAcrossTurnStart,
  ]);

  // Fail-open: if takeover never arrives, clear the awaiting-turn bridge so
  // Thinking cannot stick forever. Skipped while worktree setup is active.
  useEffect(() => {
    if (
      !localDispatch ||
      (turnTakenOver && !holdDispatchAcrossTurnStart) ||
      localDispatch.worktreeSetup
    ) {
      return;
    }
    const startedAtMs = Date.parse(localDispatch.startedAt);
    if (!Number.isFinite(startedAtMs)) {
      return;
    }
    const remainingMs = LOCAL_DISPATCH_TURN_TAKEOVER_TIMEOUT_MS - (Date.now() - startedAtMs);
    if (remainingMs <= 0) {
      resetLocalDispatch();
      return;
    }
    const timer = window.setTimeout(() => {
      resetLocalDispatch();
    }, remainingMs);
    return () => window.clearTimeout(timer);
  }, [localDispatch, resetLocalDispatch, turnTakenOver, holdDispatchAcrossTurnStart]);
  return {
    isSettlingTurnDispatch,
    localDispatch,
    setLocalDispatch,
    worktreeSetupResolutionRef,
    worktreeSetupPendingAction,
    setWorktreeSetupPendingAction,
    turnTakenOver,
    isSendBusy,
    isAwaitingTurnStart,
    activeWorktreeSetup,
    isPreparingWorktree,
    beginLocalDispatch,
    failLocalDispatchWorktreeSetup,
    resetLocalDispatch,
    clearLocalDispatchWorktreeSetup,
    onResolveWorktreeSetup,
    armLocalDispatchAckFallback,
    scheduleFailedWorktreeSetupDispatchReset,
  };
}
