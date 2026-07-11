// FILE: continuationIdentity.test.ts
// Purpose: Verifies provider-native storage identities across account path spellings.
// Layer: Server provider utility tests.

import assert from "node:assert/strict";
import fs from "node:fs";
import { homedir } from "node:os";
import os from "node:os";
import path from "node:path";

import { describe, it } from "vitest";

import { providerContinuationIdentity } from "./continuationIdentity.ts";
import { buildCodexProcessEnv } from "../codexProcessEnv.ts";

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

  it("uses overlay-specific identities until shared Codex continuation preparation succeeds", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "synara-continuation-identity-"));
    try {
      const homePath = path.join(root, "codex-home");
      const personalShadowHomePath = path.join(root, "personal");
      const workShadowHomePath = path.join(root, "work");
      const environment = { SYNARA_HOME: path.join(root, "synara-runtime") };
      for (const directoryPath of [homePath, personalShadowHomePath, workShadowHomePath]) {
        fs.mkdirSync(directoryPath, { recursive: true });
      }
      fs.writeFileSync(path.join(homePath, "config.toml"), "", "utf8");
      fs.writeFileSync(path.join(personalShadowHomePath, "auth.json"), "{}", "utf8");
      fs.writeFileSync(path.join(workShadowHomePath, "auth.json"), "{}", "utf8");
      const options = (accountId: string, shadowHomePath: string) => ({
        codex: { homePath, shadowHomePath, accountId, environment },
      });

      const personalBefore = providerContinuationIdentity(
        "codex",
        options("personal", personalShadowHomePath),
      );
      const workBefore = providerContinuationIdentity("codex", options("work", workShadowHomePath));
      assert.notEqual(personalBefore, workBefore);
      assert.match(String(personalBefore), /^codex:overlay-v1:/);

      buildCodexProcessEnv({
        env: { ...process.env, ...environment },
        homePath,
        shadowHomePath: personalShadowHomePath,
        accountId: "personal",
      });

      const personalAfter = providerContinuationIdentity(
        "codex",
        options("personal", personalShadowHomePath),
      );
      const workAfter = providerContinuationIdentity("codex", options("work", workShadowHomePath));
      assert.equal(personalAfter, workAfter);
      assert.match(String(personalAfter), /^codex:shared-v1:/);

      fs.unlinkSync(path.join(homePath, "state_5.sqlite"));
      assert.match(
        String(providerContinuationIdentity("codex", options("work", workShadowHomePath))),
        /^codex:overlay-v1:/,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
