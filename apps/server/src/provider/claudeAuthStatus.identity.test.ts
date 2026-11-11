import { describe, expect, it } from "vitest";

import { parseClaudeAccountIdentityFromOutput } from "./claudeAuthStatus";

describe("Claude account identity", () => {
  it("reads the signed-in email and organization from auth status JSON", () => {
    const identity = parseClaudeAccountIdentityFromOutput({
      stdout:
        '{"loggedIn":true,"authMethod":"claude.ai","email":"work@example.com","orgId":"org_1","orgName":"Example Org","subscriptionType":"max"}\n',
      stderr: "",
      code: 0,
    });

    expect(identity).toEqual({ email: "work@example.com", organization: "Example Org" });
  });

  it("trims the values and drops blank ones", () => {
    const identity = parseClaudeAccountIdentityFromOutput({
      stdout:
        '{"loggedIn":true,"authMethod":"claude.ai","email":"  work@example.com  ","orgName":"   "}',
      stderr: "",
      code: 0,
    });

    expect(identity).toEqual({ email: "work@example.com" });
  });

  it("reports no identity for output that is not a JSON object", () => {
    expect(
      parseClaudeAccountIdentityFromOutput({ stdout: "Authenticated", stderr: "", code: 0 }),
    ).toEqual({});
    expect(
      parseClaudeAccountIdentityFromOutput({ stdout: '{"loggedIn":', stderr: "", code: 0 }),
    ).toEqual({});
    expect(
      parseClaudeAccountIdentityFromOutput({ stdout: '["work@example.com"]', stderr: "", code: 0 }),
    ).toEqual({});
  });

  it("ignores identity fields from API-key login output", () => {
    expect(
      parseClaudeAccountIdentityFromOutput({
        stdout:
          '{"loggedIn":true,"authMethod":"apiKey","email":"stale@example.com","orgName":"Old Org"}',
        stderr: "",
        code: 0,
      }),
    ).toEqual({});
  });

  it("ignores identity fields that are not strings", () => {
    const identity = parseClaudeAccountIdentityFromOutput({
      stdout:
        '{"loggedIn":true,"authMethod":"claude.ai","email":{"address":"work@example.com"},"orgName":42}',
      stderr: "",
      code: 0,
    });

    expect(identity).toEqual({});
  });
});
