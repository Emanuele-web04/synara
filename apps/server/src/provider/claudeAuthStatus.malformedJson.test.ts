import { describe, expect, it } from "vitest";

import { parseClaudeAuthStatusFromOutput } from "./claudeAuthStatus";

describe("Claude auth status malformed JSON", () => {
  it("does not treat malformed JSON with exit code zero as authenticated", () => {
    expect(
      parseClaudeAuthStatusFromOutput({
        stdout: '{"loggedIn":',
        stderr: "",
        code: 0,
      }),
    ).toEqual({
      status: "warning",
      authStatus: "unknown",
      message: "Could not verify Claude authentication status from JSON output (missing auth marker).",
    });
  });

  it("keeps plain successful non-JSON output on the legacy authenticated fallback", () => {
    expect(
      parseClaudeAuthStatusFromOutput({
        stdout: "Authenticated",
        stderr: "",
        code: 0,
      }),
    ).toEqual({ status: "ready", authStatus: "authenticated" });
  });
});
