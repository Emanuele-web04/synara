// FILE: providerUsage/providers/claude.test.ts
// Purpose: Covers Claude's CLI-delegated token lifecycle — expired/rejected credentials trigger
// a `claude auth status` nudge (never a direct OAuth token call, which would burn the CLI's
// single-use rotating refresh token) — plus source fallthrough and rate-limit resilience.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import nodePath from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { outboundHttp } from "@synara/shared/outboundHttp";
import {
  __resetClaudeUsageRateLimitState,
  __setClaudeAuthNudgeDepsForTests,
  claudeUsageFetcher,
} from "./claude";

const { readKeychainPasswordMock, managedFragments } = vi.hoisted(() => ({
  readKeychainPasswordMock: vi.fn(),
  managedFragments: { present: false },
}));

// Managed policy paths are synthetic/absent in these fixture-only tests.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    stat: (path: string) => {
      if (managedFragments.present && path === "/etc/claude-code/managed-settings.d") {
        return Promise.resolve({ isDirectory: () => true, isFile: () => false });
      }
      if (
        path.startsWith("/etc/claude-code/") ||
        path.startsWith("/Library/Application Support/ClaudeCode/")
      ) {
        return Promise.reject(
          Object.assign(new Error("Synthetic policy is absent"), { code: "ENOENT" }),
        );
      }
      return actual.stat(path);
    },
  };
});

vi.mock("../credentials", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../credentials")>()),
  readKeychainPassword: readKeychainPasswordMock,
}));

const NOW_MS = 1_780_000_000_000;

const tempDirs: string[] = [];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function rateLimitedResponse(retryAfterSeconds?: number): Response {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (retryAfterSeconds !== undefined) {
    headers["Retry-After"] = String(retryAfterSeconds);
  }
  return new Response(JSON.stringify({ error: "rate_limited" }), { status: 429, headers });
}

function stubOutboundFetch(
  fetchMock: (url: string | URL | Request, init?: RequestInit) => Promise<Response>,
): void {
  vi.spyOn(outboundHttp, "request").mockImplementation(async (input) => {
    const response = await fetchMock(input.url, {
      ...(input.method === undefined ? {} : { method: input.method }),
      headers: input.headers,
      ...(input.body === undefined ? {} : { body: input.body }),
    });
    return {
      status: response.status,
      headers: response.headers,
      body: new Uint8Array(await response.arrayBuffer()),
      url: String(input.url),
    };
  });
}

function makeClaudeHome(creds: Record<string, unknown>) {
  const homeDir = mkdtempSync(nodePath.join(os.tmpdir(), "synara-claude-usage-"));
  tempDirs.push(homeDir);
  const claudeDir = nodePath.join(homeDir, ".claude");
  mkdirSync(claudeDir, { recursive: true });
  const credentialsPath = nodePath.join(claudeDir, ".credentials.json");
  writeFileSync(credentialsPath, JSON.stringify({ claudeAiOauth: creds }), "utf8");
  return { homeDir, credentialsPath };
}

function makeClaudeConfigDir(creds: Record<string, unknown>) {
  const configDir = mkdtempSync(nodePath.join(os.tmpdir(), "synara-claude-config-"));
  tempDirs.push(configDir);
  const credentialsPath = nodePath.join(configDir, ".credentials.json");
  writeFileSync(credentialsPath, JSON.stringify({ claudeAiOauth: creds }), "utf8");
  return { configDir, credentialsPath };
}

function writeClaudeCreds(credentialsPath: string, creds: Record<string, unknown>): void {
  writeFileSync(credentialsPath, JSON.stringify({ claudeAiOauth: creds }), "utf8");
}

/** Install a nudge stub so no test can ever exec a real `claude` binary or take the shared
 * process-wide auth-status lock. */
function stubAuthNudge(
  runAuthStatus: (input: {
    binaryPath: string;
    homeDir: string;
    env: NodeJS.ProcessEnv;
  }) => Promise<void> = async () => {},
) {
  const runMock = vi.fn(runAuthStatus);
  __setClaudeAuthNudgeDepsForTests({
    acquireLock: async () => () => {},
    runAuthStatus: runMock,
  });
  return runMock;
}

beforeEach(() => {
  __resetClaudeUsageRateLimitState();
  managedFragments.present = false;
  readKeychainPasswordMock.mockReset();
  readKeychainPasswordMock.mockResolvedValue(null);
  stubAuthNudge();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  __resetClaudeUsageRateLimitState();
  __setClaudeAuthNudgeDepsForTests(null);
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("claudeUsageFetcher", () => {
  it("does not show stored-account usage for an account using an environment token", async () => {
    const { homeDir } = makeClaudeHome({
      accessToken: "different-account-token",
      expiresAt: NOW_MS + 60 * 60 * 1000,
    });
    const fetchMock = vi.fn(async () => jsonResponse({ five_hour: { utilization: 80 } }));
    stubOutboundFetch(fetchMock);
    const context = {
      homeDir,
      env: { CLAUDE_CODE_OAUTH_TOKEN: "setup-token" },
      platform: "linux" as const,
      nowMs: NOW_MS,
    };
    const snapshot = await claudeUsageFetcher.fetch(context);
    expect(snapshot.status).toBe("unsupported");
    expect(snapshot.detail).toContain("environment-token");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(readKeychainPasswordMock).not.toHaveBeenCalled();
    expect(await claudeUsageFetcher.cacheKey!(context)).not.toBe(
      await claudeUsageFetcher.cacheKey!({ ...context, env: {} }),
    );
  });

  it("explains why inference-only credentials cannot report usage", async () => {
    const { homeDir } = makeClaudeHome({
      accessToken: "inference-token",
      scopes: ["user:inference"],
      expiresAt: NOW_MS + 60 * 60 * 1000,
    });
    const fetchMock = vi.fn();
    stubOutboundFetch(fetchMock);
    const snapshot = await claudeUsageFetcher.fetch({
      homeDir,
      env: {},
      platform: "linux",
      nowMs: NOW_MS,
    });
    expect(snapshot.status).toBe("unsupported");
    expect(snapshot.detail).toContain("user:profile");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("honors an inherited secure-storage directory before default file credentials", async () => {
    const { homeDir } = makeClaudeHome({
      accessToken: "personal-token",
      expiresAt: NOW_MS + 60 * 60 * 1000,
    });
    const { configDir: secureStorageDir } = makeClaudeConfigDir({
      accessToken: "secure-token",
      expiresAt: NOW_MS + 60 * 60 * 1000,
    });
    stubOutboundFetch(async (_url, init) =>
      jsonResponse({
        five_hour: {
          utilization:
            new Headers(init?.headers).get("Authorization") === "Bearer secure-token" ? 31 : 9,
        },
      }),
    );
    const snapshot = await claudeUsageFetcher.fetch({
      homeDir,
      env: { CLAUDE_SECURESTORAGE_CONFIG_DIR: secureStorageDir },
      platform: "linux",
      nowMs: NOW_MS,
    });
    expect(snapshot.limits).toMatchObject([{ usedPercent: 31 }]);
  });

  it("reads the selected macOS account's hashed Keychain service", async () => {
    const homeDir = mkdtempSync(nodePath.join(os.tmpdir(), "synara-claude-keychain-"));
    tempDirs.push(homeDir);
    readKeychainPasswordMock.mockImplementation(async (input) =>
      input.service === "Claude Code-credentials-c3c34646"
        ? JSON.stringify({
            claudeAiOauth: {
              accessToken: "work-token",
              expiresAt: NOW_MS + 60 * 60 * 1000,
            },
          })
        : null,
    );
    const fetchMock = vi.fn(async (_url, init) => {
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer work-token");
      return jsonResponse({ five_hour: { utilization: 31 } });
    });
    stubOutboundFetch(fetchMock);

    const snapshot = await claudeUsageFetcher.fetch({
      homeDir,
      env: { CLAUDE_CONFIG_DIR: "/accounts/claude-work", USER: "current-user" },
      platform: "darwin",
      nowMs: NOW_MS,
      isolateCredentials: true,
    });
    expect(snapshot.status).toBe("ok");
    expect(snapshot.limits).toMatchObject([{ usedPercent: 31 }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not replace a rejected selected credential with the default account", async () => {
    const { homeDir } = makeClaudeHome({
      accessToken: "personal-token",
      expiresAt: NOW_MS + 60 * 60 * 1000,
    });
    const { configDir } = makeClaudeConfigDir({
      accessToken: "work-token",
      expiresAt: NOW_MS + 60 * 60 * 1000,
    });
    stubAuthNudge();
    stubOutboundFetch(async (_url, init) =>
      new Headers(init?.headers).get("Authorization") === "Bearer work-token"
        ? jsonResponse({}, 401)
        : jsonResponse({ five_hour: { utilization: 9 } }),
    );

    const snapshot = await claudeUsageFetcher.fetch({
      homeDir,
      env: { CLAUDE_CONFIG_DIR: configDir },
      platform: "linux",
      nowMs: NOW_MS,
      isolateCredentials: true,
    });
    expect(snapshot.status).toBe("needs-auth");
  });

  it("prefers the current macOS account before the service-only keychain fallback", async () => {
    const homeDir = mkdtempSync(nodePath.join(os.tmpdir(), "synara-claude-keychain-"));
    tempDirs.push(homeDir);
    readKeychainPasswordMock.mockResolvedValueOnce(null).mockResolvedValueOnce(
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "keychain-access-token",
          expiresAt: NOW_MS + 60 * 60 * 1000,
          scopes: ["user:profile"],
        },
      }),
    );
    stubOutboundFetch(async (_url, init) => {
      expect((init?.headers as Record<string, string>).Authorization).toBe(
        "Bearer keychain-access-token",
      );
      return jsonResponse({ five_hour: { utilization: 7 } });
    });

    const snapshot = await claudeUsageFetcher.fetch({
      homeDir,
      env: { USER: "current-user" },
      platform: "darwin",
      nowMs: NOW_MS,
    });

    expect(snapshot.status).toBe("ok");
    expect(readKeychainPasswordMock).toHaveBeenNthCalledWith(1, {
      service: "Claude Code-credentials",
      account: "current-user",
      platform: "darwin",
    });
    expect(readKeychainPasswordMock).toHaveBeenNthCalledWith(2, {
      service: "Claude Code-credentials",
      platform: "darwin",
    });
  });

  it("delegates an expired credential to the Claude CLI and never calls the OAuth token endpoint", async () => {
    const { homeDir, credentialsPath } = makeClaudeHome({
      accessToken: "expired-access-token",
      refreshToken: "old-refresh-token",
      expiresAt: NOW_MS - 60_000,
      scopes: ["user:profile"],
      subscriptionType: "pro",
    });

    // The CLI refreshes and persists its own rotated credential when nudged.
    const runMock = stubAuthNudge(async () => {
      writeClaudeCreds(credentialsPath, {
        accessToken: "fresh-access-token",
        refreshToken: "rotated-refresh-token",
        expiresAt: NOW_MS + 8 * 60 * 60 * 1000,
        scopes: ["user:profile"],
        subscriptionType: "pro",
      });
    });

    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes("/oauth/token")) {
        throw new Error("must never call the OAuth token endpoint for Claude");
      }
      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer fresh-access-token");
      return jsonResponse({
        five_hour: { utilization: 12, resets_at: "2026-06-09T12:00:00Z" },
      });
    });
    stubOutboundFetch(fetchMock);

    const snapshot = await claudeUsageFetcher.fetch({
      homeDir,
      env: {},
      platform: "linux",
      nowMs: NOW_MS,
      claudeBinaryPath: "/custom/bin/claude",
    });

    expect(snapshot.status).toBe("ok");
    expect(snapshot.limits.find((limit) => limit.window === "5h")?.usedPercent).toBe(12);
    expect(snapshot.planName).toBe("Pro");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(runMock).toHaveBeenCalledTimes(1);
    expect(runMock).toHaveBeenCalledWith(
      expect.objectContaining({ binaryPath: "/custom/bin/claude", homeDir }),
    );
  });

  it("nudges the CLI and retries once when the usage endpoint rejects a stale token", async () => {
    const { homeDir, credentialsPath } = makeClaudeHome({
      accessToken: "stale-access-token",
      refreshToken: "refresh-after-401",
      expiresAt: NOW_MS + 60 * 60 * 1000,
      scopes: ["user:profile"],
    });

    const runMock = stubAuthNudge(async () => {
      writeClaudeCreds(credentialsPath, {
        accessToken: "retried-access-token",
        refreshToken: "rotated-refresh-token",
        expiresAt: NOW_MS + 8 * 60 * 60 * 1000,
        scopes: ["user:profile"],
      });
    });

    let usageCalls = 0;
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes("/oauth/token")) {
        throw new Error("must never call the OAuth token endpoint for Claude");
      }
      usageCalls += 1;
      if (usageCalls === 1) {
        return jsonResponse({ error: "invalid_token" }, 401);
      }
      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer retried-access-token");
      return jsonResponse({
        seven_day: { utilization: 45, resets_at: "2026-06-15T12:00:00Z" },
      });
    });
    stubOutboundFetch(fetchMock);

    const snapshot = await claudeUsageFetcher.fetch({
      homeDir,
      env: {},
      platform: "linux",
      nowMs: NOW_MS,
    });

    expect(snapshot.status).toBe("ok");
    expect(snapshot.limits.find((limit) => limit.window === "Weekly")?.usedPercent).toBe(45);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(runMock).toHaveBeenCalledTimes(1);
  });

  it("returns needs-auth without hitting the API when the CLI cannot refresh an expired credential", async () => {
    const { homeDir } = makeClaudeHome({
      accessToken: "expired-access-token",
      refreshToken: "dead-refresh-token",
      expiresAt: NOW_MS - 60_000,
      scopes: ["user:profile"],
    });

    const runMock = stubAuthNudge(async () => {
      throw new Error("Not logged in");
    });
    const fetchMock = vi.fn(async () => jsonResponse({}));
    stubOutboundFetch(fetchMock);

    const ctx = { homeDir, env: {}, platform: "linux" as const, nowMs: NOW_MS };
    const snapshot = await claudeUsageFetcher.fetch(ctx);
    expect(snapshot.status).toBe("needs-auth");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(runMock).toHaveBeenCalledTimes(1);

    // Within the nudge cooldown, further polls do not re-spawn the CLI.
    const again = await claudeUsageFetcher.fetch({ ...ctx, nowMs: NOW_MS + 30_000 });
    expect(again.status).toBe("needs-auth");
    expect(runMock).toHaveBeenCalledTimes(1);
  });

  it("falls through to the next credential source when the first token is rejected", async () => {
    const { configDir } = makeClaudeConfigDir({
      accessToken: "shadowing-stale-access-token",
      expiresAt: NOW_MS + 60 * 60 * 1000,
      scopes: ["user:profile"],
      subscriptionType: "pro",
    });
    const { homeDir } = makeClaudeHome({
      accessToken: "valid-home-access-token",
      expiresAt: NOW_MS + 60 * 60 * 1000,
      scopes: ["user:profile"],
      subscriptionType: "max",
      rateLimitTier: "claude_max_subscription_5x",
    });

    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      if (headers.Authorization === "Bearer shadowing-stale-access-token") {
        return jsonResponse({ error: "invalid_token" }, 401);
      }
      expect(headers.Authorization).toBe("Bearer valid-home-access-token");
      return jsonResponse({
        five_hour: { utilization: 56, resets_at: "2026-06-09T12:00:00Z" },
      });
    });
    stubOutboundFetch(fetchMock);

    const snapshot = await claudeUsageFetcher.fetch({
      homeDir,
      env: { CLAUDE_CONFIG_DIR: configDir },
      platform: "linux",
      nowMs: NOW_MS,
    });

    expect(snapshot.status).toBe("ok");
    expect(snapshot.planName).toBe("Max (5x)");
    expect(snapshot.limits.find((limit) => limit.window === "5h")?.usedPercent).toBe(56);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps serving the last good usage when Anthropic rate-limits the usage endpoint", async () => {
    const { homeDir } = makeClaudeHome({
      accessToken: "rate-limit-access-token",
      expiresAt: NOW_MS + 60 * 60 * 1000,
      scopes: ["user:profile"],
      subscriptionType: "pro",
    });

    let throttle = false;
    const fetchMock = vi.fn(async () =>
      throttle
        ? rateLimitedResponse(120)
        : jsonResponse({ five_hour: { utilization: 33, resets_at: "2026-06-09T12:00:00Z" } }),
    );
    stubOutboundFetch(fetchMock);

    const ctx = { homeDir, env: {}, platform: "linux" as const, nowMs: NOW_MS };

    const first = await claudeUsageFetcher.fetch(ctx);
    expect(first.status).toBe("ok");
    expect(first.limits.find((limit) => limit.window === "5h")?.usedPercent).toBe(33);

    // Next poll is throttled: keep the last values, mark them stale, and honor Retry-After (~2m).
    throttle = true;
    const throttled = await claudeUsageFetcher.fetch(ctx);
    expect(throttled.status).toBe("ok");
    expect(throttled.limits.find((limit) => limit.window === "5h")?.usedPercent).toBe(33);
    expect(throttled.detail).toContain("rate-limiting");
    expect(throttled.detail).toContain("~2m");
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // While the cooldown is active, subsequent polls serve the cache without re-hitting Anthropic.
    const cached = await claudeUsageFetcher.fetch({ ...ctx, nowMs: NOW_MS + 30_000 });
    expect(cached.status).toBe("ok");
    expect(cached.limits.find((limit) => limit.window === "5h")?.usedPercent).toBe(33);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not serve cached cooldown usage after Claude credentials switch", async () => {
    const { homeDir, credentialsPath } = makeClaudeHome({
      accessToken: "first-rate-limit-access-token",
      expiresAt: NOW_MS + 60 * 60 * 1000,
      scopes: ["user:profile"],
      subscriptionType: "pro",
    });

    let throttle = false;
    const authorizations: string[] = [];
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const authorization = (init?.headers as Record<string, string> | undefined)?.Authorization;
      if (authorization === undefined) {
        throw new Error("Claude usage request did not include an Authorization header");
      }
      authorizations.push(authorization);
      return throttle
        ? rateLimitedResponse(120)
        : jsonResponse({ five_hour: { utilization: 33, resets_at: "2026-06-09T12:00:00Z" } });
    });
    stubOutboundFetch(fetchMock);

    const ctx = { homeDir, env: {}, platform: "linux" as const, nowMs: NOW_MS };

    const first = await claudeUsageFetcher.fetch(ctx);
    expect(first.status).toBe("ok");
    expect(first.limits.find((limit) => limit.window === "5h")?.usedPercent).toBe(33);

    throttle = true;
    const throttled = await claudeUsageFetcher.fetch(ctx);
    expect(throttled.status).toBe("ok");
    expect(throttled.limits.find((limit) => limit.window === "5h")?.usedPercent).toBe(33);

    writeClaudeCreds(credentialsPath, {
      accessToken: "second-rate-limit-access-token",
      expiresAt: NOW_MS + 60 * 60 * 1000,
      scopes: ["user:profile"],
      subscriptionType: "pro",
    });

    const afterSwitch = await claudeUsageFetcher.fetch({ ...ctx, nowMs: NOW_MS + 30_000 });
    expect(afterSwitch.status).toBe("error");
    expect(afterSwitch.limits).toHaveLength(0);
    expect(afterSwitch.detail).toContain("rate-limiting");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(authorizations).toEqual([
      "Bearer first-rate-limit-access-token",
      "Bearer first-rate-limit-access-token",
      "Bearer second-rate-limit-access-token",
    ]);
  });

  it("surfaces a rate-limit error when throttled before any successful fetch", async () => {
    const { homeDir } = makeClaudeHome({
      accessToken: "cold-rate-limit-token",
      expiresAt: NOW_MS + 60 * 60 * 1000,
      scopes: ["user:profile"],
    });

    const fetchMock = vi.fn(async () => rateLimitedResponse());
    stubOutboundFetch(fetchMock);

    const ctx = { homeDir, env: {}, platform: "linux" as const, nowMs: NOW_MS };
    const snapshot = await claudeUsageFetcher.fetch(ctx);

    expect(snapshot.status).toBe("error");
    expect(snapshot.detail).toContain("rate-limiting");
    expect(snapshot.limits).toHaveLength(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Even with no cached usage to show, the cooldown must stop us from hammering the throttled
    // endpoint on every poll.
    const duringCooldown = await claudeUsageFetcher.fetch({ ...ctx, nowMs: NOW_MS + 30_000 });
    expect(duringCooldown.status).toBe("error");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("claudeUsageFetcher durable recovery identity", () => {
  const ACCOUNT_A = "11111111-1111-4111-8111-111111111111";
  const ACCOUNT_B = "22222222-2222-4222-8222-222222222222";
  const ORG_A = "33333333-3333-4333-8333-333333333333";
  const ORG_B = "44444444-4444-4444-8444-444444444444";
  const profile = (accountUuid = ACCOUNT_A, organizationUuid = ORG_A) => ({
    oauthAccount: { accountUuid, organizationUuid },
  });
  function fixture() {
    const native = makeClaudeHome({ accessToken: "access-before", refreshToken: "refresh-before" });
    const workingDirectory = nodePath.join(native.homeDir, "workspace");
    mkdirSync(nodePath.join(workingDirectory, ".git"), { recursive: true });
    const profilePath = nodePath.join(native.homeDir, ".claude.json");
    writeFileSync(profilePath, JSON.stringify(profile()), "utf8");
    return {
      ...native,
      profilePath,
      context: {
        homeDir: native.homeDir,
        workingDirectory,
        env: {},
        platform: "linux" as const,
        nowMs: NOW_MS,
      },
    };
  }

  it("keeps native account+organization identity stable through token rotation and detects both switches", async () => {
    const { profilePath, credentialsPath, context } = fixture();
    const first = await claudeUsageFetcher.recoveryIdentity!(context);
    expect(first).not.toBeNull();
    writeFileSync(
      credentialsPath,
      JSON.stringify({
        claudeAiOauth: { accessToken: "access-after", refreshToken: "refresh-after" },
      }),
      "utf8",
    );
    expect(await claudeUsageFetcher.recoveryIdentity!(context)).toBe(first);
    writeFileSync(profilePath, JSON.stringify(profile(ACCOUNT_B, ORG_A)), "utf8");
    const changedAccount = await claudeUsageFetcher.recoveryIdentity!(context);
    expect(changedAccount).not.toBe(first);
    writeFileSync(profilePath, JSON.stringify(profile(ACCOUNT_B, ORG_B)), "utf8");
    expect(await claudeUsageFetcher.recoveryIdentity!(context)).not.toBe(changedAccount);
  });

  it("reads only the selected native configuration and honors legacy profile precedence", async () => {
    const { context } = fixture();
    const { configDir } = makeClaudeConfigDir({ accessToken: "selected-access" });
    writeFileSync(
      nodePath.join(configDir, ".claude.json"),
      JSON.stringify(profile(ACCOUNT_B, ORG_B)),
      "utf8",
    );
    const selected = {
      ...context,
      isolateCredentials: true,
      env: { CLAUDE_CONFIG_DIR: configDir, CLAUDE_SECURESTORAGE_CONFIG_DIR: configDir },
    };
    expect(await claudeUsageFetcher.recoveryIdentity!(selected)).toBe(
      JSON.stringify([ACCOUNT_B, ORG_B]),
    );
    writeFileSync(nodePath.join(configDir, ".config.json"), JSON.stringify(profile()), "utf8");
    expect(await claudeUsageFetcher.recoveryIdentity!(selected)).toBe(
      JSON.stringify([ACCOUNT_A, ORG_A]),
    );
    writeFileSync(nodePath.join(configDir, ".config.json"), "malformed legacy profile", "utf8");
    expect(await claudeUsageFetcher.recoveryIdentity!(selected)).toBeNull();
  });

  it("checks the authoritative main checkout local settings for a linked worktree", async () => {
    const { context } = fixture();
    const linked = nodePath.join(context.homeDir, "linked-worktree");
    mkdirSync(linked);
    writeFileSync(
      nodePath.join(linked, ".git"),
      "gitdir: /synthetic/untrusted-never-read\n",
      "utf8",
    );
    expect(
      await claudeUsageFetcher.recoveryIdentity!({ ...context, workingDirectory: linked }),
    ).toBeNull();
    const selected = {
      ...context,
      workingDirectory: linked,
      projectRoot: context.workingDirectory,
    };
    expect(await claudeUsageFetcher.recoveryIdentity!(selected)).not.toBeNull();
    const sharedSettings = nodePath.join(context.workingDirectory, ".claude");
    mkdirSync(sharedSettings);
    writeFileSync(
      nodePath.join(sharedSettings, "settings.local.json"),
      JSON.stringify({ apiKeyHelper: "main-checkout-helper" }),
      "utf8",
    );
    expect(await claudeUsageFetcher.recoveryIdentity!(selected)).toBeNull();
  });

  it.each([
    "CLAUDE_CODE_OAUTH_TOKEN",
    "ANTHROPIC_API_KEY",
    "CLAUDE_CODE_CUSTOM_OAUTH_URL",
    "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
    "ANTHROPIC_PROFILE",
  ])("does not adopt a stored native login while %s selects another auth mode", async (name) => {
    const { context } = fixture();
    expect(
      await claudeUsageFetcher.recoveryIdentity!({
        ...context,
        env: { [name]: "synthetic-override" },
      }),
    ).toBeNull();
  });

  it.each([
    "global helper",
    "project helper",
    "project environment",
    "implicit profile",
    "managed fragments",
  ])("%s keeps authentication mode manual", async (mode) => {
    const { context } = fixture();
    if (mode === "managed fragments") managedFragments.present = true;
    const configHome = nodePath.join(context.homeDir, ".claude");
    const projectConfig = nodePath.join(context.workingDirectory, ".claude");
    mkdirSync(projectConfig);
    if (mode === "global helper")
      writeFileSync(
        nodePath.join(configHome, "settings.json"),
        JSON.stringify({ apiKeyHelper: "synthetic-helper" }),
        "utf8",
      );
    if (mode === "project helper")
      writeFileSync(
        nodePath.join(projectConfig, "settings.local.json"),
        JSON.stringify({ apiKeyHelper: "synthetic-helper" }),
        "utf8",
      );
    if (mode === "project environment")
      writeFileSync(
        nodePath.join(projectConfig, "settings.json"),
        JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: "synthetic-other-account" } }),
        "utf8",
      );
    if (mode === "implicit profile")
      mkdirSync(nodePath.join(context.homeDir, ".config", "anthropic"), { recursive: true });
    expect(await claudeUsageFetcher.recoveryIdentity!(context)).toBeNull();
  });

  it("requires native credentials, both UUIDs and a known absolute workspace/configuration", async () => {
    const { profilePath, credentialsPath, context } = fixture();
    const { workingDirectory: _workingDirectory, ...unknownWorkspace } = context;
    expect(await claudeUsageFetcher.recoveryIdentity!(unknownWorkspace)).toBeNull();
    expect(
      await claudeUsageFetcher.recoveryIdentity!({
        ...context,
        env: { CLAUDE_CONFIG_DIR: "relative-config" },
      }),
    ).toBeNull();
    expect(
      await claudeUsageFetcher.recoveryIdentity!({ ...context, env: { CLAUDE_CONFIG_DIR: "" } }),
    ).toBeNull();
    writeFileSync(
      profilePath,
      JSON.stringify({ oauthAccount: { accountUuid: ACCOUNT_A } }),
      "utf8",
    );
    expect(await claudeUsageFetcher.recoveryIdentity!(context)).toBeNull();
    writeFileSync(profilePath, JSON.stringify(profile()), "utf8");
    rmSync(credentialsPath);
    expect(await claudeUsageFetcher.recoveryIdentity!(context)).toBeNull();
  });
});
