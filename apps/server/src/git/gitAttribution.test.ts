import { describe, expect, it } from "vitest";

import {
  appendCommitAttribution,
  appendPullRequestAttribution,
  COMMIT_ATTRIBUTION_TRAILER,
  PULL_REQUEST_ATTRIBUTION_FOOTER,
} from "./gitAttribution.ts";

describe("appendPullRequestAttribution", () => {
  it("ends the description with the footer after one blank line", () => {
    expect(appendPullRequestAttribution("## Summary\n- Fix the bug\n\n")).toBe(
      `## Summary\n- Fix the bug\n\n${PULL_REQUEST_ATTRIBUTION_FOOTER}`,
    );
  });

  it("returns only the footer for an empty description", () => {
    expect(appendPullRequestAttribution("")).toBe(PULL_REQUEST_ATTRIBUTION_FOOTER);
    expect(appendPullRequestAttribution("  \n")).toBe(PULL_REQUEST_ATTRIBUTION_FOOTER);
  });

  it.each([
    PULL_REQUEST_ATTRIBUTION_FOOTER,
    "created with [synara](https://www.trysynara.com/)",
    "Created with Synara",
    "CREATED WITH SYNARA",
    "  Created with [Synara](https://trysynara.com)  ",
  ])("does not duplicate an existing footer: %s", (footer) => {
    const body = `Body text\n\n${footer}\n\nMore notes`;
    expect(appendPullRequestAttribution(body)).toBe(body);
  });

  it("is idempotent", () => {
    const once = appendPullRequestAttribution("Body");
    expect(appendPullRequestAttribution(once)).toBe(once);
  });

  it("does not treat a sentence that mentions Synara as the footer", () => {
    expect(appendPullRequestAttribution("This was created with Synara today.")).toBe(
      `This was created with Synara today.\n\n${PULL_REQUEST_ATTRIBUTION_FOOTER}`,
    );
  });
});

describe("appendCommitAttribution", () => {
  it("returns only the trailer for an empty body", () => {
    expect(appendCommitAttribution("")).toBe(COMMIT_ATTRIBUTION_TRAILER);
    expect(appendCommitAttribution(" \n ")).toBe(COMMIT_ATTRIBUTION_TRAILER);
  });

  it("adds the trailer as a new paragraph after prose", () => {
    expect(appendCommitAttribution("- Fix the bug\n- Add a test\n")).toBe(
      `- Fix the bug\n- Add a test\n\n${COMMIT_ATTRIBUTION_TRAILER}`,
    );
  });

  it("joins an existing trailer block", () => {
    const body =
      "Explain the change.\n\nCo-authored-by: Ada <ada@example.com>\nSigned-off-by: Bob <bob@example.com>";
    expect(appendCommitAttribution(body)).toBe(`${body}\n${COMMIT_ATTRIBUTION_TRAILER}`);
  });

  it("joins a body that is only a trailer block", () => {
    expect(appendCommitAttribution("Co-authored-by: Ada <ada@example.com>")).toBe(
      `Co-authored-by: Ada <ada@example.com>\n${COMMIT_ATTRIBUTION_TRAILER}`,
    );
  });

  it("keeps trailer continuation lines inside the block", () => {
    const body = "Notes\n\nCo-authored-by: Ada\n  <ada@example.com>";
    expect(appendCommitAttribution(body)).toBe(`${body}\n${COMMIT_ATTRIBUTION_TRAILER}`);
  });

  it("starts a new paragraph when the last paragraph mixes prose and trailers", () => {
    const body = "Refs: #12\nand some prose";
    expect(appendCommitAttribution(body)).toBe(`${body}\n\n${COMMIT_ATTRIBUTION_TRAILER}`);
  });

  it("treats several blank lines as one paragraph break", () => {
    const body = "Notes\n\n\n\nSigned-off-by: Ada <ada@example.com>";
    expect(appendCommitAttribution(body)).toBe(`${body}\n${COMMIT_ATTRIBUTION_TRAILER}`);
  });

  it.each(["Created-with: Synara", "created-with: synara", "Created-With:   SYNARA"])(
    "does not duplicate an existing trailer: %s",
    (trailer) => {
      const body = `Notes\n\n${trailer}`;
      expect(appendCommitAttribution(body)).toBe(body);
    },
  );

  it("is idempotent", () => {
    const once = appendCommitAttribution("Notes");
    expect(appendCommitAttribution(once)).toBe(once);
    const trailerOnce = appendCommitAttribution("Notes\n\nSigned-off-by: Ada <ada@example.com>");
    expect(appendCommitAttribution(trailerOnce)).toBe(trailerOnce);
  });
});
