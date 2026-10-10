import { describe, expect, it } from "vitest";

import {
  resolveIssueStatePresentation,
  resolvePrStatePresentation,
} from "./pullRequestStatePresentation";

describe("resolvePrStatePresentation", () => {
  it("keeps draft above conflicts, and conflicts above plain open", () => {
    const draftWithConflicts = resolvePrStatePresentation({
      state: "open",
      isDraft: true,
      mergeability: "conflicting",
    });
    expect(draftWithConflicts.label).toBe("PR draft");
    expect(draftWithConflicts.iconKind).toBe("draft");

    const openWithConflicts = resolvePrStatePresentation({
      state: "open",
      mergeability: "conflicting",
    });
    expect(openWithConflicts.label).toBe("PR has conflicts");
    expect(openWithConflicts.iconKind).toBe("merge-conflict");
  });

  it("ignores draft for non-open states", () => {
    expect(resolvePrStatePresentation({ state: "merged", isDraft: true }).label).toBe("PR merged");
    expect(resolvePrStatePresentation({ state: "closed", isDraft: true }).iconKind).toBe(
      "pull-request-closed",
    );
  });
});

describe("resolveIssueStatePresentation", () => {
  it("maps open, completed, and not planned issues to GitHub's glyphs and colors", () => {
    expect(resolveIssueStatePresentation({ state: "open", stateReason: null })).toMatchObject({
      shortLabel: "Open",
      iconKind: "issue-opened",
      colorClass: "text-status-open",
    });
    expect(
      resolveIssueStatePresentation({ state: "closed", stateReason: "completed" }),
    ).toMatchObject({
      shortLabel: "Closed",
      iconKind: "issue-closed",
      colorClass: "text-status-merged",
    });
    // A closed issue without a reason reads as completed, as it does on GitHub.
    expect(resolveIssueStatePresentation({ state: "closed", stateReason: null }).iconKind).toBe(
      "issue-closed",
    );
    for (const stateReason of ["not-planned", "duplicate"] as const) {
      expect(resolveIssueStatePresentation({ state: "closed", stateReason })).toMatchObject({
        shortLabel: "Not planned",
        iconKind: "issue-not-planned",
      });
    }
  });
});
