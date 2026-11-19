import { describe, expect, it } from "vitest";

import { appendPullRequestAttribution, PULL_REQUEST_ATTRIBUTION_FOOTER } from "./gitAttribution.ts";

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
