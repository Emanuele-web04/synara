// FILE: reviewStore.logic.ts
// Purpose: Pure, testable transitions and persisted-state sanitizing for the review source store.
// Layer: UI state helpers
// Exports: source-per-scope transitions and a persisted-shape sanitizer.

import type {
  ReviewAgentResult,
  ReviewCommentSide,
  ReviewFinding,
  ReviewLocalComment,
  ReviewTargetKey,
} from "@t3tools/contracts";
import { ReviewSourceRef } from "@t3tools/contracts";
import { Schema } from "effect";
import { serializeReviewTargetKey } from "@t3tools/shared/reviewTargetKey";
import { sanitizeStringKeyedRecord } from "./persistedRecord";

export type ReviewSourceByScope = Record<string, ReviewSourceRef>;

// One stable string form of a target, shared by the React Query cache key and the
// draft store so list/add/update/remove all key the same entry.
export function reviewTargetKeyString(target: ReviewTargetKey): string {
  return serializeReviewTargetKey(target);
}

export type ReviewDraftStatus = "editing" | "saving" | "saved";

export interface ReviewDraftComment {
  draftId: string;
  path: string;
  line: number;
  side: ReviewCommentSide;
  threadId: string | null;
  body: string;
  status: ReviewDraftStatus;
  serverId: string | null;
}

export type ReviewDraftsByTarget = Record<string, ReadonlyArray<ReviewDraftComment>>;

export interface BeginDraftInput {
  draftId: string;
  path: string;
  line: number;
  side: ReviewCommentSide;
  threadId?: string | null;
  body?: string;
}

function targetDrafts(
  state: ReviewDraftsByTarget,
  targetKey: string,
): ReadonlyArray<ReviewDraftComment> {
  return state[targetKey] ?? [];
}

function replaceTargetDrafts(
  state: ReviewDraftsByTarget,
  targetKey: string,
  next: ReadonlyArray<ReviewDraftComment>,
): ReviewDraftsByTarget {
  if (next.length === 0) {
    if (!Object.hasOwn(state, targetKey)) {
      return state;
    }
    const trimmed = { ...state };
    delete trimmed[targetKey];
    return trimmed;
  }
  return { ...state, [targetKey]: next };
}

export function beginDraftInState(
  state: ReviewDraftsByTarget,
  targetKey: string,
  input: BeginDraftInput,
): ReviewDraftsByTarget {
  const draft: ReviewDraftComment = {
    draftId: input.draftId,
    path: input.path,
    line: input.line,
    side: input.side,
    threadId: input.threadId ?? null,
    body: input.body ?? "",
    status: "editing",
    serverId: null,
  };
  return replaceTargetDrafts(state, targetKey, [...targetDrafts(state, targetKey), draft]);
}

export function editDraftInState(
  state: ReviewDraftsByTarget,
  targetKey: string,
  draftId: string,
  patch: Partial<Pick<ReviewDraftComment, "body" | "status" | "serverId">>,
): ReviewDraftsByTarget {
  const drafts = targetDrafts(state, targetKey);
  let changed = false;
  const next = drafts.map((draft) => {
    if (draft.draftId !== draftId) {
      return draft;
    }
    changed = true;
    return { ...draft, ...patch };
  });
  return changed ? replaceTargetDrafts(state, targetKey, next) : state;
}

export function discardDraftInState(
  state: ReviewDraftsByTarget,
  targetKey: string,
  draftId: string,
): ReviewDraftsByTarget {
  const drafts = targetDrafts(state, targetKey);
  const next = drafts.filter((draft) => draft.draftId !== draftId);
  return next.length === drafts.length ? state : replaceTargetDrafts(state, targetKey, next);
}

// Drop optimistic drafts that the server now reports (matched by serverId), so a
// settled add/update no longer renders the local copy alongside the saved one.
export function reconcileDraftsInState(
  state: ReviewDraftsByTarget,
  targetKey: string,
  serverComments: ReadonlyArray<ReviewLocalComment>,
): ReviewDraftsByTarget {
  const drafts = targetDrafts(state, targetKey);
  if (drafts.length === 0) {
    return state;
  }
  const serverIds = new Set(serverComments.map((comment) => comment.id));
  const next = drafts.filter((draft) => draft.serverId === null || !serverIds.has(draft.serverId));
  return next.length === drafts.length ? state : replaceTargetDrafts(state, targetKey, next);
}

export interface ReviewAgentFindingsEntry {
  patchSignature: string;
  reviewedHeadSha: string | null;
  patchSource?: ReviewAgentResult["patchSource"] | undefined;
  summary?: string | undefined;
  droppedFindings?: number | undefined;
  warnings?: ReadonlyArray<string> | undefined;
  findings: ReadonlyArray<ReviewFinding>;
}

export type ReviewAgentFindingsByTarget = Record<string, ReviewAgentFindingsEntry>;
const REVIEW_FINDING_KEY_SEPARATOR = "\u0000";

export function reviewFindingKey(finding: ReviewFinding): string {
  if (finding.id) {
    return finding.id;
  }
  return [finding.path, String(finding.line), finding.side, finding.title].join(
    REVIEW_FINDING_KEY_SEPARATOR,
  );
}

function replaceTargetFindings(
  state: ReviewAgentFindingsByTarget,
  targetKey: string,
  next: ReviewAgentFindingsEntry | null,
): ReviewAgentFindingsByTarget {
  if (next === null || next.findings.length === 0) {
    if (!Object.hasOwn(state, targetKey)) {
      return state;
    }
    const trimmed = { ...state };
    delete trimmed[targetKey];
    return trimmed;
  }
  return { ...state, [targetKey]: next };
}

export function setAgentFindingsInState(
  state: ReviewAgentFindingsByTarget,
  targetKey: string,
  result: ReviewAgentResult,
): ReviewAgentFindingsByTarget {
  if (!result.patchSignature) {
    return replaceTargetFindings(state, targetKey, null);
  }
  return replaceTargetFindings(state, targetKey, {
    patchSignature: result.patchSignature,
    reviewedHeadSha: result.reviewedHeadSha ?? null,
    ...(result.patchSource ? { patchSource: result.patchSource } : {}),
    ...(result.summary ? { summary: result.summary } : {}),
    ...(result.droppedFindings !== undefined ? { droppedFindings: result.droppedFindings } : {}),
    ...(result.warnings ? { warnings: result.warnings } : {}),
    findings: result.findings,
  });
}

export function clearAgentFindingsInState(
  state: ReviewAgentFindingsByTarget,
  targetKey: string,
): ReviewAgentFindingsByTarget {
  return replaceTargetFindings(state, targetKey, null);
}

export function dismissAgentFindingInState(
  state: ReviewAgentFindingsByTarget,
  targetKey: string,
  finding: ReviewFinding,
): ReviewAgentFindingsByTarget {
  const entry = state[targetKey];
  if (!entry) {
    return state;
  }
  const key = reviewFindingKey(finding);
  const next = entry.findings.filter((findingEntry) => reviewFindingKey(findingEntry) !== key);
  return next.length === entry.findings.length
    ? state
    : replaceTargetFindings(state, targetKey, { ...entry, findings: next });
}

export function selectCurrentAgentFindingsFromState(
  state: ReviewAgentFindingsByTarget,
  targetKey: string,
  patchSignature: string | null,
  headSha?: string | null,
): ReadonlyArray<ReviewFinding> {
  const entry = state[targetKey];
  if (!entry) {
    return [];
  }
  if (patchSignature !== null && entry.patchSignature !== patchSignature) {
    return [];
  }
  if (headSha !== undefined && headSha !== null && entry.reviewedHeadSha !== null) {
    return entry.reviewedHeadSha === headSha ? entry.findings : [];
  }
  return entry.findings;
}

const decodeReviewSourceRef = Schema.decodeUnknownOption(ReviewSourceRef);

// Persisted source refs predate any future schema change, so a stale/unknown
// shape (e.g. a tag we no longer emit) must never crash the dock on rehydrate.
// Decode each entry through the contract schema and drop anything invalid; an
// absent scope and a cleared scope are equivalent, so nulls are simply dropped.
export function sanitizeReviewSourceByScope(value: unknown): ReviewSourceByScope {
  return sanitizeStringKeyedRecord(value, (rawEntry) => {
    const decoded = decodeReviewSourceRef(rawEntry);
    return decoded._tag === "Some" ? decoded.value : null;
  });
}

export function setSourceInState(
  state: ReviewSourceByScope,
  scope: string,
  source: ReviewSourceRef,
): ReviewSourceByScope {
  if (reviewSourcesEqual(state[scope] ?? null, source)) {
    return state;
  }
  return { ...state, [scope]: source };
}

function reviewSourcesEqual(left: ReviewSourceRef | null, right: ReviewSourceRef): boolean {
  if (left === null || left._tag !== right._tag) {
    return false;
  }
  if (left._tag === "pullRequest" && right._tag === "pullRequest") {
    return left.reference === right.reference;
  }
  if (left._tag === "branchRange" && right._tag === "branchRange") {
    return left.base === right.base && left.head === right.head;
  }
  return false;
}

export function clearSourceInState(state: ReviewSourceByScope, scope: string): ReviewSourceByScope {
  if (!Object.hasOwn(state, scope)) {
    return state;
  }
  const next = { ...state };
  delete next[scope];
  return next;
}
