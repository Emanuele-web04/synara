// FILE: claudeProcessEnv.test.ts
// Purpose: Covers Claude env sanitization so stale process tokens do not shadow CLI OAuth.
// Layer: Provider utility tests.
// Exports: Vitest coverage for apps/server/src/provider/claudeProcessEnv.ts.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, it, assert } from "@effect/vitest";

import { buildClaudeProcessEnv } from "./claudeEnvironment.ts";
import {
  CLAUDE_ACCOUNT_ISOLATION_ENV_KEYS,
  hasUsableClaudeCliCredentials,
  hasUsableClaudeCliCredentialsContent,
  readClaudeCliCredentialsContentSummary,
  resolveClaudeCredentialsPaths,
} from "./claudeProcessEnv.ts";

describe("claudeProcessEnv", () => {
  const dynamicAccountEnvironment = {
    AWS_ENDPOINT_URL_FUTURE_SERVICE: "https://account.example.test/aws",
    VERTEX_REGION_CLAUDE_FUTURE_MODEL: "account-region",
  };

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
        CLAUDE_CODE_USE_MANTLE: "1",
      },
      hasClaudeCliCredentials: true,
    });

    assert.equal(result.ANTHROPIC_API_KEY, "proxy-api-key");
    assert.equal(result.CLAUDE_CODE_USE_MANTLE, "1");
  });

  it("treats an instance-only environment as an account isolation boundary", () => {
    const result = buildClaudeProcessEnv({
      env: {
        PATH: "/bin",
        HOME: "/home/account-a",
        ANTHROPIC_API_KEY: "stale-inherited-key",
        AWS_PROFILE: "account-a-profile",
        GOOGLE_APPLICATION_CREDENTIALS: "/account-a/google.json",
        AZURE_CLIENT_SECRET: "account-a-azure-secret",
        HTTPS_PROXY: "https://shared-network-proxy.example.test",
      },
      environment: { ANTHROPIC_AUTH_TOKEN: "instance-auth-token" },
      hasClaudeCliCredentials: false,
    });

    assert.equal(result.HOME, "/home/account-a");
    assert.equal(result.PATH, "/bin");
    assert.equal(result.ANTHROPIC_API_KEY, undefined);
    assert.equal(result.ANTHROPIC_AUTH_TOKEN, "instance-auth-token");
    assert.equal(result.AWS_PROFILE, undefined);
    assert.equal(result.GOOGLE_APPLICATION_CREDENTIALS, undefined);
    assert.equal(result.AZURE_CLIENT_SECRET, undefined);
    assert.equal(result.HTTPS_PROXY, "https://shared-network-proxy.example.test");
  });

  it("preserves cloud auth explicitly supplied by an environment-only instance", () => {
    const result = buildClaudeProcessEnv({
      env: {
        HOME: "/home/account-a",
        ANTHROPIC_API_KEY: "account-a-key",
        AWS_PROFILE: "account-a-profile",
        GOOGLE_APPLICATION_CREDENTIALS: "/account-a/google.json",
        AZURE_CLIENT_SECRET: "account-a-azure-secret",
      },
      environment: {
        CLAUDE_CODE_USE_BEDROCK: "1",
        AWS_PROFILE: "account-b-profile",
        GOOGLE_APPLICATION_CREDENTIALS: "/account-b/google.json",
        AZURE_CLIENT_SECRET: "account-b-azure-secret",
      },
      hasClaudeCliCredentials: false,
    });

    assert.equal(result.ANTHROPIC_API_KEY, undefined);
    assert.equal(result.CLAUDE_CODE_USE_BEDROCK, "1");
    assert.equal(result.AWS_PROFILE, "account-b-profile");
    assert.equal(result.GOOGLE_APPLICATION_CREDENTIALS, "/account-b/google.json");
    assert.equal(result.AZURE_CLIENT_SECRET, "account-b-azure-secret");
  });

  it("treats an explicitly empty instance environment as an isolation boundary", () => {
    const result = buildClaudeProcessEnv({
      env: {
        ANTHROPIC_API_KEY: "account-a-key",
        AWS_PROFILE: "account-a-profile",
      },
      environment: {},
      hasClaudeCliCredentials: false,
    });

    assert.equal(result.ANTHROPIC_API_KEY, undefined);
    assert.equal(result.AWS_PROFILE, undefined);
  });

  it("overlays the instance home and looks up credentials there", () => {
    const accountEnvironment = Object.fromEntries(
      CLAUDE_ACCOUNT_ISOLATION_ENV_KEYS.map((key) => [key, `account-a-${key}`]),
    );
    const result = buildClaudeProcessEnv({
      env: {
        ...accountEnvironment,
        ...dynamicAccountEnvironment,
        HOME: "/home/default",
        CLAUDE_CONFIG_DIR: "/home/default/.claude",
        HTTPS_PROXY: "https://shared-network-proxy.example.test",
        NODE_EXTRA_CA_CERTS: "/shared/network-ca.pem",
      },
      homePath: "/home/work-account",
      hasClaudeCliCredentials: true,
    });

    assert.equal(result.HOME, "/home/work-account");
    assert.equal(result.CLAUDE_CONFIG_DIR, undefined);
    for (const key of CLAUDE_ACCOUNT_ISOLATION_ENV_KEYS) {
      assert.equal(result[key], undefined);
    }
    for (const key of Object.keys(dynamicAccountEnvironment)) {
      assert.equal(result[key], undefined);
    }
    assert.equal(result.HTTPS_PROXY, "https://shared-network-proxy.example.test");
    assert.equal(result.NODE_EXTRA_CA_CERTS, "/shared/network-ca.pem");
  });

  it("does not fall back to ambient auth when an explicit instance home lacks OAuth", () => {
    const accountEnvironment = Object.fromEntries(
      CLAUDE_ACCOUNT_ISOLATION_ENV_KEYS.map((key) => [key, `account-a-${key}`]),
    );
    const inherited: NodeJS.ProcessEnv = {
      ...accountEnvironment,
      ...dynamicAccountEnvironment,
      HOME: "/home/account-a",
    };

    const result = buildClaudeProcessEnv({
      env: inherited,
      homePath: "/home/account-b",
      hasClaudeCliCredentials: false,
    });

    assert.equal(result.HOME, "/home/account-b");
    for (const key of CLAUDE_ACCOUNT_ISOLATION_ENV_KEYS) {
      assert.equal(result[key], undefined);
      assert.notEqual(inherited[key], undefined);
    }
    for (const key of Object.keys(dynamicAccountEnvironment)) {
      assert.equal(result[key], undefined);
    }
  });

  it("preserves auth and backend routing explicitly configured by the selected instance", () => {
    const instanceEnvironment = Object.fromEntries(
      CLAUDE_ACCOUNT_ISOLATION_ENV_KEYS.map((key) => [key, `account-b-${key}`]),
    );
    Object.assign(instanceEnvironment, dynamicAccountEnvironment);
    const result = buildClaudeProcessEnv({
      env: {
        HOME: "/home/account-a",
        ANTHROPIC_API_KEY: "account-a-key",
        AWS_PROFILE: "account-a-profile",
        GOOGLE_APPLICATION_CREDENTIALS: "/account-a/google.json",
        AZURE_CLIENT_SECRET: "account-a-azure-secret",
      },
      homePath: "/home/account-b",
      environment: instanceEnvironment,
      hasClaudeCliCredentials: true,
    });

    assert.equal(result.HOME, "/home/account-b");
    for (const key of CLAUDE_ACCOUNT_ISOLATION_ENV_KEYS) {
      assert.equal(result[key], `account-b-${key}`);
    }
    for (const [key, value] of Object.entries(dynamicAccountEnvironment)) {
      assert.equal(result[key], value);
    }
  });

  it("keeps an instance-configured Claude config directory with an explicit home", () => {
    const result = buildClaudeProcessEnv({
      env: {
        HOME: "/home/default",
        CLAUDE_CONFIG_DIR: "/home/default/.claude",
      },
      homePath: "/home/work-account",
      environment: { CLAUDE_CONFIG_DIR: "/home/work-account/config" },
      hasClaudeCliCredentials: true,
    });

    assert.equal(result.HOME, "/home/work-account");
    assert.equal(result.CLAUDE_CONFIG_DIR, "/home/work-account/config");
  });

  it("expands tilde instance homes before setting HOME and checking credentials", () => {
    const result = buildClaudeProcessEnv({
      env: { HOME: "/home/default", ANTHROPIC_API_KEY: "stale-key" },
      homeDir: "/Users/tester",
      homePath: "~/.claude-work",
      hasClaudeCliCredentials: true,
    });

    assert.equal(result.HOME, "/Users/tester/.claude-work");
    assert.equal(result.ANTHROPIC_API_KEY, undefined);
  });

  it("expands Windows-style tilde instance homes", () => {
    const result = buildClaudeProcessEnv({
      env: { HOME: "/home/default" },
      homeDir: "/Users/tester",
      homePath: "~\\.claude-work",
      hasClaudeCliCredentials: false,
    });

    assert.equal(result.HOME, "/Users/tester/.claude-work");
  });

  it("checks credentials under the final instance environment HOME", () => {
    const root = mkdtempSync(path.join(tmpdir(), "synara-claude-effective-home-"));
    const inheritedHome = path.join(root, "account-a");
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
          HOME: inheritedHome,
          ANTHROPIC_API_KEY: "inherited-account-a-key",
        },
        homeDir: inheritedHome,
        environment: { HOME: instanceHome },
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
      hasUsableClaudeCliCredentialsContent(
        JSON.stringify({
          claudeAiOauth: {
            accessToken: "local-access-token",
            expiresAt: 2_000,
          },
        }),
        1_000,
      ),
      true,
    );

    assert.equal(
      hasUsableClaudeCliCredentialsContent(
        JSON.stringify({
          claudeAiOauth: {
            accessToken: "expired-access-token",
            refreshToken: "refresh-token",
            expiresAt: 500,
          },
        }),
        1_000,
      ),
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
      hasUsableClaudeCliCredentialsContent(
        JSON.stringify({
          claudeAiOauth: {
            accessToken: "expired-access-token",
            expiresAt: 500,
          },
        }),
        1_000,
      ),
      false,
    );
    assert.equal(hasUsableClaudeCliCredentialsContent("{}", 1_000), false);
    assert.equal(hasUsableClaudeCliCredentialsContent("not json", 1_000), false);
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
