import type { OrchestrationThreadActivity, ThreadId } from "@synara/contracts";
import { pendingRequestInstanceKey } from "@synara/shared/threadSummary";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useComposerDraftStore, useComposerThreadDraft } from "../../composerDraftStore";
import type { PendingUserInput } from "../../pendingInteractionDerivation";
import type { PendingUserInputDraftAnswer } from "../../pendingUserInput";
import type { PendingUserInputRecoveryDraft } from "../../pendingUserInputRecovery";
import { asActivityRecord } from "../../storeNormalization";

type Answers = Record<string, Record<string, PendingUserInputDraftAnswer>>;
const EMPTY_DRAFTS: Record<string, PendingUserInputRecoveryDraft> = {};

function draftAnswers(drafts: Record<string, PendingUserInputRecoveryDraft>): Answers {
  return Object.fromEntries(Object.entries(drafts).map(([key, draft]) => [key, draft.answers]));
}

export function usePendingUserInputDrafts(
  threadId: ThreadId,
  requests: ReadonlyArray<PendingUserInput>,
  activities: ReadonlyArray<OrchestrationThreadActivity>,
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

  // Only a provider resolution proves delivery. Terminal stale rows must keep
  // their undelivered drafts, even after the invalidation activity is pruned.
  useEffect(() => {
    if (Object.keys(drafts).length === 0) return;
    const resolvedInstances = new Set<string>();
    const legacyResolvedAt = new Map<string, string>();
    for (const activity of activities) {
      if (activity.kind !== "user-input.resolved") continue;
      const payload = asActivityRecord(activity.payload);
      if (typeof payload?.requestId !== "string") continue;
      const generation = payload.lifecycleGeneration;
      if (typeof generation === "string" && generation.length > 0) {
        resolvedInstances.add(pendingRequestInstanceKey(payload.requestId, generation));
      } else if (activity.createdAt > (legacyResolvedAt.get(payload.requestId) ?? "")) {
        legacyResolvedAt.set(payload.requestId, activity.createdAt);
      }
    }
    const confirmed = new Set(
      Object.entries(drafts)
        .filter(
          ([key, draft]) =>
            resolvedInstances.has(key) ||
            (legacyResolvedAt.get(draft.request.requestId) ?? "") >= draft.request.createdAt,
        )
        .map(([key]) => key),
    );
    if (!Object.keys(drafts).some((key) => confirmed.has(key))) return;
    useComposerDraftStore
      .getState()
      .setPendingUserInputDrafts(
        threadId,
        Object.fromEntries(Object.entries(drafts).filter(([key]) => !confirmed.has(key))),
      );
  }, [drafts, activities, threadId]);

  return { answers, answersRef, setAnswers, drafts };
}
