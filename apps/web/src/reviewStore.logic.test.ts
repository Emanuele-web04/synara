import type { ReviewFinding, ReviewLocalComment, ReviewSourceRef } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  type ReviewAgentFindingsByTarget,
  type ReviewDraftsByTarget,
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

const PR_SOURCE: ReviewSourceRef = { _tag: "pullRequest", reference: "42" };
const BRANCH_SOURCE: ReviewSourceRef = { _tag: "branchRange", base: "main", head: "feature" };

const TARGET_KEY = reviewTargetKeyString({
  _tag: "pullRequest",
  repositoryId: "repo-a",
  number: 42,
});

function makeComment(overrides: Partial<ReviewLocalComment>): ReviewLocalComment {
  return {
    id: "c1",
    threadId: "t1",
    path: "src/a.ts",
    line: 10,
    side: "RIGHT",
    body: "hello",
    resolved: false,
    createdAt: "2026-06-05T00:00:00.000Z",
    updatedAt: "2026-06-05T00:00:00.000Z",
    ...overrides,
  };
}

function beginOne(state: ReviewDraftsByTarget, draftId: string): ReviewDraftsByTarget {
  return beginDraftInState(state, TARGET_KEY, {
    draftId,
    path: "src/a.ts",
    line: 10,
    side: "RIGHT",
  });
}

describe("setSourceInState", () => {
  it("stores a source under its scope", () => {
    const next = setSourceInState({}, "dock:t1", PR_SOURCE);
    expect(next).toEqual({ "dock:t1": PR_SOURCE });
  });

  it("keeps other scopes untouched", () => {
    const next = setSourceInState({ "dock:t1": PR_SOURCE }, "dock:t2", BRANCH_SOURCE);
    expect(next).toEqual({ "dock:t1": PR_SOURCE, "dock:t2": BRANCH_SOURCE });
  });

  it("returns the same reference when the source is unchanged", () => {
    const state = { "dock:t1": PR_SOURCE };
    expect(setSourceInState(state, "dock:t1", PR_SOURCE)).toBe(state);
  });

  it("returns the same reference when the source is structurally unchanged", () => {
    const state = { "dock:t1": PR_SOURCE };
    expect(setSourceInState(state, "dock:t1", { _tag: "pullRequest", reference: "42" })).toBe(
      state,
    );
  });
});

describe("clearSourceInState", () => {
  it("removes the scope entry", () => {
    const next = clearSourceInState({ "dock:t1": PR_SOURCE, "dock:t2": BRANCH_SOURCE }, "dock:t1");
    expect(next).toEqual({ "dock:t2": BRANCH_SOURCE });
  });

  it("returns the same reference when the scope is absent", () => {
    const state = { "dock:t1": PR_SOURCE };
    expect(clearSourceInState(state, "dock:t2")).toBe(state);
  });
});

describe("sanitizeReviewSourceByScope", () => {
  it("keeps valid pull-request and branch-range sources", () => {
    const result = sanitizeReviewSourceByScope({
      "dock:t1": PR_SOURCE,
      "dock:t2": BRANCH_SOURCE,
    });
    expect(result).toEqual({ "dock:t1": PR_SOURCE, "dock:t2": BRANCH_SOURCE });
  });

  it("drops null, malformed, and unknown-tag entries", () => {
    const result = sanitizeReviewSourceByScope({
      keep: PR_SOURCE,
      cleared: null,
      bogus: { _tag: "mystery", reference: "1" },
      garbage: 42,
    });
    expect(Object.keys(result)).toEqual(["keep"]);
  });

  it("returns an empty map for non-object input", () => {
    expect(sanitizeReviewSourceByScope(null)).toEqual({});
    expect(sanitizeReviewSourceByScope("oops")).toEqual({});
  });
});

describe("reviewTargetKeyString", () => {
  it("produces a stable, distinct key per target shape", () => {
    const pr = reviewTargetKeyString({ _tag: "pullRequest", repositoryId: "repo-a", number: 42 });
    const branch = reviewTargetKeyString({
      _tag: "branchRange",
      repositoryId: "repo-a",
      base: "main",
      head: "feature",
    });
    expect(pr).toContain("pullRequest");
    expect(pr).toContain("repo-a");
    expect(pr).toContain("42");
    expect(branch).toContain("branchRange");
    expect(pr).not.toBe(branch);
  });

  it("keeps the same PR number distinct across repositories", () => {
    const repoA = reviewTargetKeyString({ _tag: "pullRequest", repositoryId: "repo-a", number: 7 });
    const repoB = reviewTargetKeyString({ _tag: "pullRequest", repositoryId: "repo-b", number: 7 });
    expect(repoA).not.toBe(repoB);
  });
});

describe("beginDraftInState", () => {
  it("adds an editing draft under the target key", () => {
    const next = beginOne({}, "d1");
    expect(next[TARGET_KEY]).toHaveLength(1);
    expect(next[TARGET_KEY]?.[0]).toMatchObject({
      draftId: "d1",
      status: "editing",
      body: "",
      serverId: null,
      threadId: null,
    });
  });

  it("appends multiple drafts on the same target", () => {
    const next = beginOne(beginOne({}, "d1"), "d2");
    expect(next[TARGET_KEY]?.map((draft) => draft.draftId)).toEqual(["d1", "d2"]);
  });
});

describe("editDraftInState", () => {
  it("patches body and status of the matching draft", () => {
    const next = editDraftInState(beginOne({}, "d1"), TARGET_KEY, "d1", {
      body: "updated",
      status: "saving",
    });
    expect(next[TARGET_KEY]?.[0]).toMatchObject({ body: "updated", status: "saving" });
  });

  it("returns the same reference when the draft is absent", () => {
    const state = beginOne({}, "d1");
    expect(editDraftInState(state, TARGET_KEY, "missing", { body: "x" })).toBe(state);
  });
});

describe("discardDraftInState", () => {
  it("removes the draft and drops the now-empty target", () => {
    const next = discardDraftInState(beginOne({}, "d1"), TARGET_KEY, "d1");
    expect(Object.hasOwn(next, TARGET_KEY)).toBe(false);
  });

  it("returns the same reference when the draft is absent", () => {
    const state = beginOne({}, "d1");
    expect(discardDraftInState(state, TARGET_KEY, "missing")).toBe(state);
  });
});

describe("reconcileDraftsInState", () => {
  it("drops drafts whose serverId now appears in server comments", () => {
    const seeded = editDraftInState(beginOne({}, "d1"), TARGET_KEY, "d1", {
      serverId: "c1",
      status: "saved",
    });
    const next = reconcileDraftsInState(seeded, TARGET_KEY, [makeComment({ id: "c1" })]);
    expect(Object.hasOwn(next, TARGET_KEY)).toBe(false);
  });

  it("keeps drafts that are not yet saved", () => {
    const state = beginOne({}, "d1");
    expect(reconcileDraftsInState(state, TARGET_KEY, [makeComment({ id: "c1" })])).toBe(state);
  });
});

function makeFinding(overrides: Partial<ReviewFinding>): ReviewFinding {
  return {
    path: "src/a.ts",
    line: 10,
    side: "RIGHT",
    severity: "major",
    title: "Null deref",
    message: "Guard against undefined.",
    ...overrides,
  };
}

function makeAgentResult(findings: ReadonlyArray<ReviewFinding>, patchSignature = "patch-a") {
  return {
    summary: "",
    findings,
    patchSignature,
    totalFindings: findings.length,
    anchoredFindings: findings.length,
    droppedFindings: 0,
    warnings: [],
  };
}

describe("setAgentFindingsInState", () => {
  it("stores findings under the target key", () => {
    const finding = makeFinding({});
    const next = setAgentFindingsInState({}, TARGET_KEY, makeAgentResult([finding]));
    expect(next[TARGET_KEY]).toEqual({
      patchSignature: "patch-a",
      reviewedHeadSha: null,
      droppedFindings: 0,
      warnings: [],
      findings: [finding],
    });
  });

  it("drops the target when set to an empty list", () => {
    const seeded = setAgentFindingsInState({}, TARGET_KEY, makeAgentResult([makeFinding({})]));
    const next = setAgentFindingsInState(seeded, TARGET_KEY, makeAgentResult([]));
    expect(Object.hasOwn(next, TARGET_KEY)).toBe(false);
  });

  it("returns the same reference when clearing an absent target", () => {
    const state: ReviewAgentFindingsByTarget = {};
    expect(setAgentFindingsInState(state, TARGET_KEY, makeAgentResult([]))).toBe(state);
  });

  it("hides findings when the loaded patch signature changed", () => {
    const finding = makeFinding({});
    const state = setAgentFindingsInState({}, TARGET_KEY, makeAgentResult([finding], "patch-a"));
    expect(selectCurrentAgentFindingsFromState(state, TARGET_KEY, "patch-a")).toEqual([finding]);
    expect(selectCurrentAgentFindingsFromState(state, TARGET_KEY, "patch-b")).toEqual([]);
  });
});

describe("clearAgentFindingsInState", () => {
  it("removes findings for the target", () => {
    const seeded = setAgentFindingsInState({}, TARGET_KEY, makeAgentResult([makeFinding({})]));
    const next = clearAgentFindingsInState(seeded, TARGET_KEY);
    expect(Object.hasOwn(next, TARGET_KEY)).toBe(false);
  });
});

describe("dismissAgentFindingInState", () => {
  it("removes only the matching finding", () => {
    const keep = makeFinding({ title: "Keep", line: 11 });
    const drop = makeFinding({ title: "Drop", line: 12 });
    const seeded = setAgentFindingsInState({}, TARGET_KEY, makeAgentResult([keep, drop]));
    const next = dismissAgentFindingInState(seeded, TARGET_KEY, drop);
    expect(next[TARGET_KEY]?.findings).toEqual([keep]);
  });

  it("drops the target when the last finding is dismissed", () => {
    const finding = makeFinding({});
    const seeded = setAgentFindingsInState({}, TARGET_KEY, makeAgentResult([finding]));
    const next = dismissAgentFindingInState(seeded, TARGET_KEY, finding);
    expect(Object.hasOwn(next, TARGET_KEY)).toBe(false);
  });

  it("returns the same reference when the finding is absent", () => {
    const seeded = setAgentFindingsInState(
      {},
      TARGET_KEY,
      makeAgentResult([makeFinding({ title: "Keep" })]),
    );
    expect(dismissAgentFindingInState(seeded, TARGET_KEY, makeFinding({ title: "Other" }))).toBe(
      seeded,
    );
  });
});
