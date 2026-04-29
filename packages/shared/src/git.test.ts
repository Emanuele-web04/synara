import { describe, expect, it } from "vitest";

import {
  WORKTREE_BRANCH_PREFIX,
  buildDpcodeBranchName,
  buildTemporaryWorktreeBranchName,
  isTemporaryWorktreeBranch,
  resolveUniqueDpcodeBranchName,
  resolveThreadBranchRegressionGuard,
} from "./git";

describe("isTemporaryWorktreeBranch", () => {
  it("matches generated temporary worktree branches", () => {
    expect(isTemporaryWorktreeBranch(buildTemporaryWorktreeBranchName())).toBe(true);
  });

  it("matches generated temporary worktree branches", () => {
    expect(isTemporaryWorktreeBranch(`${WORKTREE_BRANCH_PREFIX}/deadbeef`)).toBe(true);
    expect(isTemporaryWorktreeBranch(` ${WORKTREE_BRANCH_PREFIX}/DEADBEEF `)).toBe(true);
  });

  it("rejects semantic branch names", () => {
    expect(isTemporaryWorktreeBranch(`${WORKTREE_BRANCH_PREFIX}/feature/demo`)).toBe(false);
    expect(isTemporaryWorktreeBranch("feature/demo")).toBe(false);
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

describe("buildDpcodeBranchName", () => {
  it("uses dpcode as the branch namespace", () => {
    expect(buildDpcodeBranchName("fix toast copy")).toBe("dpcode/fix-toast-copy");
  });

  it("keeps non-dpcode namespaces inside the dpcode branch", () => {
    expect(buildDpcodeBranchName("feature/refine-toolbar-actions")).toBe(
      "dpcode/feature/refine-toolbar-actions",
    );
  });

  it("normalizes legacy dpcode-style prefixes before rebuilding the branch", () => {
    expect(buildDpcodeBranchName("t3code/refine toolbar actions")).toBe(
      "dpcode/refine-toolbar-actions",
    );
  });

  it("falls back to dpcode/update when no preferred name is provided", () => {
    expect(buildDpcodeBranchName()).toBe("dpcode/update");
  });
});

describe("resolveUniqueDpcodeBranchName", () => {
  it("increments suffix when the dpcode branch already exists", () => {
    expect(
      resolveUniqueDpcodeBranchName(
        ["main", "dpcode/fix-toast-copy", "dpcode/fix-toast-copy-2"],
        "fix toast copy",
      ),
    ).toBe("dpcode/fix-toast-copy-3");
  });
});
