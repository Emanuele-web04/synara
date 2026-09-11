import { ThreadId } from "@synara/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { markPendingTurnDispatch } from "../../pendingTurnDispatch";
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
const EMPTY_MESSAGES: ChatMessage[] = [];
interface ChatLocalDispatchInput {
  phase: ReturnType<typeof derivePhase>;
  activeLatestTurn: Thread["latestTurn"];
  activeThread: Thread | undefined;
  activePendingApproval: ReturnType<typeof useChatPendingInteractions>["activePendingApproval"];
  activePendingUserInput: ReturnType<typeof useChatPendingInteractions>["activePendingUserInput"];
}

export function useChatLocalDispatch({
  phase,
  activeLatestTurn,
  activeThread,
  activePendingApproval,
  activePendingUserInput,
}: ChatLocalDispatchInput) {
  const [localDispatch, setLocalDispatch] = useState<LocalDispatchSnapshot | null>(null);
  const failedWorktreeSetupDispatchStartedAtRef = useRef<string | null>(null);
  // Live handle to the in-flight send's worktree preparation, resolved by the
  // setup card's Cancel / Work locally buttons. One send at a time can prepare
  // a worktree (the composer is send-busy while it runs), so a single ref is safe.
  const worktreeSetupResolutionRef = useRef<WorktreeSetupResolution | null>(null);
  const [worktreeSetupPendingAction, setWorktreeSetupPendingAction] =
    useState<WorktreeSetupResolutionAction | null>(null);

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
        threadError: activeThread?.error,
      }),
    [
      activeLatestTurn,
      activePendingApproval,
      activePendingUserInput,
      activeThread?.error,
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
        threadError: activeThread?.error,
        now: Date.now(),
      }),
    [
      activeLatestTurn,
      activePendingApproval,
      activePendingUserInput,
      activeThread?.error,
      activeThread?.session,
      localDispatch,
      phase,
    ],
  );
  const isSendBusy = localDispatch !== null && !serverAcknowledgedLocalDispatch;
  const isAwaitingTurnStart = localDispatch !== null && !turnTakenOver;
  const activeWorktreeSetup = localDispatch?.worktreeSetup ?? null;
  const isPreparingWorktree = activeWorktreeSetup !== null;

  const beginLocalDispatch = useCallback(
    (options?: WorktreeSetupDispatchOptions) => {
      setLocalDispatch((current) => {
        const next = resolveNextLocalDispatchSnapshot(
          options ? { current, activeThread, options } : { current, activeThread },
        );
        if (next !== current) {
          failedWorktreeSetupDispatchStartedAtRef.current = null;
        }
        return next;
      });
    },
    [activeThread],
  );

  const failLocalDispatchWorktreeSetup = useCallback(() => {
    setLocalDispatch((current) => {
      if (!current?.worktreeSetup) {
        return current;
      }
      const failed = failWorktreeSetupSnapshot(current.worktreeSetup);
      failedWorktreeSetupDispatchStartedAtRef.current = current.startedAt;
      return failed === current.worktreeSetup ? current : { ...current, worktreeSetup: failed };
    });
  }, []);

  const resetLocalDispatch = useCallback(() => {
    failedWorktreeSetupDispatchStartedAtRef.current = null;
    setLocalDispatch(null);
  }, []);

  // Clears only the setup stepper from the dispatch marker: after "Work
  // locally" the send continues (composer stays busy, Thinking shimmer takes
  // over) but the worktree card animates out.
  const clearLocalDispatchWorktreeSetup = useCallback(() => {
    setLocalDispatch((current) =>
      current?.worktreeSetup ? { ...current, worktreeSetup: null } : current,
    );
  }, []);

  const onResolveWorktreeSetup = useCallback((action: WorktreeSetupResolutionAction) => {
    const resolution = worktreeSetupResolutionRef.current;
    if (!resolution || resolution.action !== null) {
      return;
    }
    resolution.resolve(action);
    setWorktreeSetupPendingAction(action);
  }, []);

  // The dispatch marker normally clears when the thread stream echoes the sent
  // turn. Once the turn RPC has resolved the server owns the turn, so a stream
  // that never echoes (dead subscription, lost event) must not lock the
  // composer forever: this fallback force-clears the marker after a bound. The
  // startedAt match keeps a stale timer from clearing a newer dispatch, and an
  // already-acknowledged dispatch is left alone — the send spinner has
  // released, and the awaiting-turn bridge legitimately keeps `localDispatch`
  // alive until takeover or its own fail-open bound.
  const localDispatchStartedAtRef = useRef<string | null>(null);
  useEffect(() => {
    localDispatchStartedAtRef.current = localDispatch?.startedAt ?? null;
  }, [localDispatch]);
  const serverAcknowledgedLocalDispatchRef = useRef(serverAcknowledgedLocalDispatch);
  useEffect(() => {
    serverAcknowledgedLocalDispatchRef.current = serverAcknowledgedLocalDispatch;
  }, [serverAcknowledgedLocalDispatch]);
  const localDispatchAckFallbackTimeoutRef = useRef<number | null>(null);
  const armLocalDispatchAckFallback = useCallback((threadIdForSend: ThreadId) => {
    // The turn RPC has resolved, so the server provably owns a turn. Re-arm
    // the cross-component watchdog marker here: pre-dispatch work (worktree
    // creation, attachment uploads) can outlive the marker's age cap, and this
    // is the moment its clock should restart.
    markPendingTurnDispatch(threadIdForSend);
    const armedStartedAt = localDispatchStartedAtRef.current;
    if (armedStartedAt === null) {
      return;
    }
    if (localDispatchAckFallbackTimeoutRef.current !== null) {
      window.clearTimeout(localDispatchAckFallbackTimeoutRef.current);
    }
    localDispatchAckFallbackTimeoutRef.current = window.setTimeout(() => {
      localDispatchAckFallbackTimeoutRef.current = null;
      if (serverAcknowledgedLocalDispatchRef.current) {
        return;
      }
      setLocalDispatch((current) =>
        current &&
        current.startedAt === armedStartedAt &&
        !worktreeSetupHasError(current.worktreeSetup)
          ? null
          : current,
      );
    }, LOCAL_DISPATCH_ACK_TIMEOUT_MS);
  }, []);
  useEffect(
    () => () => {
      if (localDispatchAckFallbackTimeoutRef.current !== null) {
        window.clearTimeout(localDispatchAckFallbackTimeoutRef.current);
      }
    },
    [],
  );

  // Fallback cleanup for a failed worktree setup: clears the dispatch after the
  // error hold unless a newer dispatch already replaced it.
  const scheduleFailedWorktreeSetupDispatchReset = useCallback(() => {
    const failedDispatchStartedAt = failedWorktreeSetupDispatchStartedAtRef.current;
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
        failedWorktreeSetupDispatchStartedAtRef.current = null;
        return null;
      });
    }, WORKTREE_SETUP_ERROR_HOLD_MS);
  }, []);

  const localDispatchWorktreeSetupFailed = worktreeSetupHasError(activeWorktreeSetup);
  useEffect(() => {
    if (!turnTakenOver) {
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
          failedWorktreeSetupDispatchStartedAtRef.current = null;
          return null;
        });
      }, WORKTREE_SETUP_ERROR_HOLD_MS);
      return () => window.clearTimeout(holdTimeout);
    }
    resetLocalDispatch();
  }, [
    localDispatch?.startedAt,
    localDispatchWorktreeSetupFailed,
    resetLocalDispatch,
    turnTakenOver,
  ]);

  // Fail-open: if takeover never arrives, clear the awaiting-turn bridge so
  // Thinking cannot stick forever. Skipped while worktree setup is active.
  useEffect(() => {
    if (!localDispatch || turnTakenOver || localDispatch.worktreeSetup) {
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
  }, [localDispatch, resetLocalDispatch, turnTakenOver]);
  return {
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
