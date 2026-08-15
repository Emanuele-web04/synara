import { describe, expect, it } from "vitest";

import { sanitizeUnmappedProviderData } from "./unmappedProviderEvents.ts";

describe("unmapped provider environment credential redaction", () => {
  it("redacts prefixed secret environment assignments in diagnostic text", () => {
    const sanitized = sanitizeUnmappedProviderData(
      "env OPENAI_API_KEY=sk-secret GITHUB_TOKEN='github-secret' NODE_ENV=development",
    );
    const serialized = JSON.stringify(sanitized);

    expect(serialized).not.toContain("sk-secret");
    expect(serialized).not.toContain("github-secret");
    expect(serialized).toContain("OPENAI_API_KEY=[REDACTED]");
    expect(serialized).toContain("GITHUB_TOKEN=[REDACTED]");
    expect(serialized).toContain("NODE_ENV=development");
  });
});
