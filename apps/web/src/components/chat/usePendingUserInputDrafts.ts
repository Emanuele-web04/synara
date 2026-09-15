import type { OrchestrationPendingInteraction, ThreadId } from "@synara/contracts";
import { pendingRequestInstanceKey } from "@synara/shared/threadSummary";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useComposerDraftStore, useComposerThreadDraft } from "../../composerDraftStore";
import type { PendingUserInput } from "../../pendingInteractionDerivation";
import type { PendingUserInputDraftAnswer } from "../../pendingUserInput";
import type { PendingUserInputRecoveryDraft } from "../../pendingUserInputRecovery";

type Answers = Record<string, Record<string, PendingUserInputDraftAnswer>>;
const EMPTY_DRAFTS: Record<string, PendingUserInputRecoveryDraft> = {};

function draftAnswers(drafts: Record<string, PendingUserInputRecoveryDraft>): Answers {
  return Object.fromEntries(Object.entries(drafts).map(([key, draft]) => [key, draft.answers]));
}

export function usePendingUserInputDrafts(
  threadId: ThreadId,
  requests: ReadonlyArray<PendingUserInput>,
  interactions: ReadonlyArray<OrchestrationPendingInteraction> | undefined,
) {
  const drafts = useComposerThreadDraft(threadId).pendingUserInputDrafts ?? EMPTY_DRAFTS;
  const answers = useMemo(() => draftAnswers(drafts), [drafts]);
  const answersRef = useRef<Answers>(answers);
  const requestsRef = useRef(requests);
  useLayoutEffect(() => {
    answersRef.current = answers;
    requestsRef.current = requests;
  }, [answers, requests, threadId]);

  const setAnswers = useCallback(
    (update: (existing: Answers) => Answers) => {
      const store = useComposerDraftStore.getState();
      const existing = store.draftsByThreadId[threadId]?.pendingUserInputDrafts ?? EMPTY_DRAFTS;
      const nextAnswers = update(draftAnswers(existing));
      const nextDrafts = { ...existing };
      for (const [key, requestAnswers] of Object.entries(nextAnswers)) {
        const request =
          existing[key]?.request ??
          requestsRef.current.find(
            (entry) =>
              pendingRequestInstanceKey(entry.requestId, entry.lifecycleGeneration) === key,
          );
        if (request) nextDrafts[key] = { request, answers: requestAnswers };
      }
      answersRef.current = nextAnswers;
      store.setPendingUserInputDrafts(threadId, nextDrafts);
    },
    [threadId],
  );

  // Command acceptance is not delivery. Keep the answer through transient
  // failures and only discard it after authoritative settlement.
  useEffect(() => {
    const confirmed = new Set(
      (interactions ?? [])
        .filter((row) => row.interactionKind === "userInput" && row.status === "confirmed")
        .map((row) =>
          pendingRequestInstanceKey(row.requestId, row.lifecycleGeneration ?? undefined),
        ),
    );
    if (!Object.keys(drafts).some((key) => confirmed.has(key))) return;
    useComposerDraftStore
      .getState()
      .setPendingUserInputDrafts(
        threadId,
        Object.fromEntries(Object.entries(drafts).filter(([key]) => !confirmed.has(key))),
      );
  }, [drafts, interactions, threadId]);

  return { answers, answersRef, setAnswers, drafts };
}
