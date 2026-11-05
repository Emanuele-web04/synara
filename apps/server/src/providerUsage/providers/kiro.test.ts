// FILE: providerUsage/providers/kiro.test.ts
// Purpose: Kiro usage reads kiro-cli's login read-only, never refreshes it, and maps
// getUsageLimits (shape captured from a live Kiro Power account) to the usage snapshot.

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { DatabaseSync } from "node:sqlite";

import { outboundHttp } from "@synara/shared/outboundHttp";
import { afterEach, describe, expect, it, vi } from "vitest";

import { kiroDataDbPaths, kiroUsageFetcher, parseKiroUsage } from "./kiro";

const NOW_MS = Date.parse("2026-11-04T18:00:00.000Z");
const PROFILE_ARN = "arn:aws:codewhisperer:eu-central-1:123456789012:profile/TESTPROFILE";

const LIVE_SHAPE = {
  daysUntilReset: 0,
  limits: [],
  nextDateReset: 1796083200,
  overageConfiguration: { overageLimit: null, overageStatus: "DISABLED" },
  subscriptionInfo: { subscriptionTitle: "KIRO POWER", type: "Q_DEVELOPER_STANDALONE_POWER" },
  usageBreakdownList: [
    {
      bonuses: [],
      currency: "USD",
      currentOverages: 0,
      currentUsage: 0,
      currentUsageWithPrecision: 2500.5,
      displayName: "Credit",
      displayNamePlural: "Credits",
      freeTrialInfo: null,
      nextDateReset: 1796083200,
      overageCharges: 0,
      resourceType: "CREDIT",
      usageLimit: 10000,
      usageLimitWithPrecision: 10000,
    },
  ],
  userInfo: { email: "person@example.com", userId: "user-1" },
};

const tempDirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeKiroHome(token: Record<string, unknown> | null): string {
  const home = mkdtempSync(nodePath.join(tmpdir(), "kiro-usage-"));
  tempDirs.push(home);
  const dir = nodePath.join(home, "Library", "Application Support", "kiro-cli");
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(nodePath.join(dir, "data.sqlite3"));
  db.exec("CREATE TABLE auth_kv (key TEXT PRIMARY KEY, value TEXT)");
  db.exec("CREATE TABLE state (key TEXT PRIMARY KEY, value TEXT)");
  if (token) {
    db.prepare("INSERT INTO auth_kv VALUES (?, ?)").run(
      "kirocli:odic:token",
      JSON.stringify(token),
    );
  }
  db.prepare("INSERT INTO state VALUES (?, ?)").run(
    "api.codewhisperer.profile",
    JSON.stringify({ arn: PROFILE_ARN, profile_name: "Test" }),
  );
  db.close();
  return home;
}

function mockUsageResponse(status: number, json: unknown) {
  return vi.spyOn(outboundHttp, "request").mockResolvedValue({
    status,
    headers: new Headers(),
    body: new TextEncoder().encode(JSON.stringify(json)),
    url: "https://q.eu-central-1.amazonaws.com",
  });
}

const ctxFor = (homeDir: string) => ({
  homeDir,
  env: {},
  platform: "darwin" as const,
  nowMs: NOW_MS,
});

describe("kiroDataDbPaths", () => {
  it("uses kiro-cli's data directory per OS", () => {
    expect(kiroDataDbPaths({ homeDir: "/Users/t", env: {}, platform: "darwin" })).toEqual([
      nodePath.join("/Users/t", "Library", "Application Support", "kiro-cli", "data.sqlite3"),
    ]);
    expect(
      kiroDataDbPaths({ homeDir: "/home/t", env: { XDG_DATA_HOME: "/data" }, platform: "linux" }),
    ).toEqual([nodePath.join("/data", "kiro-cli", "data.sqlite3")]);
    expect(kiroDataDbPaths({ homeDir: "C:\\Users\\t", env: {}, platform: "win32" })).toEqual([]);
  });
});

describe("parseKiroUsage", () => {
  it("maps the monthly credit window and plan without account identity", () => {
    const snapshot = parseKiroUsage({ json: LIVE_SHAPE, nowMs: NOW_MS });
    expect(snapshot).toMatchObject({
      provider: "kiro",
      status: "ok",
      planName: "Kiro Power",
      limits: [{ window: "Monthly", usedPercent: 25.005, resetsAt: "2026-12-01T00:00:00.000Z" }],
      usageLines: [{ label: "Credits", value: "2,500.5 of 10,000" }],
    });
    expect(JSON.stringify(snapshot)).not.toContain("person@example.com");
  });

  it("adds active free-trial, bonus and enabled overage lines", () => {
    const credit = LIVE_SHAPE.usageBreakdownList[0]!;
    const snapshot = parseKiroUsage({
      nowMs: NOW_MS,
      json: {
        ...LIVE_SHAPE,
        overageConfiguration: { overageStatus: "ENABLED" },
        usageBreakdownList: [
          {
            ...credit,
            overageCharges: 1.2,
            freeTrialInfo: {
              freeTrialStatus: "ACTIVE",
              usageLimitWithPrecision: 500,
              currentUsageWithPrecision: 20,
              freeTrialExpiry: 1796083200,
            },
            bonuses: [{ usageLimit: 100, currentUsage: 10 }],
          },
        ],
      },
    });
    expect(snapshot.usageLines).toEqual([
      { label: "Credits", value: "2,500.5 of 10,000" },
      { label: "Free trial", value: "20 of 500", subtitle: "Expires 2026-12-01" },
      { label: "Bonus credits", value: "10 of 100" },
      { label: "Overage", value: "$1.20" },
    ]);
  });
});

describe("kiroUsageFetcher", () => {
  it("asks for sign-in without a stored login and never calls the network", async () => {
    const request = mockUsageResponse(200, LIVE_SHAPE);
    const snapshot = await kiroUsageFetcher.fetch(ctxFor(makeKiroHome(null)));
    expect(snapshot.status).toBe("needs-auth");
    expect(snapshot.detail).toContain("kiro-cli login");
    expect(request).not.toHaveBeenCalled();
  });

  it("does not use or refresh an expired token", async () => {
    const request = mockUsageResponse(200, LIVE_SHAPE);
    const home = makeKiroHome({
      access_token: "expired-token",
      refresh_token: "refresh",
      expires_at: "2026-11-04T17:00:00Z",
      region: "us-east-1",
    });
    const snapshot = await kiroUsageFetcher.fetch(ctxFor(home));
    expect(snapshot).toMatchObject({ status: "needs-auth" });
    expect(snapshot.detail).toContain("renews the next time Kiro runs");
    expect(request).not.toHaveBeenCalled();
  });

  it("queries the profile's region with the stored token", async () => {
    const request = mockUsageResponse(200, LIVE_SHAPE);
    const home = makeKiroHome({
      access_token: "live-token",
      expires_at: "2026-11-04T19:00:00Z",
      region: "us-east-1",
    });
    const snapshot = await kiroUsageFetcher.fetch(ctxFor(home));
    expect(snapshot.status).toBe("ok");
    const call = request.mock.calls[0]![0];
    const url = new URL(call.url);
    expect(url.origin).toBe("https://q.eu-central-1.amazonaws.com");
    expect(url.pathname).toBe("/getUsageLimits");
    expect(url.searchParams.get("profileArn")).toBe(PROFILE_ARN);
    expect(call.headers).toMatchObject({ Authorization: "Bearer live-token" });
    expect(call.method).toBe("GET");
    expect(await kiroUsageFetcher.cacheKey!(ctxFor(home))).not.toContain("live-token");
  });

  it("reports a rejected token as needs-auth", async () => {
    mockUsageResponse(403, { message: "expired" });
    const home = makeKiroHome({ access_token: "t", expires_at: "2026-11-04T19:00:00Z" });
    expect((await kiroUsageFetcher.fetch(ctxFor(home))).status).toBe("needs-auth");
  });
});
