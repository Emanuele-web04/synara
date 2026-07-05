// FILE: claudeCredentialKeepalive.test.ts
// Purpose: Regression tests for the macOS Claude credential keepalive helper.
// Layer: Provider utility tests.
// Exports: Vitest coverage for apps/server/src/provider/claudeCredentialKeepalive.ts.
import { describe, it, assert } from "@effect/vitest";

import {
  CLAUDE_CREDENTIAL_KEEPALIVE_AUTH_STATUS_ARGS,
  CLAUDE_CREDENTIAL_KEEPALIVE_MAX_INTERVAL_MS,
  isClaudeCredentialKeepaliveEnabled,
  resolveClaudeCredentialKeepaliveBinaryPath,
  resolveClaudeCredentialKeepaliveIntervalMs,
} from "./claudeCredentialKeepalive.ts";

describe("claudeCredentialKeepalive", () => {
  it("uses the documented Claude auth status command", () => {
    assert.deepEqual([...CLAUDE_CREDENTIAL_KEEPALIVE_AUTH_STATUS_ARGS], ["auth", "status"]);
  });

  it("requires explicit opt-in on macOS", () => {
    assert.equal(isClaudeCredentialKeepaliveEnabled({ platform: "darwin", env: {} }), false);
    assert.equal(
      isClaudeCredentialKeepaliveEnabled({
        platform: "darwin",
        env: { T3CODE_CLAUDE_KEEPALIVE: "1" },
      }),
      true,
    );
    assert.equal(
      isClaudeCredentialKeepaliveEnabled({
        platform: "linux",
        env: { T3CODE_CLAUDE_KEEPALIVE: "1" },
      }),
      false,
    );
  });

  it("resolves configured Claude binary paths with a safe default", () => {
    assert.equal(
      resolveClaudeCredentialKeepaliveBinaryPath("/opt/homebrew/bin/claude"),
      "/opt/homebrew/bin/claude",
    );
    assert.equal(
      resolveClaudeCredentialKeepaliveBinaryPath("  /custom/bin/claude  "),
      "/custom/bin/claude",
    );
    assert.equal(resolveClaudeCredentialKeepaliveBinaryPath("   "), "claude");
    assert.equal(resolveClaudeCredentialKeepaliveBinaryPath(undefined), "claude");
  });

  it("clamps keepalive intervals to Node's maximum timer delay", () => {
    assert.equal(
      resolveClaudeCredentialKeepaliveIntervalMs({
        T3CODE_CLAUDE_KEEPALIVE_MINUTES: "60",
      }),
      60 * 60 * 1000,
    );
    assert.equal(
      resolveClaudeCredentialKeepaliveIntervalMs({
        T3CODE_CLAUDE_KEEPALIVE_MINUTES: "999999999",
      }),
      CLAUDE_CREDENTIAL_KEEPALIVE_MAX_INTERVAL_MS,
    );
  });

  it("falls back to the default interval for invalid tuning values", () => {
    assert.equal(
      resolveClaudeCredentialKeepaliveIntervalMs({
        T3CODE_CLAUDE_KEEPALIVE_MINUTES: "0",
      }),
      30 * 60 * 1000,
    );
    assert.equal(resolveClaudeCredentialKeepaliveIntervalMs({}), 30 * 60 * 1000);
  });
});
