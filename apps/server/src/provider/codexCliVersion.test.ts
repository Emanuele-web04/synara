// FILE: codexCliVersion.test.ts
// Purpose: Guards the Codex CLI compatibility boundary required by Synara runtime features.
// Layer: Server provider unit tests
// Exports: Vitest coverage for provider/codexCliVersion.ts.

import assert from "node:assert/strict";

import { describe, it } from "vitest";

import {
  formatCodexCliUpgradeMessage,
  isCodexCliVersionSupported,
  MINIMUM_CODEX_CLI_VERSION,
} from "./codexCliVersion.ts";

describe("codexCliVersion", () => {
  it("requires the first stable release that honors CODEX_SQLITE_HOME", () => {
    assert.equal(MINIMUM_CODEX_CLI_VERSION, "0.105.0");
    assert.equal(isCodexCliVersionSupported("0.104.0"), false);
    assert.equal(isCodexCliVersionSupported("0.105.0-alpha.22"), false);
    assert.equal(isCodexCliVersionSupported("0.105.0"), true);
    assert.equal(isCodexCliVersionSupported("0.105.1"), true);
  });

  it("names the continuation-safe minimum in upgrade guidance", () => {
    assert.equal(
      formatCodexCliUpgradeMessage("0.104.0"),
      "Codex CLI v0.104.0 is too old for Synara. Upgrade to v0.105.0 or newer and restart Synara.",
    );
  });
});
