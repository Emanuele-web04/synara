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
  CLAUDE_ACCOUNT_ISOLATION_ENV_KEYS,
  hasUsableClaudeCliCredentials,
  readClaudeCliCredentialsContentSummary,
  resolveClaudeCredentialsPaths,
} from "./claudeProcessEnv.ts";
import {
  buildClaudeInstanceProcessEnv,
  claudeIsolatedHomePath,
} from "./claudeEnvironment.ts";

describe("claudeProcessEnv", () => {
  const dynamicAccountEnvironment = {
    AWS_ENDPOINT_URL_FUTURE_SERVICE: "https://account.example.test/aws",
    VERTEX_REGION_CLAUDE_FUTURE_MODEL: "account-region",
  };

  function withAmbientEnvironment<T>(
    ambient: Readonly<Record<string, string>>,
    run: () => T,
  ): T {
    const previous = Object.fromEntries(
      Object.keys(ambient).map((key) => [key, process.env[key]]),
    );
    Object.assign(process.env, ambient);
    try {
      return run();
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }

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
        CLAUDE_CODE_USE_MANTLE: "1",
      },
      hasClaudeCliCredentials: true,
    });

    assert.equal(result.ANTHROPIC_API_KEY, "proxy-api-key");
    assert.equal(result.CLAUDE_CODE_USE_MANTLE, "1");
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

  it("treats an instance-only environment as an account isolation boundary", () => {
    const result = withAmbientEnvironment(
      {
        ANTHROPIC_API_KEY: "stale-inherited-key",
        AWS_PROFILE: "account-a-profile",
        GOOGLE_APPLICATION_CREDENTIALS: "/account-a/google.json",
        AZURE_CLIENT_SECRET: "account-a-azure-secret",
        HTTPS_PROXY: "https://shared-network-proxy.example.test",
      },
      () =>
        buildClaudeInstanceProcessEnv(
          undefined,
          { ANTHROPIC_AUTH_TOKEN: "instance-token" },
          { isolationRootDir: "/synara/state", providerInstanceId: "claude_work" },
        ),
    );

    assert.equal(
      result.HOME,
      claudeIsolatedHomePath({
        isolationRootDir: "/synara/state",
        providerInstanceId: "claude_work",
      }),
    );
    assert.equal(result.ANTHROPIC_API_KEY, undefined);
    assert.equal(result.ANTHROPIC_AUTH_TOKEN, "instance-token");
    assert.equal(result.AWS_PROFILE, undefined);
    assert.equal(result.GOOGLE_APPLICATION_CREDENTIALS, undefined);
    assert.equal(result.AZURE_CLIENT_SECRET, undefined);
    assert.equal(result.HTTPS_PROXY, "https://shared-network-proxy.example.test");
  });

  it("preserves cloud auth explicitly supplied by an environment-only instance", () => {
    const result = withAmbientEnvironment(
      {
        ANTHROPIC_API_KEY: "account-a-key",
        AWS_PROFILE: "account-a-profile",
        GOOGLE_APPLICATION_CREDENTIALS: "/account-a/google.json",
        AZURE_CLIENT_SECRET: "account-a-azure-secret",
      },
      () =>
        buildClaudeInstanceProcessEnv(undefined, {
          CLAUDE_CODE_USE_BEDROCK: "1",
          AWS_PROFILE: "account-b-profile",
          GOOGLE_APPLICATION_CREDENTIALS: "/account-b/google.json",
          AZURE_CLIENT_SECRET: "account-b-azure-secret",
        }),
    );

    assert.equal(result.ANTHROPIC_API_KEY, undefined);
    assert.equal(result.CLAUDE_CODE_USE_BEDROCK, "1");
    assert.equal(result.AWS_PROFILE, "account-b-profile");
    assert.equal(result.GOOGLE_APPLICATION_CREDENTIALS, "/account-b/google.json");
    assert.equal(result.AZURE_CLIENT_SECRET, "account-b-azure-secret");
  });

  it("treats an explicitly empty instance environment as an isolation boundary", () => {
    const result = withAmbientEnvironment(
      { ANTHROPIC_API_KEY: "account-a-key", AWS_PROFILE: "account-a-profile" },
      () => buildClaudeInstanceProcessEnv(undefined, {}),
    );

    assert.equal(result.ANTHROPIC_API_KEY, undefined);
    assert.equal(result.AWS_PROFILE, undefined);
  });

  it("keeps empty and redacted custom instances on distinct isolated homes", () => {
    const isolationRootDir = "/synara/state";
    const redactedA = buildClaudeInstanceProcessEnv(undefined, undefined, {
      homeDir: "/home/server",
      isolationRootDir,
      providerInstanceId: "claude_redacted_a",
    });
    const redactedB = buildClaudeInstanceProcessEnv(undefined, undefined, {
      homeDir: "/home/server",
      isolationRootDir,
      providerInstanceId: "claude_redacted_b",
    });
    const explicitlyEmpty = buildClaudeInstanceProcessEnv(undefined, {}, {
      homeDir: "/home/server",
      isolationRootDir,
      providerInstanceId: "claude_empty",
    });

    assert.notEqual(redactedA.HOME, redactedB.HOME);
    assert.notEqual(redactedA.HOME, explicitlyEmpty.HOME);
    assert.notEqual(redactedB.HOME, explicitlyEmpty.HOME);
    for (const isolatedHome of [redactedA.HOME, redactedB.HOME, explicitlyEmpty.HOME]) {
      assert.ok(isolatedHome);
      assert.equal(path.isAbsolute(isolatedHome), true);
      assert.equal(path.relative(isolationRootDir, isolatedHome).startsWith(".."), false);
    }
  });

  it("contains encoded provider instance ids within the Synara isolation root", () => {
    const isolationRootDir = "/synara/state";
    const isolatedHome = claudeIsolatedHomePath({
      isolationRootDir,
      providerInstanceId: "../../outside/account",
    });
    const relativeHome = path.relative(isolationRootDir, isolatedHome);

    assert.equal(path.isAbsolute(isolatedHome), true);
    assert.equal(relativeHome.startsWith(".."), false);
    assert.equal(relativeHome.includes("outside/account"), false);
  });

  it("keeps mixed-case instance ids distinct on case-insensitive filesystems", () => {
    const isolationRootDir = "/synara/state";
    const upperHome = claudeIsolatedHomePath({ isolationRootDir, providerInstanceId: "AAG" });
    const lowerHome = claudeIsolatedHomePath({ isolationRootDir, providerInstanceId: "AAa" });

    assert.notEqual(upperHome.toLowerCase(), lowerHome.toLowerCase());
  });

  it("preserves the default instance home unless it configures an environment", () => {
    const defaultResult = buildClaudeInstanceProcessEnv(undefined, undefined, {
      homeDir: "/home/server",
      isolationRootDir: "/synara/state",
      providerInstanceId: "claudeAgent",
    });
    const configuredResult = buildClaudeInstanceProcessEnv(
      undefined,
      { ANTHROPIC_AUTH_TOKEN: "default-instance-token" },
      {
        homeDir: "/home/server",
        isolationRootDir: "/synara/state",
        providerInstanceId: "claudeAgent",
      },
    );

    assert.equal(defaultResult.HOME, "/home/server");
    assert.equal(
      configuredResult.HOME,
      claudeIsolatedHomePath({
        isolationRootDir: "/synara/state",
        providerInstanceId: "claudeAgent",
      }),
    );
  });

  it("uses explicitly configured HOME and Windows profile paths as the account boundary", () => {
    const result = buildClaudeInstanceProcessEnv(
      undefined,
      {
        HOME: "C:\\Accounts\\work",
        USERPROFILE: "D:\\Profiles\\work",
        APPDATA: "E:\\Claude\\Roaming",
      },
      {
        homeDir: "C:\\Users\\server",
        isolationRootDir: "C:\\Synara\\userdata",
        providerInstanceId: "claude_work",
        platform: "win32",
      },
    );

    assert.equal(result.HOME, "C:\\Accounts\\work");
    assert.equal(result.USERPROFILE, "D:\\Profiles\\work");
    assert.equal(result.APPDATA, "E:\\Claude\\Roaming");
    assert.equal(result.LOCALAPPDATA, "C:\\Accounts\\work\\AppData\\Local");
  });

  it("overlays the provider instance home", () => {
    const result = buildClaudeInstanceProcessEnv("/home/work-account");

    assert.equal(result.HOME, "/home/work-account");
  });

  it("does not fall back to ambient auth when an explicit instance home lacks OAuth", () => {
    const accountEnvironment = Object.fromEntries(
      CLAUDE_ACCOUNT_ISOLATION_ENV_KEYS.map((key) => [key, `account-a-${key}`]),
    );
    const inherited = {
      ...accountEnvironment,
      ...dynamicAccountEnvironment,
      CLAUDE_CONFIG_DIR: "/home/account-a/.claude",
      HTTPS_PROXY: "https://shared-network-proxy.example.test",
      NODE_EXTRA_CA_CERTS: "/shared/network-ca.pem",
    } satisfies NodeJS.ProcessEnv;
    withAmbientEnvironment(inherited, () => {
      const result = buildClaudeInstanceProcessEnv("/home/account-b");

      assert.equal(result.HOME, "/home/account-b");
      assert.equal(result.CLAUDE_CONFIG_DIR, undefined);
      for (const key of CLAUDE_ACCOUNT_ISOLATION_ENV_KEYS) {
        assert.equal(result[key], undefined);
        assert.notEqual(inherited[key], undefined);
      }
      for (const key of Object.keys(dynamicAccountEnvironment)) {
        assert.equal(result[key], undefined);
      }
      assert.equal(result.HTTPS_PROXY, "https://shared-network-proxy.example.test");
      assert.equal(result.NODE_EXTRA_CA_CERTS, "/shared/network-ca.pem");
    });
  });

  it("preserves auth and backend routing explicitly configured by the selected instance", () => {
    const instanceEnvironment = Object.fromEntries(
      CLAUDE_ACCOUNT_ISOLATION_ENV_KEYS.map((key) => [key, `account-b-${key}`]),
    );
    Object.assign(instanceEnvironment, dynamicAccountEnvironment);
    const result = buildClaudeInstanceProcessEnv("/home/account-b", instanceEnvironment);

    assert.equal(result.HOME, "/home/account-b");
    for (const key of CLAUDE_ACCOUNT_ISOLATION_ENV_KEYS) {
      assert.equal(result[key], `account-b-${key}`);
    }
    for (const [key, value] of Object.entries(dynamicAccountEnvironment)) {
      assert.equal(result[key], value);
    }
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
