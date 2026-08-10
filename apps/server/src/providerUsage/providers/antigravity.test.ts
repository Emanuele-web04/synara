// FILE: providerUsage/providers/antigravity.test.ts
// Purpose: Covers Antigravity's local-server quota parsing and snapshot mapping.
// The gRPC-web JSON shapes mirror the live `agy` language server responses;
// port discovery is stubbed so tests never touch real processes or sockets.

import { afterEach, describe, expect, it } from "vitest";

import {
  __endpointOrderForTests,
  __setAntigravityDiscoveryForTests,
  antigravityUsageFetcher,
  buildAntigravitySnapshot,
} from "./antigravity";

const NOW_MS = 1_780_000_000_000;

afterEach(() => {
  __setAntigravityDiscoveryForTests(null);
});

const userStatusJson = {
  code: 0,
  userStatus: {
    name: "Ada",
    email: "ada@example.com",
    planStatus: {
      planInfo: {
        planName: "Pro",
        monthlyPromptCredits: 50_000,
        monthlyFlowCredits: 150_000,
      },
      availablePromptCredits: 500,
      availableFlowCredits: 100,
    },
    cascadeModelConfigData: {
      clientModelConfigs: [
        {
          label: "Gemini 3.6 Flash (High)",
          modelOrAlias: { model: "MODEL_PLACEHOLDER_M71" },
          quotaInfo: { remainingFraction: 0.8, resetTime: "2026-08-10T04:10:32Z" },
        },
        {
          label: "No quota model",
          modelOrAlias: { model: "MODEL_PLACEHOLDER_M36" },
        },
      ],
    },
  },
};

const quotaSummaryJson = {
  code: 0,
  response: {
    description: "Models share a weekly and 5-hour limit.",
    groups: [
      {
        displayName: "Gemini Models",
        buckets: [
          {
            bucketId: "gemini-weekly",
            displayName: "Weekly Limit Remaining",
            window: "weekly",
            remainingFraction: 0.9,
            resetTime: "2026-08-13T21:10:25Z",
          },
          {
            bucketId: "gemini-5h",
            displayName: "Five Hour Limit Remaining",
            window: "5h",
            remainingFraction: 1,
            resetTime: "2026-08-10T04:13:17Z",
          },
        ],
      },
    ],
  },
};

describe("buildAntigravitySnapshot", () => {
  it("maps quota buckets to limit rows and credits to usage lines", () => {
    const snapshot = buildAntigravitySnapshot({
      status: {
        planName: "Pro",
        monthlyPromptCredits: 50_000,
        monthlyFlowCredits: 150_000,
        availablePromptCredits: 500,
        availableFlowCredits: 100,
        modelQuotas: [],
      },
      quotaGroups: [
        {
          displayName: "Gemini Models",
          buckets: [
            {
              displayName: "Weekly",
              window: "weekly",
              remainingFraction: 0.9,
              resetAt: "2026-08-13T21:10:25.000Z",
            },
            { displayName: "5 Hour", window: "5h", remainingFraction: 1 },
          ],
        },
      ],
      nowMs: NOW_MS,
    });

    expect(snapshot.status).toBe("ok");
    expect(snapshot.planName).toBe("Pro");
    expect(snapshot.limits).toHaveLength(2);
    expect(snapshot.limits[0]?.window).toBe("Gemini Models · Weekly");
    expect(snapshot.limits[0]?.usedPercent).toBeCloseTo(10, 2);
    expect(snapshot.limits[0]?.resetsAt).toBe("2026-08-13T21:10:25.000Z");
    expect(snapshot.limits[1]?.usedPercent).toBe(0);
    const labels = snapshot.usageLines.map((line) => line.label);
    expect(labels).toContain("Prompt credits");
    expect(labels).toContain("Flow credits");
    const promptLine = snapshot.usageLines.find((line) => line.label === "Prompt credits");
    expect(promptLine?.value).toContain("500");
  });

  it("shows no usage lines when credits are absent", () => {
    const snapshot = buildAntigravitySnapshot({
      status: { modelQuotas: [] },
      quotaGroups: [],
      nowMs: NOW_MS,
    });
    expect(snapshot.status).toBe("ok");
    expect(snapshot.limits).toHaveLength(0);
    expect(snapshot.usageLines).toHaveLength(0);
    expect(snapshot.planName).toBeUndefined();
  });
});

describe("antigravityUsageFetcher", () => {
  it("orders endpoints http-first then https across discovered ports", () => {
    const endpoints = __endpointOrderForTests([61920, 61921]);
    expect(endpoints.slice(0, 2)).toEqual([
      { port: 61920, scheme: "http" },
      { port: 61921, scheme: "http" },
    ]);
    expect(endpoints.slice(2)).toEqual([
      { port: 61920, scheme: "https" },
      { port: 61921, scheme: "https" },
    ]);
  });

  it("returns unsupported when no local Antigravity process is listening", async () => {
    __setAntigravityDiscoveryForTests({
      detectPids: async () => [],
      listeningPorts: async () => [],
    });

    const snapshot = await antigravityUsageFetcher.fetch({
      homeDir: "/home/user",
      env: {},
      platform: "darwin",
      nowMs: NOW_MS,
    });
    expect(snapshot.status).toBe("unsupported");
    expect(snapshot.detail).toContain("No local Antigravity process");
  });

  it("never throws when discovery fails", async () => {
    __setAntigravityDiscoveryForTests({
      detectPids: async () => {
        throw new Error("boom");
      },
      listeningPorts: async () => [],
    });
    const snapshot = await antigravityUsageFetcher.fetch({
      homeDir: "/home/user",
      env: {},
      platform: "darwin",
      nowMs: NOW_MS,
    });
    expect(snapshot.status).toBe("error");
    expect(snapshot.detail).toContain("temporarily unavailable");
  });
});

// Static analysis guard: the parse helpers must tolerate the live response
// shapes even when they are never invoked through the stubbed fetcher path.
describe("antigravity live shape compatibility", () => {
  it("keeps userStatus parsing importable", async () => {
    const { parseUserStatus, parseQuotaSummary } = await import("./antigravity");
    const status = parseUserStatus(userStatusJson);
    expect(status?.planName).toBe("Pro");
    expect(status?.monthlyPromptCredits).toBe(50_000);
    expect(status?.modelQuotas).toHaveLength(1);
    expect(status?.modelQuotas[0]?.remainingFraction).toBe(0.8);
    const groups = parseQuotaSummary(quotaSummaryJson);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.buckets).toHaveLength(2);
    expect(groups[0]?.buckets[0]?.remainingFraction).toBe(0.9);
  });
});
