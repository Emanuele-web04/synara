// FILE: claudeAccountEnvironment.test.ts
// Purpose: Focused tests for the Claude managed-account environment builder.
// Layer: Server unit tests

import { describe, expect, it } from "vitest";

import { ACCOUNT_ENV_UNSET } from "./accountEnvironment";
import { buildClaudeAccountEnvironment } from "./claudeAccountEnvironment";

describe("buildClaudeAccountEnvironment", () => {
  it("pins CLAUDE_CONFIG_DIR to the account agent home", () => {
    const result = buildClaudeAccountEnvironment({
      provider: "claudeAgent",
      ordinal: 1,
      authMethod: "oauth",
      agentHome: "/accounts/claudeAgent/1/agent",
    });
    expect(result.environment.CLAUDE_CONFIG_DIR).toBe("/accounts/claudeAgent/1/agent");
    expect(result.profilePath).toBe("/accounts/claudeAgent/1/agent");
  });

  it("strips conflicting inherited auth overrides", () => {
    const result = buildClaudeAccountEnvironment({
      provider: "claudeAgent",
      ordinal: 1,
      authMethod: "oauth",
      agentHome: "/accounts/claudeAgent/1/agent",
    });
    for (const name of [
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "ANTHROPIC_BASE_URL",
      "CLAUDE_CODE_USE_BEDROCK",
      "CLAUDE_CODE_USE_VERTEX",
      "CLAUDE_CODE_USE_ANTHROPIC_AWS",
    ]) {
      expect(result.environment[name]).toBe(ACCOUNT_ENV_UNSET);
    }
  });

  it("injects the resolved API key for API-key accounts", () => {
    const result = buildClaudeAccountEnvironment({
      provider: "claudeAgent",
      ordinal: 2,
      authMethod: "apiKey",
      agentHome: "/accounts/claudeAgent/2/agent",
      apiKey: "sk-ant-managed",
    });
    expect(result.environment.ANTHROPIC_API_KEY).toBe("sk-ant-managed");
  });

  it("keeps OAuth launches free of injected API keys", () => {
    const result = buildClaudeAccountEnvironment({
      provider: "claudeAgent",
      ordinal: 1,
      authMethod: "oauth",
      agentHome: "/accounts/claudeAgent/1/agent",
    });
    expect(result.environment.ANTHROPIC_API_KEY).toBe(ACCOUNT_ENV_UNSET);
  });
});
