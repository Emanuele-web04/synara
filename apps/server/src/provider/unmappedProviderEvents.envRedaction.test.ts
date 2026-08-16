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

  it("redacts prefixed private keys", () => {
    const serialized = JSON.stringify(
      sanitizeUnmappedProviderData("env(FIREBASE_PRIVATE_KEY=private-key-material)"),
    );

    expect(serialized).not.toContain("private-key-material");
    expect(serialized).toContain("FIREBASE_PRIVATE_KEY=[REDACTED]");
  });

  it("consumes escaped quotes inside quoted credential values", () => {
    const serialized = JSON.stringify(
      sanitizeUnmappedProviderData('DB_PASSWORD="abc\\"remaining-secret"'),
    );

    expect(serialized).not.toContain("remaining-secret");
    expect(serialized).toContain("DB_PASSWORD=[REDACTED]");
  });

  it("redacts prefixed credentials in serialized environment maps", () => {
    const serialized = JSON.stringify(
      sanitizeUnmappedProviderData('{"OPENAI_API_KEY":"sk-secret"}'),
    );

    expect(serialized).not.toContain("sk-secret");
    expect(serialized).toContain('\\"OPENAI_API_KEY\\":[REDACTED]');
  });
});
