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

    expect(prompt).toContain("Do not create a worktree");
    expect(prompt).toContain("switch branches");
    expect(prompt).toContain("mutate files");
    expect(prompt).toContain("The packet below is a summary, not the full change");
    expect(prompt).toContain("What changed?");
  });

  it("keeps summary prompts compact", () => {
    const prompt = buildReviewSidechatInitialPrompt(
      {
        ...makePayload(),
        body: `${"a".repeat(600)}body-tail`,
        files: Array.from({ length: 8 }, (_, index) => ({
          path: `src/file-${index}.ts`,
          status: "modified",
          insertions: 10 - index,
          deletions: index,
        })),
        recentConversation: [
          {
            kind: "comment",
            author: "reviewer",
            state: null,
            body: "This should not be sent for a summary.",
            createdAt: "2026-06-01T00:00:00.000Z",
            url: null,
          },
        ],
      },
      "Summarize this PR",
    );

    expect(prompt).toContain("Pull request description:");
    expect(prompt).toContain("Changed files:");
    expect(prompt).not.toContain("Recent conversation:");
    expect(prompt).not.toContain("body-tail");
    expect(prompt).not.toContain("src/file-6.ts");
  });

  it("does not claim there are no files when details are lazily unloaded", () => {
    const prompt = buildReviewSidechatInitialPrompt(makePayload(), "What changed?");

    expect(prompt).toContain("Changed files:");
    expect(prompt).toContain("Changed-file list not in this packet");
    expect(prompt).toContain("24 files reported");
    expect(prompt).not.toContain("No files loaded");
  });

  it("keeps failing-check prompts focused on checks", () => {
    const prompt = buildReviewSidechatInitialPrompt(
      {
        ...makePayload(),
        body: "Large PR body that is not needed for check triage.",
        checks: [
          {
            name: "react-doctor",
            state: "failure",
            workflow: "CI",
            description: "Heavy library import",
            url: "https://ci.example/react-doctor",
          },
          {
            name: "build",
            state: "success",
            workflow: "CI",
            description: null,
            url: null,
          },
        ],
        files: [
          {
            path: "src/expensive-file.ts",
            status: "modified",
            insertions: 100,
            deletions: 10,
          },
        ],
      },
      "Explain the failing checks",
    );

    expect(prompt).toContain("Checks needing attention:");
    expect(prompt).toContain("react-doctor: failure");
    expect(prompt).toContain("Heavy library import");
    expect(prompt).toContain("https://ci.example/react-doctor");
    expect(prompt).not.toContain("build: success");
    expect(prompt).not.toContain("Changed files:");
    expect(prompt).not.toContain("Pull request description:");
  });

  it("keeps review-order prompts focused on changed files", () => {
    const prompt = buildReviewSidechatInitialPrompt(
      {
        ...makePayload(),
        body: "Long body that should not be needed to pick a review order.",
        files: [
          {
            path: "src/risky.ts",
            status: "modified",
            insertions: 120,
            deletions: 30,
          },
        ],
      },
      "What should I review first?",
    );

    expect(prompt).toContain("Changed files:");
    expect(prompt).toContain("src/risky.ts");
    expect(prompt).not.toContain("Pull request description:");
  });
});
