import { describe, expect, it } from "vitest";

import type { ReviewSidechatContextPayload } from "./reviewSidechatContext";
import { buildReviewSidechatInitialPrompt } from "./reviewSidechatContext";

function makePayload(): ReviewSidechatContextPayload {
  return {
    cwd: "/repo/bonaparte",
    reference: "7884",
    url: "https://github.com/enzo-health/bonaparte/pull/7884",
    number: 7884,
    title: "fix(wellsky): correct OT physical-assessment scale",
    author: "randylevan",
    state: "open",
    isDraft: false,
    baseBranch: "main",
    headBranch: "fix/ot-eval-physical-assessment-scale",
    headSha: "abc123",
    reviewDecision: null,
    mergeable: "MERGEABLE",
    checksStatus: "failing",
    repositoryId: "enzo-health/bonaparte",
    source: { _tag: "pullRequest", reference: "7884" },
    target: { _tag: "pullRequest", repositoryId: "enzo-health/bonaparte", number: 7884 },
    stats: {
      files: 24,
      additions: 834,
      deletions: 69,
      commits: 2,
    },
    body: "Fixes WellSky mapping behavior.",
    labels: [],
    reviewers: [],
    checks: [],
    files: [],
    recentConversation: [],
    currentView: "conversation",
    selectedFilePath: null,
  };
}

describe("buildReviewSidechatInitialPrompt", () => {
  it("keeps PR chat constrained to review context", () => {
    const prompt = buildReviewSidechatInitialPrompt(makePayload(), "What changed?");

    expect(prompt).toContain("Do not create a new worktree");
    expect(prompt).toContain("do not switch branches");
    expect(prompt).toContain("do not mutate files");
    expect(prompt).toContain("Use the loaded PR context");
    expect(prompt).toContain("What changed?");
  });
});
