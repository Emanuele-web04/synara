import { describe, expect, it } from "vitest";

import {
  WORKTREE_BRANCH_PREFIX,
  buildSynaraBranchName,
  buildTemporaryWorktreeBranchName,
  isTemporaryWorktreeBranch,
  resolveUniqueSynaraBranchName,
  resolveThreadBranchRegressionGuard,
} from "./git";

const PRE_CUTOVER_NAMESPACE_FIXTURES = [
  String.fromCharCode(100, 112, 99, 111, 100, 101),
  String.fromCharCode(116, 51, 99, 111, 100, 101),
] as const;

describe("isTemporaryWorktreeBranch", () => {
  it("matches generated temporary worktree branches", () => {
    expect(isTemporaryWorktreeBranch(buildTemporaryWorktreeBranchName())).toBe(true);
  });

  it("matches generated temporary worktree branches", () => {
    expect(isTemporaryWorktreeBranch(`${WORKTREE_BRANCH_PREFIX}/deadbeef`)).toBe(true);
    expect(isTemporaryWorktreeBranch(` ${WORKTREE_BRANCH_PREFIX}/DEADBEEF `)).toBe(true);
  });

  it("keeps recognizing only exact pre-cutover temporary namespaces", () => {
    for (const namespace of PRE_CUTOVER_NAMESPACE_FIXTURES) {
      expect(isTemporaryWorktreeBranch(`${namespace}/deadbeef`)).toBe(true);
      expect(isTemporaryWorktreeBranch(`${namespace}/semantic-branch`)).toBe(false);
    }
  });

  it("rejects semantic branch names", () => {
    expect(isTemporaryWorktreeBranch(`${WORKTREE_BRANCH_PREFIX}/feature/demo`)).toBe(false);
    expect(isTemporaryWorktreeBranch("feature/demo")).toBe(false);
    expect(isTemporaryWorktreeBranch("feature/deadbeef")).toBe(false);
    expect(isTemporaryWorktreeBranch("hotfix/deadbeef")).toBe(false);
    expect(isTemporaryWorktreeBranch("bridge/deadbeef")).toBe(false);
    expect(isTemporaryWorktreeBranch("bridge/semantic-branch")).toBe(false);
  });
});

describe("resolveThreadBranchRegressionGuard", () => {
  it("keeps a semantic branch when the next branch is only a temporary worktree placeholder", () => {
    expect(
      resolveThreadBranchRegressionGuard({
        currentBranch: "feature/semantic-branch",
        nextBranch: `${WORKTREE_BRANCH_PREFIX}/deadbeef`,
      }),
    ).toBe("feature/semantic-branch");
  });

  it("accepts real branch changes", () => {
    expect(
      resolveThreadBranchRegressionGuard({
        currentBranch: "feature/old",
        nextBranch: "feature/new",
      }),
    ).toBe("feature/new");
  });

  it("allows clearing the branch", () => {
    expect(
      resolveThreadBranchRegressionGuard({
        currentBranch: "feature/old",
        nextBranch: null,
      }),
    ).toBeNull();
  });
});

describe("buildSynaraBranchName", () => {
  it("uses synara as the branch namespace", () => {
    expect(buildSynaraBranchName("fix toast copy")).toBe("synara/fix-toast-copy");
  });

  it("keeps non-Synara namespaces inside the Synara branch", () => {
    expect(buildSynaraBranchName("feature/refine-toolbar-actions")).toBe(
      "synara/feature/refine-toolbar-actions",
    );
  });

  it("normalizes legacy prefixes before rebuilding the branch", () => {
    for (const namespace of PRE_CUTOVER_NAMESPACE_FIXTURES) {
      expect(buildSynaraBranchName(`${namespace}/refine toolbar actions`)).toBe(
        "synara/refine-toolbar-actions",
      );
    }
  });

  it("falls back to synara/update when no preferred name is provided", () => {
    expect(buildSynaraBranchName()).toBe("synara/update");
  });
});

describe("resolveUniqueSynaraBranchName", () => {
  it("increments suffix when the Synara branch already exists", () => {
    expect(
      resolveUniqueSynaraBranchName(
        ["main", "synara/fix-toast-copy", "synara/fix-toast-copy-2"],
        "fix toast copy",
      ),
    ).toBe("synara/fix-toast-copy-3");
  });
});
