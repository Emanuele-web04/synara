// FILE: providerUsage/providers/claude.test.ts
// Purpose: Covers Claude's OAuth refresh path so expired Claude Code credentials still
// produce usage snapshots after the provider refreshes the access token.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import nodePath from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { claudeUsageFetcher } from "./claude";

const NOW_MS = 1_780_000_000_000;

const tempDirs: string[] = [];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
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

function readSavedOauth(credentialsPath: string) {
  return JSON.parse(readFileSync(credentialsPath, "utf8")) as {
    claudeAiOauth: Record<string, unknown>;
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("claudeUsageFetcher", () => {
  it("refreshes expired file credentials in memory before fetching live usage", async () => {
    const originalExpiresAt = NOW_MS - 60_000;
    const { homeDir, credentialsPath } = makeClaudeHome({
      accessToken: "expired-access-token",
      refreshToken: "old-refresh-token",
      expiresAt: originalExpiresAt,
      scopes: ["user:profile"],
      subscriptionType: "pro",
    });

    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url);
      if (target.includes("/oauth/token")) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        expect(body.refresh_token).toBe("old-refresh-token");
        return jsonResponse({
          access_token: "fresh-access-token",
          refresh_token: "new-refresh-token",
          expires_in: 3600,
        });
      }

      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer fresh-access-token");
      return jsonResponse({
        five_hour: { utilization: 12, resets_at: "2026-06-09T12:00:00Z" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const snapshot = await claudeUsageFetcher.fetch({
      homeDir,
      env: {},
      platform: "linux",
      nowMs: NOW_MS,
    });

    expect(snapshot.status).toBe("ok");
    expect(snapshot.limits.find((limit) => limit.window === "5h")?.usedPercent).toBe(12);
    expect(snapshot.planName).toBe("Pro");
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const saved = readSavedOauth(credentialsPath);
    expect(saved.claudeAiOauth.accessToken).toBe("expired-access-token");
    expect(saved.claudeAiOauth.refreshToken).toBe("old-refresh-token");
    expect(saved.claudeAiOauth.expiresAt).toBe(originalExpiresAt);
  });

  it("refreshes and retries when the usage endpoint rejects a stale token", async () => {
    const { homeDir } = makeClaudeHome({
      accessToken: "stale-access-token",
      refreshToken: "refresh-after-401",
      expiresAt: NOW_MS + 60 * 60 * 1000,
      scopes: ["user:profile"],
    });

    let usageCalls = 0;
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url);
      if (target.includes("/oauth/token")) {
        return jsonResponse({ access_token: "retried-access-token", expires_in: 3600 });
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
    vi.stubGlobal("fetch", fetchMock);

    const snapshot = await claudeUsageFetcher.fetch({
      homeDir,
      env: {},
      platform: "linux",
      nowMs: NOW_MS,
    });

    expect(snapshot.status).toBe("ok");
    expect(snapshot.limits.find((limit) => limit.window === "Weekly")?.usedPercent).toBe(45);
    expect(fetchMock).toHaveBeenCalledTimes(3);
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
    vi.stubGlobal("fetch", fetchMock);

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
});
