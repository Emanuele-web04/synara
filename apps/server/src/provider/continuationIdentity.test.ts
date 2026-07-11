// FILE: continuationIdentity.test.ts
// Purpose: Verifies provider-native storage identities across account path spellings.
// Layer: Server provider utility tests.

import assert from "node:assert/strict";
import fs from "node:fs";
import { homedir } from "node:os";
import os from "node:os";
import path from "node:path";

import { describe, it } from "vitest";

import {
  parseCodexSharedContinuationIdentity,
  prepareProviderContinuationIdentity,
  providerContinuationIdentity,
} from "./continuationIdentity.ts";
import { buildCodexProcessEnv } from "../codexProcessEnv.ts";
import { resolveCodexPathIdentity } from "../codexPathIdentity.ts";

describe("providerContinuationIdentity", () => {
  it("parses v2 identities without splitting Windows drive-letter colons", () => {
    assert.deepEqual(
      parseCodexSharedContinuationIdentity(
        String.raw`codex:shared-v2:123e4567-e89b-42d3-a456-426614174000:C:\Users\Ada\.codex`,
      ),
      {
        version: 2,
        generation: "123e4567-e89b-42d3-a456-426614174000",
        sourceIdentity: String.raw`C:\Users\Ada\.codex`,
      },
    );
  });

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
      const workBeforePreparation = providerContinuationIdentity(
        "codex",
        options("work", workShadowHomePath),
      );
      assert.notEqual(personalAfter, workBeforePreparation);
      assert.match(String(personalAfter), /^codex:shared-v2:[0-9a-f-]{36}:/);
      assert.match(String(workBeforePreparation), /^codex:overlay-v1:/);

      buildCodexProcessEnv({
        env: { ...process.env, ...environment },
        homePath,
        shadowHomePath: workShadowHomePath,
        accountId: "work",
      });
      const workAfter = providerContinuationIdentity("codex", options("work", workShadowHomePath));
      assert.equal(personalAfter, workAfter);

      fs.unlinkSync(path.join(homePath, "session_index.jsonl"));
      assert.match(
        String(providerContinuationIdentity("codex", options("work", workShadowHomePath))),
        /^codex:overlay-v1:/,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("atomically upgrades a healthy persisted v1 source to a generation identity", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "synara-continuation-v1-migration-"));
    try {
      const homePath = path.join(root, "codex-home");
      const environment = { SYNARA_HOME: path.join(root, "synara-runtime") };
      fs.mkdirSync(path.join(homePath, "sessions"), { recursive: true });
      fs.mkdirSync(path.join(homePath, "archived_sessions"), { recursive: true });
      fs.writeFileSync(path.join(homePath, "config.toml"), "", "utf8");
      fs.writeFileSync(path.join(homePath, "history.jsonl"), "", "utf8");
      fs.writeFileSync(path.join(homePath, "session_index.jsonl"), "", "utf8");
      const sourceIdentity = resolveCodexPathIdentity(homePath);
      fs.writeFileSync(
        path.join(homePath, "synara-shared-continuation-v1.json"),
        `${JSON.stringify({ version: 1, sourceHomeIdentity: sourceIdentity })}\n`,
        "utf8",
      );
      const options = { codex: { homePath, environment } };

      const migrated = prepareProviderContinuationIdentity(
        "codex",
        options,
        `codex:shared-v1:${sourceIdentity}`,
      );
      const parsed = parseCodexSharedContinuationIdentity(migrated);
      assert.equal(parsed?.version, 2);
      assert.equal(parsed?.sourceIdentity, sourceIdentity);
      assert.equal(
        JSON.parse(
          fs.readFileSync(path.join(homePath, "synara-shared-continuation-v2.json"), "utf8"),
        ).migratedFromVersion,
        1,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a legacy identity when the same source path has a fresh v2 generation", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "synara-continuation-v1-replaced-"));
    try {
      const homePath = path.join(root, "codex-home");
      const environment = { SYNARA_HOME: path.join(root, "synara-runtime") };
      fs.mkdirSync(homePath, { recursive: true });
      fs.writeFileSync(path.join(homePath, "config.toml"), "", "utf8");
      buildCodexProcessEnv({ env: { ...process.env, ...environment }, homePath });
      const sourceIdentity = resolveCodexPathIdentity(homePath);

      assert.throws(
        () =>
          prepareProviderContinuationIdentity(
            "codex",
            { codex: { homePath, environment } },
            `codex:shared-v1:${sourceIdentity}`,
          ),
        /new generation, not a verified migration/,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
