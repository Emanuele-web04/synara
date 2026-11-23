import { BotMergeProof, ProjectId, ThreadId, type PullRequestDetail } from "@synara/contracts";
import { Schema } from "effect";
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

const evaluate = (overrides: Partial<PullRequestDetail> = {}, patch = "", patchComplete = true) =>
  evaluateMergeProof({
    threadId: ThreadId.makeUnsafe("worker"),
    detail: detail(overrides),
    patch,
    patchComplete,
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
    expect(evaluate({ state: "closed" })).toMatchObject({ ready: false, state: "closed" });
    expect(evaluate({ mergeStateStatus: "BLOCKED" }).ready).toBe(false);
    expect(evaluate({ mergeability: "conflicting" })).toMatchObject({
      ready: false,
      conflicts: true,
    });
  });

  it("blocks without a known head, since Merge pins the head the user saw", () => {
    expect(evaluate({ commits: [] })).toMatchObject({ ready: false, headSha: "unknown" });
  });

  it("blocks when the patch could not be read whole, so red flags are not ruled out", () => {
    expect(evaluate({}, "", false).ready).toBe(false);
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

  it("flags edits outside bot scope paths without blocking merge readiness", () => {
    const patch = [
      "diff --git a/apps/web/src/Button.tsx b/apps/web/src/Button.tsx",
      "+export const Button = () => null;",
      "diff --git a/apps/server/src/index.ts b/apps/server/src/index.ts",
      "+export const x = 1;",
    ].join("\n");
    const flags = findMergeRedFlags(patch, ["apps/web/**"]);
    expect(flags).toEqual([
      {
        kind: "outside-scope",
        file: "apps/server/src/index.ts",
        detail: "Outside apps/web/**",
      },
    ]);
    const proof = evaluateMergeProof({
      threadId: ThreadId.makeUnsafe("t-scope"),
      detail: detail(),
      patch,
      patchComplete: true,
      scopePaths: ["apps/web/**"],
      checkedAt: "2026-08-01T00:00:00.000Z",
    });
    expect(proof.ready).toBe(true);
    expect(proof.redFlags.map((flag) => flag.kind)).toEqual(["outside-scope"]);
  });

  it("keeps a long scope within the contract and test flags ahead of out-of-scope files", () => {
    const scopePaths = Array.from({ length: 40 }, (_, index) => `packages/module-${index}/**`);
    const outside = Array.from({ length: 30 }, (_, index) => [
      `diff --git a/apps/app-${index}/x.ts b/apps/app-${index}/x.ts`,
      "+export const x = 1;",
    ]).flat();
    const patch = [
      ...outside,
      "diff --git a/packages/module-0/a.test.ts b/packages/module-0/a.test.ts",
      "deleted file mode 100644",
      "-expect(1).toBe(1)",
      "diff --git a/packages/module-1/b.test.ts b/packages/module-1/b.test.ts",
      "-  expect(sum(1, 2)).toBe(3);",
    ].join("\n");
    const flags = findMergeRedFlags(patch, scopePaths);
    expect(flags).toHaveLength(24);
    expect(flags.slice(0, 2).map((flag) => flag.kind)).toEqual([
      "test-removed",
      "assertion-removed",
    ]);
    for (const flag of flags) expect(flag.detail.length).toBeLessThanOrEqual(400);
    const proof = evaluateMergeProof({
      threadId: ThreadId.makeUnsafe("t-wide"),
      detail: detail(),
      patch,
      patchComplete: true,
      scopePaths,
      checkedAt: "2026-08-01T00:00:00.000Z",
    });
    // The proof goes over the wire: it must encode.
    expect(() => Schema.encodeUnknownSync(BotMergeProof)(proof)).not.toThrow();
  });
});
