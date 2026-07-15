import { describe, expect, it } from "vitest";

import {
  PR_STATE_PRESENTATION_ICONS,
  resolvePrStatePresentation,
} from "./pullRequestStatePresentation";

describe("resolvePrStatePresentation", () => {
  it("gives every state a dedicated glyph from the shared icon map", () => {
    expect(resolvePrStatePresentation({ state: "open" }).iconKind).toBe("pull-request");
    expect(resolvePrStatePresentation({ state: "open", isDraft: true }).iconKind).toBe("draft");
    expect(resolvePrStatePresentation({ state: "closed" }).iconKind).toBe("pull-request-closed");
    expect(resolvePrStatePresentation({ state: "merged" }).iconKind).toBe("merged-simple");
    for (const presentation of [
      resolvePrStatePresentation({ state: "open" }),
      resolvePrStatePresentation({ state: "open", isDraft: true }),
      resolvePrStatePresentation({ state: "closed" }),
      resolvePrStatePresentation({ state: "merged" }),
    ]) {
      expect(PR_STATE_PRESENTATION_ICONS[presentation.iconKind]).toBeDefined();
    }
  });

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
