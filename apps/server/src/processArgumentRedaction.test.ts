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
    expect(
      redactSensitiveProcessArgs(
        "env OPENAI_API_KEY=sk-example ANTHROPIC_API_KEY='quoted-secret' GITHUB_TOKEN=ghp_example bun run dev",
      ),
    ).toBe(
      "env OPENAI_API_KEY=[redacted] ANTHROPIC_API_KEY=[redacted] GITHUB_TOKEN=[redacted] bun run dev",
    );
  });

  it("redacts common secret key environment names", () => {
    expect(
      redactSensitiveProcessArgs(
        "env AWS_SECRET_ACCESS_KEY=aws-secret PRIVATE_KEY=private SECRET_KEY=secret AWS_SESSION_TOKEN=session",
      ),
    ).toBe(
      "env AWS_SECRET_ACCESS_KEY=[redacted] PRIVATE_KEY=[redacted] SECRET_KEY=[redacted] AWS_SESSION_TOKEN=[redacted]",
    );
  });

  it("redacts complete shell-composed assignment values", () => {
    expect(
      redactSensitiveProcessArgs(
        "env PASSWORD=\"correct horse\"battery DB_PASSWORD=correct\\ horse\\ battery TOKEN=prefix'middle'suffix bun run dev",
      ),
    ).toBe("env PASSWORD=[redacted] DB_PASSWORD=[redacted] TOKEN=[redacted] bun run dev");
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
