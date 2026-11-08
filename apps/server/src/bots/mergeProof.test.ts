import { ProjectId, ThreadId, type PullRequestDetail } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { evaluateMergeProof, findMergeRedFlags } from "./mergeProof";

const detail = (overrides: Partial<PullRequestDetail> = {}): PullRequestDetail => ({
  projectId: ProjectId.makeUnsafe("p"),
  projectTitle: "shop",
  workspaceRoot: "/tmp/shop",
  repository: "acme/shop",
  number: 7,
  title: "Add multiply",
  body: "",
  url: "https://github.com/acme/shop/pull/7",
  author: null,
  state: "open",
  isDraft: false,
  mergeable: "MERGEABLE",
  mergeability: "mergeable",
  mergeStateStatus: "CLEAN",
  reviewDecision: null,
  additions: 8,
  deletions: 1,
  changedFiles: 2,
  headBranch: "feature",
  baseBranch: "main",
  createdAt: "2026-11-05T00:00:00.000Z",
  updatedAt: "2026-11-05T00:00:00.000Z",
  mergedAt: null,
  closedAt: null,
  maintainerCanModify: true,
  reviewers: [],
  labels: [],
  checks: [
    {
      name: "test",
      status: "success",
      description: null,
      url: null,
      startedAt: null,
      completedAt: null,
    },
  ],
  comments: [],
  commentsTruncated: false,
  commentsIncomplete: false,
  commits: [
    {
      oid: "abc123",
      messageHeadline: "Add multiply",
      messageBody: "",
      committedDate: "2026-11-05T00:00:00.000Z",
      authors: [],
    },
  ],
  mergeCapabilities: { merge: true, squash: true, rebase: true, deleteBranchOnMerge: false },
  stack: null,
  stackMetadataIncomplete: false,
  ...overrides,
});

const evaluate = (overrides: Partial<PullRequestDetail> = {}, patch = "") =>
  evaluateMergeProof({
    threadId: ThreadId.makeUnsafe("worker"),
    detail: detail(overrides),
    patch,
    checkedAt: "2026-11-05T00:00:00.000Z",
  });

describe("evaluateMergeProof", () => {
  it("is ready only with green checks on a current, conflict-free open PR", () => {
    const proof = evaluate();
    expect(proof.ready).toBe(true);
    expect(proof.headSha).toBe("abc123");
    expect(proof.checks).toBe("passing");
  });

  it("blocks when behind, conflicting, pending, failing, draft or without checks", () => {
    expect(evaluate({ mergeStateStatus: "BEHIND" })).toMatchObject({ ready: false, behind: true });
    expect(evaluate({ mergeStateStatus: "DIRTY" })).toMatchObject({
      ready: false,
      conflicts: true,
    });
    expect(evaluate({ checks: [{ ...detail().checks[0]!, status: "pending" }] })).toMatchObject({
      ready: false,
      checks: "pending",
    });
    expect(
      evaluate({ checks: [{ ...detail().checks[0]!, status: "failure", name: "lint" }] }),
    ).toMatchObject({ ready: false, checks: "failing", failingChecks: ["lint"] });
    expect(evaluate({ isDraft: true }).ready).toBe(false);
    expect(evaluate({ checks: [] })).toMatchObject({ ready: false, checks: "none" });
    expect(evaluate({ state: "merged" })).toMatchObject({ ready: false, state: "merged" });
  });
});

describe("findMergeRedFlags", () => {
  it("flags deleted tests, skips, removed assertions, ignored failures and removed CI steps", () => {
    const patch = [
      "diff --git a/src/a.test.ts b/src/a.test.ts",
      "deleted file mode 100644",
      "--- a/src/a.test.ts",
      "+++ /dev/null",
      "-expect(1).toBe(1)",
      "diff --git a/src/b.test.ts b/src/b.test.ts",
      "--- a/src/b.test.ts",
      "+++ b/src/b.test.ts",
      "-  expect(sum(1, 2)).toBe(3);",
      "+  it.skip('sums', () => {});",
      "diff --git a/scripts/ci.sh b/scripts/ci.sh",
      "+npm test || true",
      "diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml",
      "-      - run: bun run test",
      "+      continue-on-error: true",
    ].join("\n");
    const kinds = findMergeRedFlags(patch).map((flag) => `${flag.kind}:${flag.file}`);
    expect(kinds).toEqual([
      "test-removed:src/a.test.ts",
      "test-skipped:src/b.test.ts",
      "assertion-removed:src/b.test.ts",
      "failure-ignored:scripts/ci.sh",
      "failure-ignored:.github/workflows/ci.yml",
      "ci-step-removed:.github/workflows/ci.yml",
    ]);
  });

  it("stays quiet on ordinary changes", () => {
    const patch = [
      "diff --git a/src/calc.ts b/src/calc.ts",
      "+export const multiply = (a: number, b: number) => a * b;",
      "diff --git a/src/calc.test.ts b/src/calc.test.ts",
      "+  expect(multiply(2, 3)).toBe(6);",
    ].join("\n");
    expect(findMergeRedFlags(patch)).toEqual([]);
  });
});
