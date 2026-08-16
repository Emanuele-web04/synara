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

  it("redacts prefixed secret-key assignments and serialized maps", () => {
    const assignment = JSON.stringify(
      sanitizeUnmappedProviderData("STRIPE_SECRET_KEY=assignment-secret"),
    );
    const serializedMap = JSON.stringify(
      sanitizeUnmappedProviderData('{"STRIPE_SECRET_KEY":"map-secret"}'),
    );

    expect(assignment).not.toContain("assignment-secret");
    expect(serializedMap).not.toContain("map-secret");
    expect(assignment).toContain("STRIPE_SECRET_KEY=[REDACTED]");
    expect(serializedMap).toContain('\\"STRIPE_SECRET_KEY\\":[REDACTED]');
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

  it("redacts multiline quoted credential values through the closing quote", () => {
    const prefixed = JSON.stringify(
      sanitizeUnmappedProviderData(
        'FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nremaining-secret\n-----END PRIVATE KEY-----"',
      ),
    );
    const bare = JSON.stringify(
      sanitizeUnmappedProviderData(
        'private_key="-----BEGIN PRIVATE KEY-----\nbare-secret\n-----END PRIVATE KEY-----"',
      ),
    );

    expect(prefixed).not.toContain("BEGIN PRIVATE KEY");
    expect(prefixed).not.toContain("remaining-secret");
    expect(prefixed).toContain("FIREBASE_PRIVATE_KEY=[REDACTED]");
    expect(bare).not.toContain("BEGIN PRIVATE KEY");
    expect(bare).not.toContain("bare-secret");
    expect(bare).toContain("private_key=[REDACTED]");
  });

  it("fails closed on unterminated quoted credential values", () => {
    const serialized = JSON.stringify(
      sanitizeUnmappedProviderData('FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nsecret'),
    );

    expect(serialized).not.toContain("BEGIN PRIVATE KEY");
    expect(serialized).not.toContain("secret");
    expect(serialized).toContain("FIREBASE_PRIVATE_KEY=[REDACTED]");
  });

  it("consumes Bearer-prefixed unquoted environment values", () => {
    const serialized = JSON.stringify(
      sanitizeUnmappedProviderData("OPENAI_API_KEY=Bearer sk-secret"),
    );

    expect(serialized).not.toContain("sk-secret");
    expect(serialized).toContain("OPENAI_API_KEY=[REDACTED]");
  });

  it("redacts decoded and raw name/value environment entries", () => {
    const decoded = JSON.stringify(
      sanitizeUnmappedProviderData([
        { name: "OPENAI_API_KEY", value: "decoded-secret" },
        { name: "SAFE_ENV", value: "kept" },
      ]),
    );
    const raw = JSON.stringify(
      sanitizeUnmappedProviderData(
        'env: [{"name":"OPENAI_API_KEY","value":"raw-secret"},{"name":"SAFE_ENV","value":"kept"}]',
      ),
    );

    expect(decoded).not.toContain("decoded-secret");
    expect(raw).not.toContain("raw-secret");
    expect(decoded).toContain('"value":"[REDACTED]"');
    expect(raw).toContain('\\"value\\":[REDACTED]');
    expect(decoded).toContain("kept");
    expect(raw).toContain("kept");
  });
});
