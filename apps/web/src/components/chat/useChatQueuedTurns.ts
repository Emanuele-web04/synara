import { ThreadId } from "@synara/contracts";
import type { RefObject } from "react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { collapseExpandedComposerCursor, detectComposerTrigger } from "../../composer-logic";
import { type QueuedComposerTurn } from "../../composerDraftStore";
import { cloneComposerImageAttachment } from "../../lib/composerSend";
import {
  armQueuedComposerSteerGate,
  claimQueuedComposerAutoDispatch,
  clearQueuedComposerAutoDispatchRetry,
  clearQueuedComposerSteerGate,
  getQueuedComposerAutoDispatchRetryDelay,
  getQueuedComposerSteerGate,
  isQueuedComposerAwaitingTurnStart,
  recordQueuedComposerAutoDispatchFailure,
  releaseQueuedComposerAutoDispatch,
  runLockedQueuedComposerAutoDispatch,
  tryBeginQueuedComposerAutoDispatch,
} from "../../lib/queuedComposerDrain";
import { derivePhase } from "../../session-logic";
import { type ChatMessage, type Thread } from "../../types";
import {
  resolveQueuedComposerAutoDispatchHold,
  resolveQueuedSteerGateTransition,
  type QueuedSteerGate,
} from "../ChatView.logic";
import { useChatComposerDraft } from "./useChatComposerDraft";
import { useChatLocalDispatch } from "./useChatLocalDispatch";
import { useChatPendingInteractions } from "./useChatPendingInteractions";
import { useComposerReferences } from "./useComposerReferences";
import type { LateComposerSendHandlers } from "./chatSendTypes";
const EMPTY_MESSAGES: ChatMessage[] = [];
interface ChatQueuedTurnsInput {
  setComposerDraftComputerControl: ReturnType<
    typeof useChatComposerDraft
  >["setComposerDraftComputerControl"];
  threadId: ThreadId;
  queuedComposerTurns: ReturnType<typeof useChatComposerDraft>["queuedComposerTurns"];
  activeThread: Thread | undefined;
  promptRef: ReturnType<typeof useChatComposerDraft>["promptRef"];
  clearComposerDraftContent: ReturnType<typeof useChatComposerDraft>["clearComposerDraftContent"];
  setComposerDraftPrompt: ReturnType<typeof useChatComposerDraft>["setComposerDraftPrompt"];
  setDraftThreadContext: ReturnType<typeof useChatComposerDraft>["setDraftThreadContext"];
  addComposerImagesToDraft: ReturnType<typeof useChatComposerDraft>["addComposerImagesToDraft"];
  addComposerFilesToDraft: ReturnType<typeof useChatComposerDraft>["addComposerFilesToDraft"];
  addComposerAssistantSelectionToDraft: ReturnType<
    typeof useChatComposerDraft
  >["addComposerAssistantSelectionToDraft"];
  addComposerDraftBrowserAnnotations: ReturnType<
    typeof useChatComposerDraft
  >["addComposerDraftBrowserAnnotations"];
  addComposerFileCommentToDraft: ReturnType<
    typeof useChatComposerDraft
  >["addComposerFileCommentToDraft"];
  addComposerTerminalContextsToDraft: ReturnType<
    typeof useChatComposerDraft
  >["addComposerTerminalContextsToDraft"];
  addComposerPastedTextsToDraft: ReturnType<
    typeof useChatComposerDraft
  >["addComposerPastedTextsToDraft"];
  addComposerPullRequestContextsToDraft: ReturnType<
    typeof useChatComposerDraft
  >["addComposerPullRequestContextsToDraft"];
  updateSelectedComposerSkills: ReturnType<
    typeof useComposerReferences
  >["updateSelectedComposerSkills"];
  updateSelectedComposerMentions: ReturnType<
    typeof useComposerReferences
  >["updateSelectedComposerMentions"];
  setRestoredQueuedSourceProposedPlan: ReturnType<
    typeof useChatComposerDraft
  >["setRestoredQueuedSourceProposedPlan"];
  setComposerDraftModelSelection: ReturnType<
    typeof useChatComposerDraft
  >["setComposerDraftModelSelection"];
  setComposerDraftRuntimeMode: ReturnType<
    typeof useChatComposerDraft
  >["setComposerDraftRuntimeMode"];
  setComposerDraftInteractionMode: ReturnType<
    typeof useChatComposerDraft
  >["setComposerDraftInteractionMode"];
  setComposerCursor: ReturnType<typeof useChatComposerDraft>["setComposerCursor"];
  setComposerTrigger: ReturnType<typeof useChatComposerDraft>["setComposerTrigger"];
  scheduleComposerFocus: () => void;
  removeQueuedComposerTurnFromDraft: ReturnType<
    typeof useChatComposerDraft
  >["removeQueuedComposerTurnFromDraft"];
  lateComposerSendHandlersRef: RefObject<LateComposerSendHandlers | null>;
  insertQueuedComposerTurn: ReturnType<typeof useChatComposerDraft>["insertQueuedComposerTurn"];
  phase: ReturnType<typeof derivePhase>;
  localDispatch: ReturnType<typeof useChatLocalDispatch>["localDispatch"];
  isLocalDraftThread: boolean;
  activeLatestTurn: Thread["latestTurn"];
  isConnecting: boolean;
  activePendingApproval: ReturnType<typeof useChatPendingInteractions>["activePendingApproval"];
  activePendingProgress: ReturnType<typeof useChatPendingInteractions>["activePendingProgress"];
  pendingUserInputs: ReturnType<typeof useChatPendingInteractions>["pendingUserInputs"];
  sendInFlightRef: RefObject<boolean>;
  sendPreflightInFlightRef: RefObject<boolean>;
}

export function useChatQueuedTurns({
  threadId,
  queuedComposerTurns,
  activeThread,
  promptRef,
  clearComposerDraftContent,
  setComposerDraftPrompt,
  setDraftThreadContext,
  addComposerImagesToDraft,
  addComposerFilesToDraft,
  addComposerAssistantSelectionToDraft,
  addComposerDraftBrowserAnnotations,
  addComposerFileCommentToDraft,
  addComposerTerminalContextsToDraft,
  addComposerPastedTextsToDraft,
  addComposerPullRequestContextsToDraft,
  updateSelectedComposerSkills,
  updateSelectedComposerMentions,
  setRestoredQueuedSourceProposedPlan,
  setComposerDraftModelSelection,
  setComposerDraftComputerControl,
  setComposerDraftRuntimeMode,
  setComposerDraftInteractionMode,
  setComposerCursor,
  setComposerTrigger,
  scheduleComposerFocus,
  removeQueuedComposerTurnFromDraft,
  lateComposerSendHandlersRef,
  insertQueuedComposerTurn,
  phase,
  localDispatch,
  isLocalDraftThread,
  activeLatestTurn,
  isConnecting,
  activePendingApproval,
  activePendingProgress,
  pendingUserInputs,
  sendInFlightRef,
  sendPreflightInFlightRef,
}: ChatQueuedTurnsInput) {
  const queuedComposerTurnsRef = useRef<QueuedComposerTurn[]>([]);

  const autoDispatchingQueuedTurnRef = useRef(false);

  // Holds queued-composer auto-dispatch through a non-natively-steerable
  // provider steer's interrupt→re-dispatch gap; see
  // resolveQueuedSteerGateTransition. Seed from the shared map so a remount
  // during the interrupt gap still sees the gate the watcher has been holding.

  const [queuedSteerGate, setQueuedSteerGate] = useState<QueuedSteerGate | null>(() =>
    getQueuedComposerSteerGate(threadId),
  );
  // Bumped to re-evaluate auto-dispatch when only non-reactive guards (refs)
  // blocked it; nothing else re-triggers the effect once they reset.
  const [queuedAutoDispatchTick, setQueuedAutoDispatchTick] = useState(0);

  useEffect(() => {
    queuedComposerTurnsRef.current = queuedComposerTurns;
  }, [queuedComposerTurnsRef, queuedComposerTurns]);

  useEffect(() => {
    autoDispatchingQueuedTurnRef.current = false;
  }, [autoDispatchingQueuedTurnRef, threadId]);

  useLayoutEffect(() => {
    claimQueuedComposerAutoDispatch(threadId);
    setQueuedSteerGate(getQueuedComposerSteerGate(threadId));
    return () => {
      releaseQueuedComposerAutoDispatch(threadId);
    };
  }, [setQueuedSteerGate, threadId]);

  const restoreQueuedTurnToComposer = useCallback(
    (queuedTurn: QueuedComposerTurn) => {
      if (!activeThread) {
        return;
      }
      const nextPrompt = queuedTurn.kind === "chat" ? queuedTurn.prompt : queuedTurn.text;
      const restoredImages =
        queuedTurn.kind === "chat" ? queuedTurn.images.map(cloneComposerImageAttachment) : [];
      const restoredFiles = queuedTurn.kind === "chat" ? queuedTurn.files : [];
      const restoredAssistantSelections =
        queuedTurn.kind === "chat" ? queuedTurn.assistantSelections : [];
      const restoredBrowserAnnotations =
        queuedTurn.kind === "chat" ? queuedTurn.browserAnnotations : [];
      const restoredFileComments = queuedTurn.kind === "chat" ? queuedTurn.fileComments : [];
      promptRef.current = nextPrompt;
      clearComposerDraftContent(activeThread.id);
      setComposerDraftPrompt(activeThread.id, nextPrompt);
      // Editing a queued turn should recreate the same draft state the user queued.
      setDraftThreadContext(activeThread.id, {
        runtimeMode: queuedTurn.runtimeMode,
        interactionMode: queuedTurn.interactionMode,
        ...(queuedTurn.kind === "chat" ? { envMode: queuedTurn.envMode } : {}),
      });
      if (queuedTurn.kind === "chat") {
        if (restoredImages.length > 0) {
          addComposerImagesToDraft(restoredImages);
        }
        if (restoredFiles.length > 0) {
          addComposerFilesToDraft(restoredFiles);
        }
        for (const selection of restoredAssistantSelections) {
          addComposerAssistantSelectionToDraft(selection);
        }
        if (restoredBrowserAnnotations.length > 0) {
          addComposerDraftBrowserAnnotations(activeThread.id, restoredBrowserAnnotations);
        }
        for (const comment of restoredFileComments) {
          addComposerFileCommentToDraft(comment);
        }
        if (queuedTurn.terminalContexts.length > 0) {
          addComposerTerminalContextsToDraft(queuedTurn.terminalContexts);
        }
        if (queuedTurn.pastedTexts.length > 0) {
          addComposerPastedTextsToDraft(queuedTurn.pastedTexts);
        }
        addComposerPullRequestContextsToDraft(queuedTurn.pullRequestContexts);
        updateSelectedComposerSkills(queuedTurn.skills);
        updateSelectedComposerMentions(queuedTurn.mentions);
      } else {
        updateSelectedComposerSkills([]);
        updateSelectedComposerMentions([]);
      }
      setRestoredQueuedSourceProposedPlan(
        activeThread.id,
        queuedTurn.kind === "chat" && queuedTurn.sourceProposedPlan
          ? {
              threadId: activeThread.id,
              restoredPrompt: nextPrompt,
              sourceProposedPlan: queuedTurn.sourceProposedPlan,
            }
          : null,
      );
      setComposerDraftModelSelection(activeThread.id, queuedTurn.modelSelection);
      setComposerDraftRuntimeMode(activeThread.id, queuedTurn.runtimeMode);
      setComposerDraftInteractionMode(activeThread.id, queuedTurn.interactionMode);
      setComposerDraftComputerControl(activeThread.id, queuedTurn.enableComputerControl === true);
      setComposerCursor(collapseExpandedComposerCursor(nextPrompt, nextPrompt.length));
      setComposerTrigger(detectComposerTrigger(nextPrompt, nextPrompt.length));
      scheduleComposerFocus();
    },
    [
      promptRef,
      setComposerCursor,
      setComposerTrigger,
      activeThread,
      addComposerAssistantSelectionToDraft,
      addComposerDraftBrowserAnnotations,
      addComposerFileCommentToDraft,
      addComposerFilesToDraft,
      addComposerImagesToDraft,
      addComposerTerminalContextsToDraft,
      addComposerPastedTextsToDraft,
      addComposerPullRequestContextsToDraft,
      clearComposerDraftContent,
      scheduleComposerFocus,
      setDraftThreadContext,
      setRestoredQueuedSourceProposedPlan,
      setComposerDraftComputerControl,
      setComposerDraftInteractionMode,
      setComposerDraftModelSelection,
      setComposerDraftPrompt,
      setComposerDraftRuntimeMode,
      updateSelectedComposerMentions,
      updateSelectedComposerSkills,
    ],
  );

  const removeQueuedComposerTurn = useCallback(
    (queuedTurnId: string) => {
      removeQueuedComposerTurnFromDraft(threadId, queuedTurnId);
    },
    [removeQueuedComposerTurnFromDraft, threadId],
  );

  const dispatchQueuedComposerTurn = useCallback(
    async (queuedTurn: QueuedComposerTurn, dispatchMode: "queue" | "steer"): Promise<boolean> => {
      const lateSendHandlers = lateComposerSendHandlersRef.current;
      if (!lateSendHandlers) {
        return false;
      }
      if (queuedTurn.kind === "chat") {
        return lateSendHandlers.send(undefined, dispatchMode, queuedTurn);
      }
      return lateSendHandlers.submitPlanFollowUp({
        text: queuedTurn.text,
        interactionMode: queuedTurn.interactionMode,
        dispatchMode,
        queuedTurn,
      });
    },
    [lateComposerSendHandlersRef],
  );

  const onSteerQueuedComposerTurn = useCallback(
    async (queuedTurn: QueuedComposerTurn) => {
      const previousQueue = queuedComposerTurnsRef.current;
      const queuedIndex = previousQueue.findIndex((entry) => entry.id === queuedTurn.id);
      if (queuedIndex < 0) {
        return;
      }
      removeQueuedComposerTurnFromDraft(threadId, queuedTurn.id);
      const succeeded = await dispatchQueuedComposerTurn(queuedTurn, "steer");
      if (succeeded) {
        clearQueuedComposerAutoDispatchRetry(threadId);
        return;
      }
      insertQueuedComposerTurn(threadId, queuedTurn, queuedIndex);
      recordQueuedComposerAutoDispatchFailure(threadId, queuedTurn.id);
      setQueuedAutoDispatchTick((tick) => tick + 1);
    },
    [
      queuedComposerTurnsRef,
      setQueuedAutoDispatchTick,
      dispatchQueuedComposerTurn,
      insertQueuedComposerTurn,
      removeQueuedComposerTurnFromDraft,
      threadId,
    ],
  );

  const onEditQueuedComposerTurn = useCallback(
    (queuedTurn: QueuedComposerTurn) => {
      removeQueuedComposerTurn(queuedTurn.id);
      restoreQueuedTurnToComposer(queuedTurn);
    },
    [removeQueuedComposerTurn, restoreQueuedTurnToComposer],
  );

  // Advance/expire the steer gate as the session moves through the
  // interrupt→steered-turn handoff (or fails out of it).
  const sessionErroredForSteerGate = activeThread?.session?.status === "error";
  const activeTurnIdForSteerGate = activeThread?.session?.activeTurnId ?? null;

  useEffect(() => {
    if (!queuedSteerGate) {
      return;
    }
    const transition = resolveQueuedSteerGateTransition({
      gate: queuedSteerGate,
      phase,
      sessionErrored: sessionErroredForSteerGate,
      activeTurnId: activeTurnIdForSteerGate,
      now: Date.now(),
    });
    if (transition.kind === "clear") {
      setQueuedSteerGate(null);
      clearQueuedComposerSteerGate(threadId);
      return;
    }
    if (
      transition.gate.sawInterruptGap !== queuedSteerGate.sawInterruptGap ||
      transition.gate.gapStartedAt !== queuedSteerGate.gapStartedAt ||
      transition.gate.armedActiveTurnId !== queuedSteerGate.armedActiveTurnId
    ) {
      setQueuedSteerGate(transition.gate);
      armQueuedComposerSteerGate(threadId, transition.gate);
      return;
    }
    if (transition.expiresInMs === null) {
      return;
    }
    const timer = window.setTimeout(() => {
      setQueuedSteerGate(null);
      clearQueuedComposerSteerGate(threadId);
    }, transition.expiresInMs);
    return () => window.clearTimeout(timer);
  }, [
    setQueuedSteerGate,
    activeTurnIdForSteerGate,
    phase,
    queuedSteerGate,
    sessionErroredForSteerGate,
    threadId,
  ]);

  useEffect(() => {
    if (
      isQueuedComposerAwaitingTurnStart(threadId) ||
      resolveQueuedComposerAutoDispatchHold({
        localDispatch,
        // A mini-composer submission queues the first turn before the draft has a session.
        phase: isLocalDraftThread ? "ready" : phase,
        latestTurn: activeLatestTurn,
        session: activeThread?.session ?? null,
        messages: activeThread?.messages ?? EMPTY_MESSAGES,
        isConnecting,
        queuedSteerGate: getQueuedComposerSteerGate(threadId) ?? queuedSteerGate,
        hasPendingApproval: activePendingApproval !== null,
        hasPendingProgress: activePendingProgress !== null,
        hasPendingUserInput: pendingUserInputs.length > 0,
        queuedTurnCount: queuedComposerTurns.length,
        threadError: activeThread?.error,
        now: Date.now(),
      })
    ) {
      return;
    }
    if (
      autoDispatchingQueuedTurnRef.current ||
      sendInFlightRef.current ||
      sendPreflightInFlightRef.current
    ) {
      // These guards are refs, so nothing re-triggers this effect once they
      // reset; poll until the in-flight send settles instead of leaving the
      // queue stuck at the end of a turn.
      const timer = window.setTimeout(() => setQueuedAutoDispatchTick((tick) => tick + 1), 250);
      return () => window.clearTimeout(timer);
    }
    const nextQueuedTurn = queuedComposerTurns[0];
    if (!nextQueuedTurn) {
      return;
    }
    const retryDelay = getQueuedComposerAutoDispatchRetryDelay(threadId, nextQueuedTurn.id);
    if (retryDelay === null) {
      return;
    }
    if (retryDelay !== undefined && retryDelay > 0) {
      const timer = window.setTimeout(
        () => setQueuedAutoDispatchTick((tick) => tick + 1),
        retryDelay,
      );
      return () => window.clearTimeout(timer);
    }
    if (!tryBeginQueuedComposerAutoDispatch(threadId)) {
      // The watcher already owns this thread's queue head (background drain
      // started before this ChatView claimed). Poll until that send settles.
      const timer = window.setTimeout(() => setQueuedAutoDispatchTick((tick) => tick + 1), 250);
      return () => window.clearTimeout(timer);
    }
    autoDispatchingQueuedTurnRef.current = true;
    void runLockedQueuedComposerAutoDispatch({
      threadId,
      run: async () => {
        const succeeded = await dispatchQueuedComposerTurn(nextQueuedTurn, "queue");
        if (succeeded) {
          clearQueuedComposerAutoDispatchRetry(threadId);
          removeQueuedComposerTurnFromDraft(threadId, nextQueuedTurn.id);
          return;
        }
        recordQueuedComposerAutoDispatchFailure(threadId, nextQueuedTurn.id);
        setQueuedAutoDispatchTick((tick) => tick + 1);
      },
      onSettled: () => {
        autoDispatchingQueuedTurnRef.current = false;
      },
    });
  }, [
    autoDispatchingQueuedTurnRef,
    setQueuedAutoDispatchTick,
    sendInFlightRef,
    sendPreflightInFlightRef,
    activeLatestTurn,
    activePendingApproval,
    activePendingProgress,
    activeThread?.error,
    activeThread?.messages,
    activeThread?.session,
    dispatchQueuedComposerTurn,
    isConnecting,
    isLocalDraftThread,
    localDispatch,
    pendingUserInputs.length,
    phase,
    queuedAutoDispatchTick,
    queuedComposerTurns,
    queuedSteerGate,
    removeQueuedComposerTurnFromDraft,
    threadId,
  ]);
  return {
    setQueuedSteerGate,
    removeQueuedComposerTurn,
    onSteerQueuedComposerTurn,
    onEditQueuedComposerTurn,
  };
}
