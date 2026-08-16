import { describe, expect, it } from "vitest";

import { redactSensitiveProcessArgs } from "./processArgumentRedaction";

describe("redactSensitiveProcessArgs", () => {
  it("redacts sensitive flag values in both supported forms", () => {
    expect(redactSensitiveProcessArgs("tool --api-key secret --token=other --verbose")).toBe(
      "tool --api-key [redacted] --token=[redacted] --verbose",
    );
  });

  it("redacts bearer and OpenAI-style secret tokens", () => {
    expect(redactSensitiveProcessArgs("Bearer abc.def sk-abcdefgh1234 keep-me")).toBe(
      "Bearer [redacted] [redacted] keep-me",
    );
  });

  it("redacts external MCP pairing codes and credentials from process diagnostics", () => {
    expect(
      redactSensitiveProcessArgs(
        "synara mcp pair --code syn_pair_v1_short-lived syn_mcp_v1_client-secret",
      ),
    ).toBe("synara mcp pair --code [redacted] [redacted]");
  });

  it("redacts secret environment assignments in process diagnostics", () => {
    for (const name of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GITHUB_TOKEN"]) {
      expect(redactSensitiveProcessArgs(`env ${name}=secret bun run dev`)).toBe(
        `env ${name}=[redacted]`,
      );
    }
  });

  it("redacts common secret key environment names", () => {
    for (const name of [
      "AWS_SECRET_ACCESS_KEY",
      "PRIVATE_KEY",
      "SECRET_KEY",
      "AWS_SESSION_TOKEN",
      "JWT_SIGNING_KEY",
      "ENCRYPTION_KEY",
      "MASTER_KEY",
      "PASSWORD",
      "TOKEN",
    ]) {
      expect(redactSensitiveProcessArgs(`env ${name}=secret bun run dev`)).toBe(
        `env ${name}=[redacted]`,
      );
    }
  });

  it("redacts complete shell-composed assignment values", () => {
    for (const assignment of [
      'PASSWORD="correct horse"battery',
      "DB_PASSWORD=correct\\ horse\\ battery",
      "TOKEN=prefix'middle'suffix",
      "DB_PASSWORD=$(printf supersecret)",
      "DB_PASSWORD=`printf supersecret`",
    ]) {
      const name = assignment.slice(0, assignment.indexOf("="));
      expect(redactSensitiveProcessArgs(`env ${assignment} bun run dev`)).toBe(
        `env ${name}=[redacted]`,
      );
    }
  });

  it("fails closed when process-table output loses a spaced secret's argv boundary", () => {
    expect(
      redactSensitiveProcessArgs("docker run -e APP_PASSWORD=correct horse image --verbose"),
    ).toBe("docker run -e APP_PASSWORD=[redacted]");
  });

  it("does not redact unrelated environment assignments", () => {
    const args = "env MONKEY=value TURKEY=istanbul NODE_ENV=development bun run dev";
    expect(redactSensitiveProcessArgs(args)).toBe(args);
  });

  it("leaves unrelated process arguments unchanged", () => {
    const args = "bun run dev --port 3000";
    expect(redactSensitiveProcessArgs(args)).toBe(args);
  });
});
