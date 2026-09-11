import {
  RuntimeMode,
  ThreadId,
  type ApprovalRequestId,
  type ProviderApprovalDecision,
  type ProviderRequestKind,
  type ProviderUserInputAnswers,
} from "@synara/contracts";
import {
  APPROVAL_ALREADY_ANSWERED_INVARIANT_MARKER,
  collectErrorMessages,
  describeErrorMessage,
} from "@synara/shared/errorMessages";
import { respondingInteractionReclaimAt } from "@synara/shared/pendingInteractions";
import { pendingRequestInstanceKey } from "@synara/shared/threadSummary";
import type { Dispatch, RefObject, SetStateAction } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { newCommandId } from "~/lib/utils";
import { readNativeApi } from "~/nativeApi";
import {
  collapseExpandedComposerCursor,
  detectComposerTrigger,
  expandCollapsedComposerCursor,
  type ComposerTrigger,
} from "../../composer-logic";
import { useComposerDraftStore } from "../../composerDraftStore";
import {
  buildPendingUserInputAnswers,
  derivePendingUserInputProgress,
  hasCompletePendingUserInputAnswers,
  omitNullPendingUserInputAnswers,
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
  type PendingUserInputDraftAnswer,
} from "../../pendingUserInput";
import { expiredUserInputDrafts } from "../../pendingUserInputRecovery";
import { derivePendingApprovals, derivePendingUserInputs } from "../../session-logic";
import { useStore } from "../../store";
import {
  buildThreadSubscribeInput,
  clearThreadDetailResumeCursor,
} from "../../threadDetailResumeCursors";
import { type Thread } from "../../types";
import { resolveRuntimeModeAfterApprovalDecision } from "../ChatView.logic";
import { usePendingUserInputDrafts } from "./usePendingUserInputDrafts";
const EMPTY_ACTIVITIES: Thread["activities"] = [];
const EMPTY_PENDING_USER_INPUT_ANSWERS: Record<string, PendingUserInputDraftAnswer> = {};
interface ChatPendingInteractionsInput {
  threadId: ThreadId;
  activeThread: Thread | undefined;
  runtimeMode: RuntimeMode;
  promptRef: RefObject<string>;
  setPrompt: (prompt: string) => void;
  setComposerCursor: Dispatch<SetStateAction<number>>;
  setComposerTrigger: Dispatch<SetStateAction<ComposerTrigger | null>>;
  setComposerHighlightedItemId: Dispatch<SetStateAction<string | null>>;
}

export function useChatPendingInteractions({
  threadId,
  activeThread,
  runtimeMode,
  promptRef,
  setPrompt,
  setComposerCursor,
  setComposerTrigger,
  setComposerHighlightedItemId,
}: ChatPendingInteractionsInput) {
  const activeThreadId = activeThread?.id ?? null;
  const threadActivities = activeThread?.activities ?? EMPTY_ACTIVITIES;
  const setStoreThreadError = useStore((store) => store.setError);
  const setComposerDraftRuntimeMode = useComposerDraftStore((state) => state.setRuntimeMode);
  const [respondingRequestKeys, setRespondingRequestKeys] = useState<string[]>([]);
  const [respondingUserInputRequestKeys, setRespondingUserInputRequestKeys] = useState<string[]>(
    [],
  );
  const [pendingUserInputQuestionIndexByRequestId, setPendingUserInputQuestionIndexByRequestId] =
    useState<Record<string, number>>({});

  const pendingApprovals = useMemo(
    () =>
      derivePendingApprovals(threadActivities, activeThread?.pendingInteractions, {
        authoritativeHasPending: activeThread?.hasPendingApprovals,
        latestTurnId: activeThread?.latestTurn?.turnId,
      }),
    [
      activeThread?.hasPendingApprovals,
      activeThread?.latestTurn?.turnId,
      activeThread?.pendingInteractions,
      threadActivities,
    ],
  );
  const nextUserInputResponseReclaimAt = useMemo(() => {
    let earliest: string | null = null;
    for (const interaction of activeThread?.pendingInteractions ?? []) {
      if (interaction.interactionKind !== "userInput" || interaction.status !== "responding") {
        continue;
      }
      if (interaction.responseRequestedAt === null) {
        return new Date(0).toISOString();
      }
      const reclaimAt = respondingInteractionReclaimAt(interaction.responseRequestedAt);
      if (earliest === null || reclaimAt < earliest) {
        earliest = reclaimAt;
      }
    }
    return earliest;
  }, [activeThread?.pendingInteractions]);
  const [userInputResponseClaimReferenceAt, setUserInputResponseClaimReferenceAt] = useState(() =>
    new Date().toISOString(),
  );
  useEffect(() => {
    if (nextUserInputResponseReclaimAt === null) {
      return;
    }
    const delayMs = Math.max(0, Date.parse(nextUserInputResponseReclaimAt) - Date.now());
    const timeoutId = window.setTimeout(() => {
      setUserInputResponseClaimReferenceAt(new Date().toISOString());
    }, delayMs);
    return () => window.clearTimeout(timeoutId);
  }, [nextUserInputResponseReclaimAt]);
  const pendingUserInputs = useMemo(
    () =>
      derivePendingUserInputs(threadActivities, activeThread?.pendingInteractions, {
        authoritativeHasPending: activeThread?.hasPendingUserInput,
        latestTurnId: activeThread?.latestTurn?.turnId,
        responseClaimReferenceAt: userInputResponseClaimReferenceAt,
      }),
    [
      activeThread?.hasPendingUserInput,
      activeThread?.latestTurn?.turnId,
      activeThread?.pendingInteractions,
      threadActivities,
      userInputResponseClaimReferenceAt,
    ],
  );
  const {
    answers: pendingUserInputAnswersByRequestId,
    answersRef: pendingUserInputAnswersByRequestIdRef,
    setAnswers: setPendingUserInputAnswersByRequestId,
    drafts: pendingUserInputDrafts,
  } = usePendingUserInputDrafts(threadId, pendingUserInputs, activeThread?.pendingInteractions);
  const expiredQuestionDrafts = useMemo(
    () => expiredUserInputDrafts(pendingUserInputDrafts, threadActivities),
    [pendingUserInputDrafts, threadActivities],
  );
  const activePendingUserInput = pendingUserInputs[0] ?? null;
  const activePendingUserInputKey = activePendingUserInput
    ? pendingRequestInstanceKey(
        activePendingUserInput.requestId,
        activePendingUserInput.lifecycleGeneration,
      )
    : null;
  const activePendingDraftAnswers = useMemo(
    () =>
      activePendingUserInputKey
        ? (pendingUserInputAnswersByRequestId[activePendingUserInputKey] ??
          EMPTY_PENDING_USER_INPUT_ANSWERS)
        : EMPTY_PENDING_USER_INPUT_ANSWERS,
    [activePendingUserInputKey, pendingUserInputAnswersByRequestId],
  );
  const activePendingQuestionIndex = activePendingUserInputKey
    ? (pendingUserInputQuestionIndexByRequestId[activePendingUserInputKey] ?? 0)
    : 0;
  const activePendingProgress = useMemo(
    () =>
      activePendingUserInput
        ? derivePendingUserInputProgress(
            activePendingUserInput.questions,
            activePendingDraftAnswers,
            activePendingQuestionIndex,
          )
        : null,
    [activePendingDraftAnswers, activePendingQuestionIndex, activePendingUserInput],
  );
  // Read once here for the same reason as `activeLatestTurnId`: an `activePendingProgress?.x`
  // read inside a memo body makes React Compiler infer `activePendingProgress` as the
  // dependency, which no longer matches the hand-written property-path dep.
  const activePendingQuestion = activePendingProgress?.activeQuestion ?? null;
  const activePendingResolvedAnswers = useMemo(
    () =>
      activePendingUserInput
        ? buildPendingUserInputAnswers(activePendingUserInput.questions, activePendingDraftAnswers)
        : null,
    [activePendingDraftAnswers, activePendingUserInput],
  );
  const activePendingIsResponding = activePendingUserInputKey
    ? respondingUserInputRequestKeys.includes(activePendingUserInputKey)
    : false;

  const activePendingApproval = pendingApprovals[0] ?? null;

  const lastSyncedPendingInputRef = useRef<{
    requestId: string | null;
    questionId: string | null;
  } | null>(null);

  useEffect(() => {
    const nextCustomAnswer = activePendingProgress?.customAnswer;
    if (typeof nextCustomAnswer !== "string") {
      lastSyncedPendingInputRef.current = null;
      return;
    }
    const nextRequestId = activePendingUserInput?.requestId ?? null;
    const nextQuestionId = activePendingProgress?.activeQuestion?.id ?? null;
    const questionChanged =
      lastSyncedPendingInputRef.current?.requestId !== nextRequestId ||
      lastSyncedPendingInputRef.current?.questionId !== nextQuestionId;
    const textChangedExternally = promptRef.current !== nextCustomAnswer;

    lastSyncedPendingInputRef.current = {
      requestId: nextRequestId,
      questionId: nextQuestionId,
    };

    if (!questionChanged && !textChangedExternally) {
      return;
    }

    promptRef.current = nextCustomAnswer;
    const nextCursor = collapseExpandedComposerCursor(nextCustomAnswer, nextCustomAnswer.length);
    setComposerCursor(nextCursor);
    setComposerTrigger(
      detectComposerTrigger(
        nextCustomAnswer,
        expandCollapsedComposerCursor(nextCustomAnswer, nextCursor),
      ),
    );
    setComposerHighlightedItemId(null);
  }, [
    promptRef,
    setComposerCursor,
    setComposerTrigger,
    setComposerHighlightedItemId,
    activePendingProgress?.customAnswer,
    activePendingUserInput?.requestId,
    activePendingProgress?.activeQuestion?.id,
  ]);

  const onRespondToApproval = useCallback(
    async (
      requestId: ApprovalRequestId,
      decision: ProviderApprovalDecision,
      lifecycleGeneration?: string,
      requestKind?: ProviderRequestKind,
    ) => {
      const api = readNativeApi();
      if (!api || !activeThreadId) return;
      const requestKey = pendingRequestInstanceKey(requestId, lifecycleGeneration);

      setRespondingRequestKeys((existing) =>
        existing.includes(requestKey) ? existing : [...existing, requestKey],
      );
      // Persist supervised "always allow" client-side so the next turn (after an
      // idle-stop or runtime restart) uses full access. Auto remains the durable
      // thread policy; its server-side override applies only to the live session.
      const durableRuntimeMode = resolveRuntimeModeAfterApprovalDecision(
        runtimeMode,
        decision,
        requestKind,
      );
      if (durableRuntimeMode) {
        setComposerDraftRuntimeMode(activeThreadId, durableRuntimeMode);
      }
      await api.orchestration
        .dispatchCommand({
          type: "thread.approval.respond",
          commandId: newCommandId(),
          threadId: activeThreadId,
          requestId,
          decision,
          ...(lifecycleGeneration !== undefined ? { lifecycleGeneration } : {}),
          createdAt: new Date().toISOString(),
        })
        .catch(async (err: unknown) => {
          if (
            collectErrorMessages(err).some((message) =>
              message.includes(APPROVAL_ALREADY_ANSWERED_INVARIANT_MARKER),
            )
          ) {
            // The authoritative response won the race. Force a full detail
            // snapshot so a stale local card cannot immediately submit again.
            clearThreadDetailResumeCursor(activeThreadId);
            await api.orchestration
              .subscribeThread(buildThreadSubscribeInput(activeThreadId))
              .catch(() => {
                setStoreThreadError(
                  activeThreadId,
                  "Approval was already recorded, but the conversation could not be refreshed.",
                );
              });
            return;
          }
          setStoreThreadError(
            activeThreadId,
            describeErrorMessage(err, "Failed to submit approval decision."),
          );
          setRespondingRequestKeys((existing) => existing.filter((key) => key !== requestKey));
          throw err;
        });
      setRespondingRequestKeys((existing) => existing.filter((key) => key !== requestKey));
    },
    [activeThreadId, runtimeMode, setComposerDraftRuntimeMode, setStoreThreadError],
  );

  const userInputSubmissionsRef = useRef(new Set<string>());
  const [userInputSubmissionVersion, setUserInputSubmissionVersion] = useState(0);
  const onRespondToUserInput = useCallback(
    async (
      requestId: ApprovalRequestId,
      answers: ProviderUserInputAnswers,
      lifecycleGeneration?: string,
    ) => {
      const api = readNativeApi();
      if (!api || !activeThreadId) return;
      const requestKey = pendingRequestInstanceKey(requestId, lifecycleGeneration);
      const submissionKey = `${activeThreadId}:${requestKey}`;
      if (userInputSubmissionsRef.current.has(submissionKey)) return;
      userInputSubmissionsRef.current.add(submissionKey);
      setUserInputSubmissionVersion((version) => version + 1);
      const dispatchAnswers = hasCompletePendingUserInputAnswers(answers)
        ? answers
        : omitNullPendingUserInputAnswers(answers);

      setRespondingUserInputRequestKeys((existing) =>
        existing.includes(requestKey) ? existing : [...existing, requestKey],
      );
      await Promise.resolve()
        .then(async () => {
          await api.orchestration.dispatchCommand({
            type: "thread.user-input.respond",
            commandId: newCommandId(),
            threadId: activeThreadId,
            requestId,
            answers: dispatchAnswers,
            ...(lifecycleGeneration !== undefined ? { lifecycleGeneration } : {}),
            createdAt: new Date().toISOString(),
          });
          // Refresh identities and settlement after command acceptance; acceptance
          // alone does not mean Claude received the answer.
          clearThreadDetailResumeCursor(activeThreadId);
          await api.orchestration.subscribeThread(buildThreadSubscribeInput(activeThreadId));
        })
        .catch((err: unknown) => {
          setStoreThreadError(
            activeThreadId,
            describeErrorMessage(
              err,
              "Could not submit or refresh the answer. Your answers are saved.",
            ),
          );
        })
        .finally(() => {
          userInputSubmissionsRef.current.delete(submissionKey);
          setRespondingUserInputRequestKeys((existing) =>
            existing.filter((key) => key !== requestKey),
          );
        });
    },
    [activeThreadId, setStoreThreadError],
  );

  const onCancelActivePendingUserInput = useCallback(() => {
    if (!activePendingUserInput || activePendingIsResponding) {
      return;
    }
    promptRef.current = "";
    setPrompt("");
    setComposerCursor(0);
    setComposerTrigger(null);
    void onRespondToUserInput(
      activePendingUserInput.requestId,
      {},
      activePendingUserInput.lifecycleGeneration,
    );
  }, [
    promptRef,
    setComposerCursor,
    setComposerTrigger,
    activePendingIsResponding,
    activePendingUserInput,
    onRespondToUserInput,
    setPrompt,
  ]);

  const setActivePendingUserInputQuestionIndex = useCallback(
    (nextQuestionIndex: number) => {
      if (!activePendingUserInputKey) {
        return;
      }
      setPendingUserInputQuestionIndexByRequestId((existing) => ({
        ...existing,
        [activePendingUserInputKey]: nextQuestionIndex,
      }));
    },
    [activePendingUserInputKey],
  );

  const onToggleActivePendingUserInputOption = useCallback(
    (questionId: string, optionLabel: string) => {
      if (!activePendingUserInput || !activePendingUserInputKey) {
        return null;
      }
      const question = activePendingUserInput.questions.find((entry) => entry.id === questionId);
      if (!question) {
        return null;
      }
      const nextDraftAnswer = togglePendingUserInputOptionSelection(
        question,
        pendingUserInputAnswersByRequestIdRef.current[activePendingUserInputKey]?.[questionId],
        optionLabel,
      );
      const nextRequestAnswers = {
        ...pendingUserInputAnswersByRequestIdRef.current[activePendingUserInputKey],
        [questionId]: nextDraftAnswer,
      };
      pendingUserInputAnswersByRequestIdRef.current = {
        ...pendingUserInputAnswersByRequestIdRef.current,
        [activePendingUserInputKey]: nextRequestAnswers,
      };
      setPendingUserInputAnswersByRequestId((existing) => ({
        ...existing,
        [activePendingUserInputKey]: nextRequestAnswers,
      }));
      promptRef.current = "";
      setComposerCursor(0);
      setComposerTrigger(null);
      return nextDraftAnswer;
    },
    [
      promptRef,
      setComposerCursor,
      setComposerTrigger,
      activePendingUserInput,
      activePendingUserInputKey,
      pendingUserInputAnswersByRequestIdRef,
      setPendingUserInputAnswersByRequestId,
    ],
  );

  const onChangeActivePendingUserInputCustomAnswer = useCallback(
    (
      questionId: string,
      value: string,
      nextCursor: number,
      expandedCursor: number,
      cursorAdjacentToMention: boolean,
    ) => {
      if (!activePendingUserInputKey) {
        return;
      }
      promptRef.current = value;
      const nextDraftAnswer = setPendingUserInputCustomAnswer(
        pendingUserInputAnswersByRequestIdRef.current[activePendingUserInputKey]?.[questionId],
        value,
      );
      const nextRequestAnswers = {
        ...pendingUserInputAnswersByRequestIdRef.current[activePendingUserInputKey],
        [questionId]: nextDraftAnswer,
      };
      pendingUserInputAnswersByRequestIdRef.current = {
        ...pendingUserInputAnswersByRequestIdRef.current,
        [activePendingUserInputKey]: nextRequestAnswers,
      };
      setPendingUserInputAnswersByRequestId((existing) => ({
        ...existing,
        [activePendingUserInputKey]: nextRequestAnswers,
      }));
      setComposerCursor(nextCursor);
      setComposerTrigger(
        cursorAdjacentToMention ? null : detectComposerTrigger(value, expandedCursor),
      );
    },
    [
      promptRef,
      setComposerCursor,
      setComposerTrigger,
      activePendingUserInputKey,
      pendingUserInputAnswersByRequestIdRef,
      setPendingUserInputAnswersByRequestId,
    ],
  );

  const onAdvanceActivePendingUserInput = useCallback(
    (answerOverrides?: Record<string, PendingUserInputDraftAnswer>): boolean => {
      if (!activePendingUserInput || !activePendingUserInputKey || !activePendingProgress) {
        return false;
      }
      const pendingDraftAnswers =
        answerOverrides && Object.keys(answerOverrides).length > 0
          ? {
              ...pendingUserInputAnswersByRequestIdRef.current[activePendingUserInputKey],
              ...answerOverrides,
            }
          : (pendingUserInputAnswersByRequestIdRef.current[activePendingUserInputKey] ??
            activePendingDraftAnswers);
      if (answerOverrides && Object.keys(answerOverrides).length > 0) {
        pendingUserInputAnswersByRequestIdRef.current = {
          ...pendingUserInputAnswersByRequestIdRef.current,
          [activePendingUserInputKey]: pendingDraftAnswers,
        };
        setPendingUserInputAnswersByRequestId((existing) => ({
          ...existing,
          [activePendingUserInputKey]: pendingDraftAnswers,
        }));
      }
      const resolvedAnswers = buildPendingUserInputAnswers(
        activePendingUserInput.questions,
        pendingDraftAnswers,
      );
      if (activePendingProgress.isLastQuestion) {
        if (resolvedAnswers) {
          void onRespondToUserInput(
            activePendingUserInput.requestId,
            resolvedAnswers,
            activePendingUserInput.lifecycleGeneration,
          );
          return true;
        }
        return false;
      }
      const activeQuestionId = activePendingProgress.activeQuestion?.id ?? null;
      const hasActiveOverride = activeQuestionId
        ? answerOverrides?.[activeQuestionId] !== undefined
        : false;
      if (!activePendingProgress.canAdvance && !hasActiveOverride) {
        return false;
      }
      setActivePendingUserInputQuestionIndex(activePendingProgress.questionIndex + 1);
      return true;
    },
    [
      activePendingDraftAnswers,
      activePendingProgress,
      activePendingUserInput,
      activePendingUserInputKey,
      onRespondToUserInput,
      setActivePendingUserInputQuestionIndex,
      setPendingUserInputAnswersByRequestId,
      pendingUserInputAnswersByRequestIdRef,
    ],
  );

  const onPreviousActivePendingUserInputQuestion = useCallback(() => {
    if (!activePendingProgress) {
      return;
    }
    setActivePendingUserInputQuestionIndex(Math.max(activePendingProgress.questionIndex - 1, 0));
  }, [activePendingProgress, setActivePendingUserInputQuestionIndex]);
  return {
    respondingRequestKeys,
    pendingApprovals,
    pendingUserInputs,
    pendingUserInputAnswersByRequestIdRef,
    setPendingUserInputAnswersByRequestId,
    expiredQuestionDrafts,
    activePendingUserInput,
    activePendingUserInputKey,
    activePendingDraftAnswers,
    activePendingQuestionIndex,
    activePendingProgress,
    activePendingQuestion,
    activePendingResolvedAnswers,
    activePendingIsResponding,
    activePendingApproval,
    onRespondToApproval,
    userInputSubmissionVersion,
    onCancelActivePendingUserInput,
    onToggleActivePendingUserInputOption,
    onChangeActivePendingUserInputCustomAnswer,
    onAdvanceActivePendingUserInput,
    onPreviousActivePendingUserInputQuestion,
  };
}
