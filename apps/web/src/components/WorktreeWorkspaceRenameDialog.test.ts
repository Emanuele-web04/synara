import { describe, expect, it } from "vitest";

import {
  branchNameFromWorkspaceTitle,
  branchRenameHelpText,
  shouldRenameWorkspaceBranch,
} from "./WorktreeWorkspaceRenameDialog";

describe("branchNameFromWorkspaceTitle", () => {
  it("preserves the current namespace and creates a readable slug", () => {
    expect(branchNameFromWorkspaceTitle("Shipping Details", "synara/old-name")).toBe(
      "synara/shipping-details",
    );
  });

  it("keeps unnamespaced branches unnamespaced", () => {
    expect(branchNameFromWorkspaceTitle("Fix checkout", "old-name")).toBe("fix-checkout");
  });

  it("preserves a nested branch namespace", () => {
    expect(branchNameFromWorkspaceTitle("Shipping details", "users/amir/old-name")).toBe(
      "users/amir/shipping-details",
    );
  });
});

describe("branchRenameHelpText", () => {
  it("announces publication verification and the protected branch rule", () => {
    expect(branchRenameHelpText("checking", "synara/new-name")).toBe(
      "Checking whether this branch is published…",
    );
    expect(branchRenameHelpText("protected", "synara/new-name")).toContain(
      "published or has a pull request",
    );
  });

  it("keeps display-only rename available when verification fails", () => {
    expect(branchRenameHelpText("unverified", "synara/new-name")).toContain(
      "You can still rename the workspace label.",
    );
    expect(branchRenameHelpText("unavailable", "synara/new-name")).toContain(
      "You can still rename the workspace label.",
    );
  });

  it("previews the next local branch only when branch rename is available", () => {
    expect(branchRenameHelpText("available", "users/amir/shipping-details")).toBe(
      "The local branch will become users/amir/shipping-details.",
    );
  });

  it("never submits branch rename after publication or a verification failure", () => {
    expect(shouldRenameWorkspaceBranch(true, "available")).toBe(true);
    expect(shouldRenameWorkspaceBranch(true, "protected")).toBe(false);
    expect(shouldRenameWorkspaceBranch(true, "unverified")).toBe(false);
    expect(shouldRenameWorkspaceBranch(true, "checking")).toBe(false);
    expect(shouldRenameWorkspaceBranch(false, "available")).toBe(false);
  });
});
