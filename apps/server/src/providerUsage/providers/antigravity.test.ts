// FILE: providerUsage/providers/antigravity.test.ts
// Purpose: Covers Antigravity/agy OAuth files, Google refresh write-back, and Cloud Code quota
// (summary pools first, legacy per-model buckets as fallback).

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import nodePath from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { outboundHttp } from "@synara/shared/outboundHttp";

import {
  antigravityUsageFetcher,
  parseAntigravityQuota,
  parseAntigravityQuotaSummary,
} from "./antigravity";

const NOW_MS = 1_780_000_000_000;
const ANTIGRAVITY_CLIENT_ID_PREFIX = "1071006060591-";
const GEMINI_CLI_CLIENT_ID_PREFIX = "681255809395-";

// Shape returned by cloudcode-pa retrieveUserQuotaSummary for an Antigravity account.
const QUOTA_SUMMARY = {
  groups: [
    {
      displayName: "Gemini Models",
      buckets: [
        {
          bucketId: "gemini-weekly",
          window: "weekly",
          resetTime: "2026-06-04T12:00:00Z",
          remainingFraction: 0.6,
        },
        {
          bucketId: "gemini-5h",
          window: "5h",
          resetTime: "2026-05-28T17:00:00Z",
          remainingFraction: 0.25,
        },
      ],
    },
    {
      displayName: "Claude and GPT models",
      buckets: [
        {
          bucketId: "3p-weekly",
          window: "weekly",
          resetTime: "2026-06-04T12:00:00Z",
          remainingFraction: 1,
        },
        {
          bucketId: "3p-5h",
          window: "5h",
          resetTime: "2026-05-28T17:00:00Z",
          remainingFraction: 0.9,
        },
      ],
    },
  ],
};

function isQuotaSummaryUrl(target: string): boolean {
  return target.includes("retrieveUserQuotaSummary");
}

function isLegacyQuotaUrl(target: string): boolean {
  return target.includes("retrieveUserQuota") && !isQuotaSummaryUrl(target);
}
const tempDirs: string[] = [];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
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

function makeGeminiHome(relativePath: string, creds: Record<string, unknown>) {
  const homeDir = mkdtempSync(nodePath.join(os.tmpdir(), "synara-agy-usage-"));
  tempDirs.push(homeDir);
  const credPath = nodePath.join(homeDir, ...relativePath.split("/"));
  mkdirSync(nodePath.dirname(credPath), { recursive: true });
  writeFileSync(credPath, JSON.stringify(creds), "utf8");
  return { homeDir, credPath };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("parseAntigravityQuota", () => {
  it("collapses model buckets into Pro/Flash and prefers paidTier.name", () => {
    const snapshot = parseAntigravityQuota({
      loadAssist: {
        paidTier: { name: "Google AI Pro" },
        currentTier: { id: "free-tier" },
        cloudaicompanionProject: "gen-lang-client-1",
      },
      quota: {
        buckets: [
          {
            modelId: "gemini-2.5-pro",
            remainingFraction: 0.4,
            resetTime: "2026-09-01T00:00:00Z",
          },
          {
            modelId: "gemini-2.5-pro-preview",
            remainingFraction: 0.1,
            resetTime: "2026-09-01T00:00:00Z",
          },
          {
            modelId: "gemini-2.5-flash",
            remainingFraction: 0.8,
            resetTime: "2026-08-20T12:00:00Z",
          },
        ],
      },
      nowMs: NOW_MS,
    });
    expect(snapshot.planName).toBe("Google AI Pro");
    expect(snapshot.limits.map((limit) => limit.window)).toEqual(["Pro", "Flash"]);
    expect(snapshot.limits[0]?.usedPercent).toBe(90);
    expect(snapshot.limits[1]?.usedPercent).toBe(20);
  });
});

describe("parseAntigravityQuotaSummary", () => {
  it("maps the Gemini and third-party pools to 5h and weekly windows", () => {
    expect(parseAntigravityQuotaSummary(QUOTA_SUMMARY)).toEqual([
      {
        window: "5h",
        usedPercent: 75,
        resetsAt: "2026-05-28T17:00:00.000Z",
        windowDurationMins: 300,
      },
      {
        window: "Weekly",
        usedPercent: 40,
        resetsAt: "2026-06-04T12:00:00.000Z",
        windowDurationMins: 10_080,
      },
      {
        window: "Claude 5h",
        usedPercent: 10,
        resetsAt: "2026-05-28T17:00:00.000Z",
        windowDurationMins: 300,
      },
      {
        window: "Claude Weekly",
        usedPercent: 0,
        resetsAt: "2026-06-04T12:00:00.000Z",
        windowDurationMins: 10_080,
      },
    ]);
  });

  it("ignores unknown buckets and never invents a missing fraction", () => {
    expect(
      parseAntigravityQuotaSummary({
        groups: [
          {
            buckets: [
              { bucketId: "gemini-image-5h", remainingFraction: 0 },
              { bucketId: "gemini-5h", resetTime: "2026-05-28T17:00:00Z" },
              { bucketId: "3p-weekly" },
              "not-a-bucket",
            ],
          },
        ],
      }),
    ).toEqual([{ window: "5h", resetsAt: "2026-05-28T17:00:00.000Z", windowDurationMins: 300 }]);
  });

  it("returns undefined for a body without groups", () => {
    expect(parseAntigravityQuotaSummary({ buckets: [] })).toBeUndefined();
    expect(parseAntigravityQuotaSummary(null)).toBeUndefined();
  });
});

describe("antigravityUsageFetcher", () => {
  it("returns needs-auth when no Gemini/agy credential is present", async () => {
    const homeDir = mkdtempSync(nodePath.join(os.tmpdir(), "synara-agy-empty-"));
    tempDirs.push(homeDir);
    const snapshot = await antigravityUsageFetcher.fetch({
      homeDir,
      env: {},
      platform: "linux",
      nowMs: NOW_MS,
    });
    expect(snapshot.status).toBe("needs-auth");
  });

  it("reads the agy oauth token file and fetches the Cloud Code quota summary", async () => {
    const { homeDir } = makeGeminiHome(".gemini/antigravity-cli/antigravity-oauth-token", {
      auth_method: "consumer",
      token: {
        access_token: "ya29-access",
        refresh_token: "1//refresh",
        expiry: new Date(NOW_MS + 3_600_000).toISOString(),
      },
    });
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url);
      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer ya29-access");
      // Cloud Code answers consumer accounts with a 403 license error without this agent.
      expect(headers["User-Agent"]).toBe("antigravity");
      if (isQuotaSummaryUrl(target)) {
        return jsonResponse(QUOTA_SUMMARY);
      }
      if (target.includes("loadCodeAssist")) {
        return jsonResponse({
          currentTier: { id: "free-tier", name: "Antigravity" },
          paidTier: { id: "g1-pro-tier", name: "Google AI Pro" },
        });
      }
      throw new Error(`unexpected url ${target}`);
    });
    stubOutboundFetch(fetchMock);

    const snapshot = await antigravityUsageFetcher.fetch({
      homeDir,
      env: {},
      platform: "linux",
      nowMs: NOW_MS,
    });

    expect(snapshot.status).toBe("ok");
    expect(snapshot.planName).toBe("Google AI Pro");
    expect(snapshot.limits.map((limit) => limit.window)).toEqual([
      "5h",
      "Weekly",
      "Claude 5h",
      "Claude Weekly",
    ]);
    expect(snapshot.limits[0]).toMatchObject({ usedPercent: 75, windowDurationMins: 300 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps summary quota when the plan lookup fails", async () => {
    const { homeDir } = makeGeminiHome(".gemini/antigravity-cli/antigravity-oauth-token", {
      token: { access_token: "ya29-access", expiry: new Date(NOW_MS + 3_600_000).toISOString() },
    });
    stubOutboundFetch(async (url) => {
      if (isQuotaSummaryUrl(String(url))) return jsonResponse(QUOTA_SUMMARY);
      throw new Error("connection failed");
    });

    const snapshot = await antigravityUsageFetcher.fetch({
      homeDir,
      env: {},
      platform: "linux",
      nowMs: NOW_MS,
    });

    expect(snapshot.status).toBe("ok");
    expect(snapshot.planName).toBeUndefined();
    expect(snapshot.limits).toHaveLength(4);
  });

  it("falls back to legacy per-model quota when the summary RPC is missing", async () => {
    const { homeDir } = makeGeminiHome(".gemini/oauth_creds.json", {
      access_token: "ya29-access",
      expiry_date: NOW_MS + 3_600_000,
    });
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url);
      if (isQuotaSummaryUrl(target)) {
        return jsonResponse({ error: { code: 404 } }, 404);
      }
      if (target.includes("loadCodeAssist")) {
        return jsonResponse({
          currentTier: { id: "standard-tier", name: "Paid" },
          cloudaicompanionProject: "gen-lang-client-9",
        });
      }
      if (isLegacyQuotaUrl(target)) {
        expect(String(init?.body)).toContain("gen-lang-client-9");
        return jsonResponse({
          buckets: [{ modelId: "gemini-2.5-pro", remainingFraction: 0.75 }],
        });
      }
      throw new Error(`unexpected url ${target}`);
    });
    stubOutboundFetch(fetchMock);

    const snapshot = await antigravityUsageFetcher.fetch({
      homeDir,
      env: {},
      platform: "linux",
      nowMs: NOW_MS,
    });

    expect(snapshot.status).toBe("ok");
    expect(snapshot.planName).toBe("Paid");
    expect(snapshot.limits[0]).toMatchObject({ window: "Pro", usedPercent: 25 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it.each([
    { name: "unauthorized", response: jsonResponse({}, 401), expectedStatus: "needs-auth" },
    { name: "throttled", response: jsonResponse({}, 429), expectedStatus: "error" },
    { name: "unavailable", response: jsonResponse({}, 503), expectedStatus: "error" },
    { name: "unreachable", response: new Error("connection failed"), expectedStatus: "error" },
  ])(
    "reports $name quota summary without the legacy fallback",
    async ({ response, expectedStatus }) => {
      const { homeDir } = makeGeminiHome(".gemini/antigravity-cli/antigravity-oauth-token", {
        token: { access_token: "ya29-access", expiry: new Date(NOW_MS + 3_600_000).toISOString() },
      });
      const fetchMock = vi.fn(async (url: string | URL | Request) => {
        if (!isQuotaSummaryUrl(String(url))) throw new Error(`unexpected url ${String(url)}`);
        if (response instanceof Error) throw response;
        return response;
      });
      stubOutboundFetch(fetchMock);

      const snapshot = await antigravityUsageFetcher.fetch({
        homeDir,
        env: {},
        platform: "linux",
        nowMs: NOW_MS,
      });

      expect(snapshot.status).toBe(expectedStatus);
      expect(snapshot.limits).toEqual([]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it("refreshes an expired nested token and persists the rotation", async () => {
    const { homeDir, credPath } = makeGeminiHome(
      ".gemini/antigravity-cli/antigravity-oauth-token",
      {
        auth_method: "consumer",
        token: {
          access_token: "ya29-old",
          refresh_token: "1//old-refresh",
          expiry: new Date(NOW_MS - 60_000).toISOString(),
        },
      },
    );
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url);
      if (target.includes("oauth2.googleapis.com/token")) {
        const body = new URLSearchParams(String(init?.body));
        expect(body.get("grant_type")).toBe("refresh_token");
        expect(body.get("refresh_token")).toBe("1//old-refresh");
        // agy tokens only refresh with the Antigravity client that issued them.
        expect(body.get("client_id")).toMatch(new RegExp(`^${ANTIGRAVITY_CLIENT_ID_PREFIX}`));
        expect(body.get("client_secret")).toBeTruthy();
        return jsonResponse({
          access_token: "ya29-new",
          refresh_token: "1//new-refresh",
          expires_in: 3600,
        });
      }
      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer ya29-new");
      if (isQuotaSummaryUrl(target)) {
        return jsonResponse({ groups: [] });
      }
      if (target.includes("loadCodeAssist")) {
        return jsonResponse({ currentTier: { id: "free-tier" } });
      }
      throw new Error(`unexpected url ${target}`);
    });
    stubOutboundFetch(fetchMock);

    const snapshot = await antigravityUsageFetcher.fetch({
      homeDir,
      env: {},
      platform: "linux",
      nowMs: NOW_MS,
    });

    expect(snapshot.status).toBe("ok");
    expect(snapshot.planName).toBe("Free");
    const saved = JSON.parse(readFileSync(credPath, "utf8")) as {
      token: { access_token: string; refresh_token: string };
    };
    expect(saved.token.access_token).toBe("ya29-new");
    expect(saved.token.refresh_token).toBe("1//new-refresh");
  });

  it("refreshes Gemini CLI credentials with the Gemini CLI client", async () => {
    const { homeDir, credPath } = makeGeminiHome(".gemini/oauth_creds.json", {
      access_token: "ya29-old",
      refresh_token: "1//gemini-refresh",
      expiry_date: NOW_MS - 60_000,
    });
    stubOutboundFetch(async (url, init) => {
      const target = String(url);
      if (target.includes("oauth2.googleapis.com/token")) {
        const body = new URLSearchParams(String(init?.body));
        expect(body.get("client_id")).toMatch(new RegExp(`^${GEMINI_CLI_CLIENT_ID_PREFIX}`));
        return jsonResponse({ access_token: "ya29-new", expires_in: 3600 });
      }
      if (isQuotaSummaryUrl(target)) return jsonResponse(QUOTA_SUMMARY);
      if (target.includes("loadCodeAssist")) return jsonResponse({});
      throw new Error(`unexpected url ${target}`);
    });

    const snapshot = await antigravityUsageFetcher.fetch({
      homeDir,
      env: {},
      platform: "linux",
      nowMs: NOW_MS,
    });

    expect(snapshot.status).toBe("ok");
    const saved = JSON.parse(readFileSync(credPath, "utf8")) as { access_token: string };
    expect(saved.access_token).toBe("ya29-new");
  });

  it.each([
    {
      name: "revoked refresh token",
      response: jsonResponse({ error: "invalid_grant" }, 400),
      expectedStatus: "needs-auth",
    },
    {
      name: "malformed refresh request",
      response: jsonResponse({ error: "invalid_request" }, 400),
      expectedStatus: "error",
    },
    {
      name: "rejected OAuth client",
      response: jsonResponse({ error: "invalid_client" }, 401),
      expectedStatus: "error",
    },
    {
      name: "refresh throttling",
      response: jsonResponse({ error: "rate_limit_exceeded" }, 429),
      expectedStatus: "error",
    },
    {
      name: "refresh server failure",
      response: jsonResponse({ error: "unavailable" }, 503),
      expectedStatus: "error",
    },
    {
      name: "refresh transport failure",
      response: new Error("connection failed"),
      expectedStatus: "error",
    },
    {
      name: "missing refreshed access token",
      response: jsonResponse({ expires_in: 3600 }),
      expectedStatus: "error",
    },
  ])("reports $name without reusing expired credentials", async ({ response, expectedStatus }) => {
    const { homeDir, credPath } = makeGeminiHome(".gemini/oauth_creds.json", {
      access_token: "ya29-expired",
      refresh_token: "1//refresh",
      expiry_date: NOW_MS - 60_000,
    });
    const originalCreds = readFileSync(credPath, "utf8");
    const fetchMock = vi.fn(async () => {
      if (response instanceof Error) throw response;
      return response;
    });
    stubOutboundFetch(fetchMock);

    const snapshot = await antigravityUsageFetcher.fetch({
      homeDir,
      env: {},
      platform: "linux",
      nowMs: NOW_MS,
    });

    expect(snapshot.status).toBe(expectedStatus);
    expect(snapshot.limits).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(readFileSync(credPath, "utf8")).toBe(originalCreds);
  });

  it.each([
    { name: "unauthorized", response: jsonResponse({}, 401), expectedStatus: "needs-auth" },
    { name: "forbidden", response: jsonResponse({}, 403), expectedStatus: "needs-auth" },
    { name: "throttled", response: jsonResponse({}, 429), expectedStatus: "error" },
    { name: "unavailable", response: jsonResponse({}, 503), expectedStatus: "error" },
    { name: "unreachable", response: new Error("connection failed"), expectedStatus: "error" },
  ])("reports $name legacy quota with the confirmed plan", async ({ response, expectedStatus }) => {
    const { homeDir } = makeGeminiHome(".gemini/oauth_creds.json", {
      access_token: "ya29-access",
      expiry_date: NOW_MS + 3_600_000,
    });
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const target = String(url);
      if (isQuotaSummaryUrl(target)) {
        return jsonResponse({ error: { code: 404 } }, 404);
      }
      if (target.includes("loadCodeAssist")) {
        return jsonResponse({ paidTier: { name: "Google AI Pro" } });
      }
      if (isLegacyQuotaUrl(target)) {
        if (response instanceof Error) throw response;
        return response;
      }
      throw new Error(`unexpected url ${target}`);
    });
    stubOutboundFetch(fetchMock);

    const snapshot = await antigravityUsageFetcher.fetch({
      homeDir,
      env: {},
      platform: "linux",
      nowMs: NOW_MS,
    });

    expect(snapshot.status).toBe(expectedStatus);
    expect(snapshot.planName).toBe("Google AI Pro");
    expect(snapshot.limits).toEqual([]);
    expect(snapshot.detail).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
