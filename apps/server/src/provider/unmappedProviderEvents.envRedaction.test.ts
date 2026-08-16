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
      sanitizeUnmappedProviderData(
        "STRIPE_SECRET_KEY=assignment-secret SERVICE_APIKEY=compact-secret AWS_ACCESS_KEY_ID=assignment-access-id",
      ),
    );
    const serializedMap = JSON.stringify(
      sanitizeUnmappedProviderData(
        '{"STRIPE_SECRET_KEY":"map-secret","AWS_ACCESS_KEY_ID":"map-access-id"}',
      ),
    );

    expect(assignment).not.toContain("assignment-secret");
    expect(assignment).not.toContain("compact-secret");
    expect(serializedMap).not.toContain("map-secret");
    expect(assignment).not.toContain("assignment-access-id");
    expect(serializedMap).not.toContain("map-access-id");
    expect(assignment).toContain("STRIPE_SECRET_KEY=[REDACTED]");
    expect(assignment).toContain("SERVICE_APIKEY=[REDACTED]");
    expect(serializedMap).toContain('\\"STRIPE_SECRET_KEY\\":[REDACTED]');
    expect(assignment).toContain("AWS_ACCESS_KEY_ID=[REDACTED]");
    expect(serializedMap).toContain('\\"AWS_ACCESS_KEY_ID\\":[REDACTED]');
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

  it("consumes ANSI-C-quoted multiline environment values", () => {
    const serialized = JSON.stringify(
      sanitizeUnmappedProviderData(
        "FIREBASE_PRIVATE_KEY=$'-----BEGIN PRIVATE KEY-----\\nremaining-secret\\n-----END PRIVATE KEY-----'",
      ),
    );

    expect(serialized).not.toContain("BEGIN PRIVATE KEY");
    expect(serialized).not.toContain("remaining-secret");
    expect(serialized).toContain("FIREBASE_PRIVATE_KEY=[REDACTED]");
  });

  it("redacts credentials embedded in connection URLs", () => {
    const database = JSON.stringify(
      sanitizeUnmappedProviderData("DATABASE_URL=postgres://user:secret@host/db"),
    );
    const redis = JSON.stringify(
      sanitizeUnmappedProviderData("REDIS_URL=redis://:redis-secret@host/0"),
    );

    expect(database).not.toContain("user");
    expect(database).not.toContain("secret");
    expect(database).toContain("postgres://[REDACTED]@host/db");
    expect(redis).not.toContain("redis-secret");
    expect(redis).toContain("redis://[REDACTED]@host/0");
  });

  it("consumes escaped separators in unquoted shell values", () => {
    const serialized = JSON.stringify(
      sanitizeUnmappedProviderData(
        "SERVICE_APIKEY=abc\\ remaining-secret OTHER_TOKEN=def\\,remaining-token THIRD_SECRET=ghi\\;remaining-secret",
      ),
    );

    expect(serialized).not.toContain("remaining-secret");
    expect(serialized).not.toContain("remaining-token");
    expect(serialized).toContain("SERVICE_APIKEY=[REDACTED]");
    expect(serialized).toContain("OTHER_TOKEN=[REDACTED]");
    expect(serialized).toContain("THIRD_SECRET=[REDACTED]");
  });

  it("redacts decoded and raw name/value environment entries", () => {
    const decoded = JSON.stringify(
      sanitizeUnmappedProviderData([
        { name: "OPENAI_API_KEY", value: "decoded-secret" },
        { name: "AWS_ACCESS_KEY_ID", value: "decoded-access-id" },
        { name: "SAFE_ENV", value: "kept" },
      ]),
    );
    const raw = JSON.stringify(
      sanitizeUnmappedProviderData(
        'env: [{"name":"OPENAI_API_KEY","value":"raw-secret"},{"value":"reverse-secret","name":"GITHUB_TOKEN"},{"name":"STRIPE_SECRET_KEY","source":"process","value":"metadata-secret"},{"name":"OPENAI_API_KEY","metadata":{"source":"process"},"value":"nested-secret"},{"name":"SAFE_ENV","value":"kept"}]',
      ),
    );

    expect(decoded).not.toContain("decoded-secret");
    expect(decoded).not.toContain("decoded-access-id");
    expect(raw).not.toContain("raw-secret");
    expect(raw).not.toContain("reverse-secret");
    expect(raw).not.toContain("metadata-secret");
    expect(raw).not.toContain("nested-secret");
    expect(decoded).toContain('"value":"[REDACTED]"');
    expect(raw).toContain('\\"value\\":\\"[REDACTED]\\"');
    expect(decoded).toContain("kept");
    expect(raw).toContain("kept");
  });

  it("redacts compact credential names in decoded environment maps", () => {
    const serialized = JSON.stringify(
      sanitizeUnmappedProviderData({
        AWS_ACCESS_KEY_ID: "decoded-map-access-id",
        SERVICE_APIKEY: "decoded-compact-key",
        PGPASSWORD: "decoded-compact-password",
      }),
    );

    expect(serialized).not.toContain("decoded-map-access-id");
    expect(serialized).not.toContain("decoded-compact-key");
    expect(serialized).not.toContain("decoded-compact-password");
    expect(serialized).toContain('"AWS_ACCESS_KEY_ID":"[REDACTED]"');
    expect(serialized).toContain('"SERVICE_APIKEY":"[REDACTED]"');
    expect(serialized).toContain('"PGPASSWORD":"[REDACTED]"');
  });

  it("fails closed on truncated raw name/value entries", () => {
    const raw = JSON.stringify(
      sanitizeUnmappedProviderData('env: {"name":"OPENAI_API_KEY","value":"raw-secret'),
    );

    expect(raw).not.toContain("raw-secret");
    expect(raw).toContain('\\"value\\":[REDACTED]');
  });
});
