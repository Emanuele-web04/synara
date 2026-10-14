import { describe, expect, it } from "vitest";

import { INITIAL_PROJECT_DIGEST_SUMMARY } from "@synara/shared/projectAgent";

import {
  rewriteThreadIdsAsMarkdownLinks,
  sanitizeProjectDigestSummary,
} from "./projectPanel.logic";

describe("sanitizeProjectDigestSummary", () => {
  it("hides leftover start-a-goal copy in Focus", () => {
    expect(
      sanitizeProjectDigestSummary(
        "Coordinator is configured. Start a goal to begin bounded coordination.",
      ),
    ).toBe(INITIAL_PROJECT_DIGEST_SUMMARY);
  });
});

describe("rewriteThreadIdsAsMarkdownLinks", () => {
  it("turns known thread ids into markdown links", () => {
    const threadId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    expect(
      rewriteThreadIdsAsMarkdownLinks(`Started ${threadId} for the skill.`, [
        { id: threadId, title: "Write auth skill" },
      ]),
    ).toBe(
      "Started [Write auth skill](thread://aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee) for the skill.",
    );
  });

  it("resolves synara://thread links whose target is a known title with spaces", () => {
    const threadId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const threads = [{ id: threadId, title: "Mars public opinion research" }];
    expect(
      rewriteThreadIdsAsMarkdownLinks(
        "Done: [Mars public opinion research](synara://thread/Mars public opinion research).",
        threads,
      ),
    ).toBe(`Done: [Mars public opinion research](thread://${threadId}).`);
    // The same link arrives %-encoded when the assistant encoded the target.
    expect(
      rewriteThreadIdsAsMarkdownLinks(
        "Done: [Mars public opinion research](synara://thread/Mars%20public%20opinion%20research).",
        threads,
      ),
    ).toBe(`Done: [Mars public opinion research](thread://${threadId}).`);
  });

  it("resolves synara://thread links whose target is a known thread id", () => {
    const threadId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    expect(
      rewriteThreadIdsAsMarkdownLinks(`Done: [report](synara://thread/${threadId}).`, [
        { id: threadId, title: "Mars public opinion research" },
      ]),
      // The id pass canonicalizes the label to the known thread title.
    ).toBe(`Done: [Mars public opinion research](thread://${threadId}).`);
  });

  it("keeps unknown synara://thread targets parseable by encoding the spaces", () => {
    expect(
      rewriteThreadIdsAsMarkdownLinks(
        "Done: [Mars public opinion research](synara://thread/Mars public opinion research).",
        [],
      ),
    ).toBe(
      "Done: [Mars public opinion research](synara://thread/Mars%20public%20opinion%20research).",
    );
  });
});
