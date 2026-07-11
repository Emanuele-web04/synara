// FILE: claudeProcessEnv.test.ts
// Purpose: Covers Claude env sanitization so stale process tokens do not shadow CLI OAuth.
// Layer: Provider utility tests.
// Exports: Vitest coverage for apps/server/src/provider/claudeProcessEnv.ts.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, it, assert } from "@effect/vitest";

import {
  buildClaudeProcessEnv,
  CLAUDE_DIRECT_CREDENTIAL_ENV_KEYS,
  CLAUDE_EXTERNAL_AUTH_ENV_KEYS,
  hasUsableClaudeCliCredentials,
  readClaudeCliCredentialsContentSummary,
  resolveClaudeCredentialsPaths,
} from "./claudeProcessEnv.ts";
import { buildClaudeInstanceProcessEnv } from "./claudeEnvironment.ts";

describe("claudeProcessEnv", () => {
  it("prefers local Claude CLI credentials over stale direct request credentials", () => {
    const env = {
      PATH: "/bin",
      HOME: "/home/tester",
      CLAUDE_CONFIG_DIR: "/home/tester/.claude",
      ANTHROPIC_API_KEY: "stale-api-key",
      ANTHROPIC_AUTH_TOKEN: "stale-auth-token",
      CLAUDE_CODE_OAUTH_TOKEN: "stale-oauth-token",
    };

    const result = buildClaudeProcessEnv({
      env,
      hasClaudeCliCredentials: true,
    });

    assert.equal(result.PATH, "/bin");
    assert.equal(result.HOME, "/home/tester");
    assert.equal(result.CLAUDE_CONFIG_DIR, "/home/tester/.claude");
    assert.equal(result.ANTHROPIC_API_KEY, undefined);
    assert.equal(result.ANTHROPIC_AUTH_TOKEN, undefined);
    assert.equal(result.CLAUDE_CODE_OAUTH_TOKEN, undefined);
    assert.equal(env.ANTHROPIC_API_KEY, "stale-api-key");
  });

  it("keeps direct credentials when no local Claude CLI login is usable", () => {
    const result = buildClaudeProcessEnv({
      env: {
        ANTHROPIC_API_KEY: "api-key-auth",
      },
      hasClaudeCliCredentials: false,
    });

    assert.equal(result.ANTHROPIC_API_KEY, "api-key-auth");
  });

  it("does not grant Synara control-plane authority to Claude", () => {
    const result = buildClaudeProcessEnv({
      env: {
        ANTHROPIC_API_KEY: "api-key-auth",
        SYNARA_AUTH_TOKEN: "server-secret",
        SYNARA_BROWSER_USE_PIPE_PATH: "/tmp/browser.sock",
        NODE_OPTIONS: "--require=/tmp/inject.js",
      },
      hasClaudeCliCredentials: false,
    });

    assert.equal(result.ANTHROPIC_API_KEY, "api-key-auth");
    assert.equal(result.SYNARA_AUTH_TOKEN, undefined);
    assert.equal(result.SYNARA_BROWSER_USE_PIPE_PATH, undefined);
    assert.equal(result.NODE_OPTIONS, undefined);
  });

  it("aligns subprocess HOME with the credential home it checks", () => {
    const result = buildClaudeProcessEnv({
      env: {
        HOME: "/wrong-home",
      },
      homeDir: "/home/tester",
      hasClaudeCliCredentials: true,
    });

    assert.equal(result.HOME, "/home/tester");
  });

  it("keeps direct credentials for explicitly configured Claude-compatible backends", () => {
    const result = buildClaudeProcessEnv({
      env: {
        ANTHROPIC_API_KEY: "proxy-api-key",
        ANTHROPIC_BASE_URL: "https://anthropic-proxy.example.test",
      },
      hasClaudeCliCredentials: true,
    });

    assert.equal(result.ANTHROPIC_API_KEY, "proxy-api-key");
    assert.equal(result.ANTHROPIC_BASE_URL, "https://anthropic-proxy.example.test");
  });

  it("keeps direct credentials the provider instance sets explicitly", () => {
    const result = buildClaudeProcessEnv({
      env: {
        ANTHROPIC_API_KEY: "stale-inherited-key",
        ANTHROPIC_AUTH_TOKEN: "instance-auth-token",
      },
      hasClaudeCliCredentials: true,
      preserveDirectCredentialKeys: new Set(["ANTHROPIC_AUTH_TOKEN"]),
    });

    assert.equal(result.ANTHROPIC_API_KEY, undefined);
    assert.equal(result.ANTHROPIC_AUTH_TOKEN, "instance-auth-token");
  });

  it("overlays the provider instance home", () => {
    const result = buildClaudeInstanceProcessEnv("/home/work-account");

    assert.equal(result.HOME, "/home/work-account");
  });

  it("does not fall back to ambient auth when an explicit instance home lacks OAuth", () => {
    const inherited = {
      CLAUDE_CONFIG_DIR: "/home/account-a/.claude",
      ANTHROPIC_API_KEY: "account-a-api-key",
      ANTHROPIC_AUTH_TOKEN: "account-a-auth-token",
      CLAUDE_CODE_OAUTH_TOKEN: "account-a-oauth-token",
      ANTHROPIC_BASE_URL: "https://account-a.example.test",
      CLAUDE_CODE_USE_BEDROCK: "1",
      CLAUDE_CODE_USE_VERTEX: "1",
      CLAUDE_CODE_USE_FOUNDRY: "1",
      CLAUDE_CODE_USE_ANTHROPIC_AWS: "1",
    } satisfies NodeJS.ProcessEnv;
    const previous = Object.fromEntries(
      Object.keys(inherited).map((key) => [key, process.env[key]]),
    );
    Object.assign(process.env, inherited);
    try {
      const result = buildClaudeInstanceProcessEnv("/home/account-b");

      assert.equal(result.HOME, "/home/account-b");
      assert.equal(result.CLAUDE_CONFIG_DIR, undefined);
      for (const key of [...CLAUDE_DIRECT_CREDENTIAL_ENV_KEYS, ...CLAUDE_EXTERNAL_AUTH_ENV_KEYS]) {
        assert.equal(result[key], undefined);
        assert.notEqual(inherited[key], undefined);
      }
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("preserves auth and backend routing explicitly configured by the selected instance", () => {
    const result = buildClaudeInstanceProcessEnv("/home/account-b", {
      ANTHROPIC_API_KEY: "account-b-key",
      ANTHROPIC_BASE_URL: "https://account-b.example.test",
      CLAUDE_CODE_USE_FOUNDRY: "1",
    });

    assert.equal(result.HOME, "/home/account-b");
    assert.equal(result.ANTHROPIC_API_KEY, "account-b-key");
    assert.equal(result.ANTHROPIC_BASE_URL, "https://account-b.example.test");
    assert.equal(result.CLAUDE_CODE_USE_FOUNDRY, "1");
  });

  it("expands tilde provider instance homes", () => {
    const result = buildClaudeInstanceProcessEnv("~/.claude-work");

    assert.equal(result.HOME?.endsWith("/.claude-work"), true);
    assert.equal(result.HOME?.includes("~"), false);
  });

  it("expands Windows-style tilde instance homes", () => {
    const result = buildClaudeInstanceProcessEnv("~\\.claude-work");

    assert.equal(result.HOME?.endsWith(`${path.sep}.claude-work`), true);
    assert.equal(result.HOME?.includes("~"), false);
  });

  it("checks credentials under the final instance environment HOME", () => {
    const root = mkdtempSync(path.join(tmpdir(), "synara-claude-effective-home-"));
    const instanceHome = path.join(root, "account-b");
    try {
      mkdirSync(path.join(instanceHome, ".claude"), { recursive: true });
      writeFileSync(
        path.join(instanceHome, ".claude", ".credentials.json"),
        JSON.stringify({
          claudeAiOauth: {
            accessToken: "account-b-local-token",
            expiresAt: Date.now() + 60_000,
          },
        }),
      );

      const result = buildClaudeProcessEnv({
        env: {
          HOME: instanceHome,
          ANTHROPIC_API_KEY: "inherited-account-a-key",
        },
      });

      assert.equal(result.HOME, instanceHome);
      assert.equal(result.ANTHROPIC_API_KEY, undefined);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("checks CLAUDE_CONFIG_DIR before the default Claude home", () => {
    assert.deepEqual(
      resolveClaudeCredentialsPaths({
        env: { CLAUDE_CONFIG_DIR: "/tmp/custom-claude" },
        homeDir: "/home/tester",
      }),
      ["/tmp/custom-claude/.credentials.json", "/home/tester/.claude/.credentials.json"],
    );
  });

  it("detects usable Claude OAuth credential files", () => {
    assert.equal(
      readClaudeCliCredentialsContentSummary(
        JSON.stringify({
          claudeAiOauth: {
            accessToken: "local-access-token",
            expiresAt: 2_000,
          },
        }),
        1_000,
      ).usable,
      true,
    );

    assert.equal(
      readClaudeCliCredentialsContentSummary(
        JSON.stringify({
          claudeAiOauth: {
            accessToken: "expired-access-token",
            refreshToken: "refresh-token",
            expiresAt: 500,
          },
        }),
        1_000,
      ).usable,
      true,
    );
  });

  it("reads subscription metadata from usable Claude OAuth credentials", () => {
    assert.deepEqual(
      readClaudeCliCredentialsContentSummary(
        JSON.stringify({
          claudeAiOauth: {
            accessToken: "local-access-token",
            refreshToken: "refresh-token",
            expiresAt: 2_000,
            subscriptionType: "max",
          },
        }),
        1_000,
      ),
      { usable: true, subscriptionType: "max" },
    );
  });

  it("rejects leftover expired or malformed Claude credential files", () => {
    assert.equal(
      readClaudeCliCredentialsContentSummary(
        JSON.stringify({
          claudeAiOauth: {
            accessToken: "expired-access-token",
            expiresAt: 500,
          },
        }),
        1_000,
      ).usable,
      false,
    );
    assert.equal(readClaudeCliCredentialsContentSummary("{}", 1_000).usable, false);
    assert.equal(readClaudeCliCredentialsContentSummary("not json", 1_000).usable, false);
  });

  it("reads the first usable credentials path", () => {
    const seen: string[] = [];

    assert.equal(
      hasUsableClaudeCliCredentials({
        env: { CLAUDE_CONFIG_DIR: "/tmp/custom-claude" },
        homeDir: "/home/tester",
        nowMs: 1_000,
        readFile: (path) => {
          seen.push(path);
          if (path === "/tmp/custom-claude/.credentials.json") {
            throw new Error("missing");
          }
          return JSON.stringify({
            claudeAiOauth: {
              accessToken: "local-access-token",
              expiresAt: 2_000,
            },
          });
        },
      }),
      true,
    );
    assert.deepEqual(seen, [
      "/tmp/custom-claude/.credentials.json",
      "/home/tester/.claude/.credentials.json",
    ]);
  });
});
