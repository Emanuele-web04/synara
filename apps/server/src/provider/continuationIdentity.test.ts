// FILE: continuationIdentity.test.ts
// Purpose: Verifies provider-native storage identities across account path spellings.
// Layer: Server provider utility tests.

import assert from "node:assert/strict";
import { homedir } from "node:os";
import path from "node:path";

import { describe, it } from "vitest";

import { providerContinuationIdentity } from "./continuationIdentity.ts";

describe("providerContinuationIdentity", () => {
  it("treats Windows and Unix tilde separators as the same Claude home", () => {
    const windowsSpelling = providerContinuationIdentity("claudeAgent", {
      claudeAgent: { homePath: "~\\.claude-work" },
    });
    const unixSpelling = providerContinuationIdentity("claudeAgent", {
      claudeAgent: { homePath: "~/.claude-work" },
    });
    const absoluteSpelling = providerContinuationIdentity("claudeAgent", {
      claudeAgent: { homePath: path.join(homedir(), ".claude-work") },
    });

    assert.equal(windowsSpelling, unixSpelling);
    assert.equal(windowsSpelling, absoluteSpelling);
  });
});
