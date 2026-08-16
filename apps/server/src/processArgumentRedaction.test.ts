import { describe, expect, it } from "vitest";

import { redactSensitiveProcessArgs } from "./processArgumentRedaction";

const redactProcessTableArgs = (args: string) =>
  redactSensitiveProcessArgs(args, { truncateSensitiveEnvironmentRemainder: true });

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
      expect(redactProcessTableArgs(`env ${name}=secret bun run dev`)).toBe(
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
      expect(redactProcessTableArgs(`env ${name}=secret bun run dev`)).toBe(
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
      expect(redactProcessTableArgs(`env ${assignment} bun run dev`)).toBe(
        `env ${name}=[redacted]`,
      );
    }
  });

  it("fails closed when process-table output loses a spaced secret's argv boundary", () => {
    expect(redactProcessTableArgs("docker run -e APP_PASSWORD=correct horse image --verbose")).toBe(
      "docker run -e APP_PASSWORD=[redacted]",
    );
  });

  it("recognizes sensitive assignments after flattened shell separators", () => {
    for (const separator of [";", "&&", "||", "("]) {
      expect(redactProcessTableArgs(`/bin/sh -c echo ready${separator}PASSWORD=secret app`)).toBe(
        `/bin/sh -c echo ready${separator}PASSWORD=[redacted]`,
      );
    }
  });

  it("recognizes sensitive assignments quoted as complete shell words", () => {
    for (const quote of ["'", '"']) {
      expect(redactProcessTableArgs(`sh -c env ${quote}PASSWORD=secret${quote} sleep 30`)).toBe(
        `sh -c env ${quote}PASSWORD=[redacted]`,
      );
    }
  });

  it("redacts complete externally quoted and nested bounded assignment values", () => {
    expect(redactSensitiveProcessArgs("'PASSWORD=correct horse' remains useful")).toBe(
      "'PASSWORD=[redacted]' remains useful",
    );
    expect(
      redactSensitiveProcessArgs('PASSWORD=$(printf x "$(printf y)")supersecret remains useful'),
    ).toBe("PASSWORD=[redacted] remains useful");
    expect(
      redactSensitiveProcessArgs('"PASSWORD=$(printf x "$(printf y)")supersecret" remains useful'),
    ).toBe('"PASSWORD=[redacted]" remains useful');
    expect(
      redactSensitiveProcessArgs("PASSWORD=${UNSET:-correct horse}suffix remains useful"),
    ).toBe("PASSWORD=[redacted] remains useful");
    expect(redactSensitiveProcessArgs("PASSWORD=$((1 + (2 * 3)))supersecret remains useful")).toBe(
      "PASSWORD=[redacted] remains useful",
    );
  });

  it("recognizes append-style sensitive assignments", () => {
    expect(redactSensitiveProcessArgs("PASSWORD+=supersecret remains useful")).toBe(
      "PASSWORD+=[redacted] remains useful",
    );
    expect(redactProcessTableArgs("bash -c PASSWORD+=supersecret; sleep 30")).toBe(
      "bash -c PASSWORD+=[redacted]",
    );
  });

  it("redacts established database credential environment names", () => {
    for (const name of ["PGPASSWORD", "MYSQL_PWD", "REDISCLI_AUTH"]) {
      expect(redactProcessTableArgs(`env ${name}=supersecret server`)).toBe(
        `env ${name}=[redacted]`,
      );
      expect(redactSensitiveProcessArgs(`${name}=supersecret remains useful`)).toBe(
        `${name}=[redacted] remains useful`,
      );
    }
  });

  it("redacts credential-bearing environment URLs in process tables", () => {
    expect(
      redactProcessTableArgs(
        "env DATABASE_URL=postgres://alice:supersecret@db.example/app bun run dev",
      ),
    ).toBe("env DATABASE_URL=[redacted]");
  });

  it("preserves generic diagnostic context after a bounded assignment value", () => {
    expect(redactSensitiveProcessArgs("Configuration KEY=value is invalid at line 42")).toBe(
      "Configuration KEY=[redacted] is invalid at line 42",
    );
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
