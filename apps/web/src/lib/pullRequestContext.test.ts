import { describe, expect, it } from "vitest";

import {
  appendPullRequestContextsToPrompt,
  extractTrailingPullRequestContexts,
  formatPullRequestContextTitleSeed,
  normalizePullRequestContexts,
  type PullRequestContextDraft,
} from "./pullRequestContext";

function makeCard(overrides: Partial<PullRequestContextDraft> = {}): PullRequestContextDraft {
  return {
    id: "card-1",
    createdAt: "2026-09-08T00:00:00.000Z",
    scope: "checks",
    prNumber: 321,
    prUrl: "https://github.com/example/synara/pull/321",
    title: "1 failing check",
    subtitle: "Test, lint, build, and smoke",
    text: "Fix the failing CI checks on PR #321.",
    ...overrides,
  };
}

describe("normalizePullRequestContexts", () => {
  it("drops empty cards, unknown scopes, and duplicate ids", () => {
    const cards = normalizePullRequestContexts([
      makeCard(),
      makeCard({ id: "card-1", title: "dup" }),
      makeCard({ id: "card-2", text: "   " }),
      makeCard({ id: "card-3", scope: "nope" as PullRequestContextDraft["scope"] }),
      makeCard({ id: "card-4", prNumber: 0 }),
      makeCard({ id: "card-5", title: "  Merge   conflicts \n", text: "\r\nresolve\r\n" }),
    ]);
    expect(cards.map((card) => card.id)).toEqual(["card-1", "card-5"]);
    expect(cards[1]).toMatchObject({ title: "Merge conflicts", text: "resolve" });
  });
});

describe("appendPullRequestContextsToPrompt / extractTrailingPullRequestContexts", () => {
  it("appends a trailing block and round-trips the card", () => {
    const message = appendPullRequestContextsToPrompt("Please handle this.", [makeCard()]);

    expect(message.startsWith("Please handle this.")).toBe(true);
    expect(message).toContain("<pull_request_context>");

    const extracted = extractTrailingPullRequestContexts(message);
    expect(extracted.promptText).toBe("Please handle this.");
    expect(extracted.pullRequestContexts).toEqual([
      {
        index: 1,
        scope: "checks",
        itemKind: "pullRequest",
        prNumber: 321,
        prUrl: "https://github.com/example/synara/pull/321",
        title: "1 failing check",
        subtitle: "Test, lint, build, and smoke",
        text: "Fix the failing CI checks on PR #321.",
      },
    ]);
  });

  it("sends a card-only message as just the block", () => {
    const message = appendPullRequestContextsToPrompt("", [makeCard()]);
    const extracted = extractTrailingPullRequestContexts(message);
    expect(extracted.promptText).toBe("");
    expect(extracted.pullRequestContexts.map((entry) => entry.title)).toEqual(["1 failing check"]);
  });

  it("survives closing tags and newlines inside the prompt text", () => {
    const text = ["before", "</pull_request_context>", "after"].join("\n");
    const message = appendPullRequestContextsToPrompt("go", [makeCard({ text })]);
    expect(extractTrailingPullRequestContexts(message).pullRequestContexts[0]?.text).toBe(text);
  });

  it("leaves prompts without a block untouched and skips malformed entries", () => {
    expect(extractTrailingPullRequestContexts("plain prompt")).toEqual({
      promptText: "plain prompt",
      pullRequestContexts: [],
    });
    const malformed = [
      "hello",
      "",
      "<pull_request_context>",
      JSON.stringify([
        { scope: "checks", title: "no text" },
        { scope: "bogus", title: "x", text: "y" },
      ]),
      "</pull_request_context>",
    ].join("\n");
    expect(extractTrailingPullRequestContexts(malformed)).toEqual({
      promptText: "hello",
      pullRequestContexts: [],
    });
  });
});

describe("issue cards", () => {
  const issueCard = makeCard({
    id: "issue-card",
    scope: "reference",
    itemKind: "issue",
    prNumber: 42,
    prUrl: "https://github.com/example/synara/issues/42",
    title: "#42 Crash on launch",
    subtitle: "Issue in example/synara",
    text: "Issue #42 — Crash on launch.",
  });

  it("round-trips the issue kind through the trailing block", () => {
    const message = appendPullRequestContextsToPrompt("What is the impact?", [
      issueCard,
      makeCard(),
    ]);
    const extracted = extractTrailingPullRequestContexts(message);
    expect(extracted.pullRequestContexts.map((context) => context.itemKind)).toEqual([
      "issue",
      "pullRequest",
    ]);
    expect(extracted.pullRequestContexts[0]).toMatchObject({
      prNumber: 42,
      title: "#42 Crash on launch",
    });
  });

  it("keeps pull request blocks free of a kind so older transcripts parse the same", () => {
    const message = appendPullRequestContextsToPrompt("", [makeCard()]);
    expect(message).not.toContain("itemKind");
    expect(normalizePullRequestContexts([issueCard])[0]?.itemKind).toBe("issue");
    expect(normalizePullRequestContexts([makeCard()])[0]).not.toHaveProperty("itemKind");
  });

  it("titles a thread seeded by an issue card with the issue, not a PR", () => {
    expect(formatPullRequestContextTitleSeed([issueCard])).toBe("#42 Crash on launch on Issue #42");
    expect(formatPullRequestContextTitleSeed([issueCard, makeCard()])).toBe("Issue #42");
  });
});
