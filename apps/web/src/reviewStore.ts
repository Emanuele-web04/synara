// FILE: reviewStore.ts
// Purpose: Persist the selected review source per scope and hold optimistic
//          inline-comment drafts keyed by review target.
// Layer: UI state store
// Exports: review store hook, a per-scope source selector, and a per-target draft selector.

import type {
  ReviewCommentSide,
  ReviewFinding,
  ReviewLocalComment,
  ReviewAgentResult,
  ReviewSourceRef,
  ReviewTargetKey,
} from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import {
  type ReviewAgentFindingsByTarget,
  type ReviewDraftComment,
  type ReviewDraftsByTarget,
  type ReviewSourceByScope,
  beginDraftInState,
  clearAgentFindingsInState,
  clearSourceInState,
  discardDraftInState,
  dismissAgentFindingInState,
  editDraftInState,
  reconcileDraftsInState,
  reviewTargetKeyString,
  sanitizeReviewSourceByScope,
  selectCurrentAgentFindingsFromState,
  setAgentFindingsInState,
  setSourceInState,
} from "./reviewStore.logic";

const REVIEW_STORAGE_KEY = "synara:review-state:v1";

let draftSequence = 0;
function nextDraftId(): string {
  draftSequence += 1;
  return `draft-${draftSequence}`;
}

interface ReviewStore {
  sourceByScope: ReviewSourceByScope;
  draftCommentsByTarget: ReviewDraftsByTarget;
  agentFindingsByTarget: ReviewAgentFindingsByTarget;
  setSource: (scope: string, source: ReviewSourceRef) => void;
  clearSource: (scope: string) => void;
  setAgentFindings: (target: ReviewTargetKey, result: ReviewAgentResult) => void;
  clearAgentFindings: (target: ReviewTargetKey) => void;
  dismissFinding: (target: ReviewTargetKey, finding: ReviewFinding) => void;
  beginDraft: (input: {
    target: ReviewTargetKey;
    path: string;
    line: number;
    side: ReviewCommentSide;
    threadId?: string | null;
    body?: string;
  }) => string;
  editDraft: (
    target: ReviewTargetKey,
    draftId: string,
    patch: Partial<Pick<ReviewDraftComment, "body" | "status" | "serverId">>,
  ) => void;
  discardDraft: (target: ReviewTargetKey, draftId: string) => void;
  reconcile: (target: ReviewTargetKey, serverComments: ReadonlyArray<ReviewLocalComment>) => void;
}

export const useReviewStore = create<ReviewStore>()(
  persist(
    (set) => ({
      sourceByScope: {},
      draftCommentsByTarget: {},
      agentFindingsByTarget: {},
      setSource: (scope, source) =>
        set((store) => {
          const next = setSourceInState(store.sourceByScope, scope, source);
          return next === store.sourceByScope ? {} : { sourceByScope: next };
        }),
      clearSource: (scope) =>
        set((store) => {
          const next = clearSourceInState(store.sourceByScope, scope);
          return next === store.sourceByScope ? {} : { sourceByScope: next };
        }),
      setAgentFindings: (target, result) =>
        set((store) => {
          const next = setAgentFindingsInState(
            store.agentFindingsByTarget,
            reviewTargetKeyString(target),
            result,
          );
          return next === store.agentFindingsByTarget ? {} : { agentFindingsByTarget: next };
        }),
      clearAgentFindings: (target) =>
        set((store) => {
          const next = clearAgentFindingsInState(
            store.agentFindingsByTarget,
            reviewTargetKeyString(target),
          );
          return next === store.agentFindingsByTarget ? {} : { agentFindingsByTarget: next };
        }),
      dismissFinding: (target, finding) =>
        set((store) => {
          const next = dismissAgentFindingInState(
            store.agentFindingsByTarget,
            reviewTargetKeyString(target),
            finding,
          );
          return next === store.agentFindingsByTarget ? {} : { agentFindingsByTarget: next };
        }),
      beginDraft: (input) => {
        const draftId = nextDraftId();
        set((store) => ({
          draftCommentsByTarget: beginDraftInState(
            store.draftCommentsByTarget,
            reviewTargetKeyString(input.target),
            {
              draftId,
              path: input.path,
              line: input.line,
              side: input.side,
              threadId: input.threadId ?? null,
              body: input.body ?? "",
            },
          ),
        }));
        return draftId;
      },
      editDraft: (target, draftId, patch) =>
        set((store) => {
          const next = editDraftInState(
            store.draftCommentsByTarget,
            reviewTargetKeyString(target),
            draftId,
            patch,
          );
          return next === store.draftCommentsByTarget ? {} : { draftCommentsByTarget: next };
        }),
      discardDraft: (target, draftId) =>
        set((store) => {
          const next = discardDraftInState(
            store.draftCommentsByTarget,
            reviewTargetKeyString(target),
            draftId,
          );
          return next === store.draftCommentsByTarget ? {} : { draftCommentsByTarget: next };
        }),
      reconcile: (target, serverComments) =>
        set((store) => {
          const next = reconcileDraftsInState(
            store.draftCommentsByTarget,
            reviewTargetKeyString(target),
            serverComments,
          );
          return next === store.draftCommentsByTarget ? {} : { draftCommentsByTarget: next };
        }),
    }),
    {
      name: REVIEW_STORAGE_KEY,
      storage: createJSONStorage(() => localStorage),
      // Only the source selection survives reload; optimistic drafts are session state.
      partialize: (store) => ({ sourceByScope: store.sourceByScope }),
      merge: (persisted, current) => ({
        ...current,
        sourceByScope: sanitizeReviewSourceByScope(
          (persisted as { sourceByScope?: unknown } | undefined)?.sourceByScope,
        ),
      }),
    },
  ),
);

export function selectReviewSource(scope: string) {
  return (store: ReviewStore): ReviewSourceRef | null => store.sourceByScope[scope] ?? null;
}

export function selectReviewDrafts(targetKey: string) {
  return (store: ReviewStore): ReadonlyArray<ReviewDraftComment> =>
    store.draftCommentsByTarget[targetKey] ?? EMPTY_DRAFTS;
}

export function selectReviewAgentFindings(
  target: ReviewTargetKey | null,
  patchSignature: string | null = null,
  headSha: string | null = null,
) {
  const targetKey = target ? reviewTargetKeyString(target) : null;
  return (store: ReviewStore): ReadonlyArray<ReviewFinding> => {
    if (!targetKey) {
      return EMPTY_FINDINGS;
    }
    const findings = selectCurrentAgentFindingsFromState(
      store.agentFindingsByTarget,
      targetKey,
      patchSignature,
      headSha,
    );
    return findings.length > 0 ? findings : EMPTY_FINDINGS;
  };
}

const EMPTY_DRAFTS: ReadonlyArray<ReviewDraftComment> = [];
const EMPTY_FINDINGS: ReadonlyArray<ReviewFinding> = [];
