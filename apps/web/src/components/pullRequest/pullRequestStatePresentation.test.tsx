import { describe, expect, it } from "vitest";

import { resolvePrStatePresentation } from "./pullRequestStatePresentation";

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
