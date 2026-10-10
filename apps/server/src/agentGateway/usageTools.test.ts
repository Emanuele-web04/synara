import {
  ProviderInstanceId,
  type ServerAgentProviderAccountUsage,
  type ServerAgentProviderUsage,
} from "@synara/contracts";
import { Effect } from "effect";

import { readProviderUsageForAgents } from "../providerUsage/agentReader";
import { describe, expect, it } from "vitest";

import type { ToolContext } from "./toolRuntime";
import { makeAgentGatewayUsageTools } from "./usageTools";

const usage: ServerAgentProviderAccountUsage = {
  provider: "codex",
  instanceId: ProviderInstanceId.makeUnsafe("codex"),
  displayName: "Codex",
  isDefault: true,
  enabled: true,
  availability: "available",
  checkedAt: "2026-09-08T18:00:00.000Z",
  freshness: { stale: false, ageMs: 0, maxAgeMs: 300_000 },
  snapshot: {
    provider: "codex",
    updatedAt: "2026-09-08T18:00:00.000Z",
    limits: [{ window: "Weekly", usedPercent: 75 }],
    usageLines: [],
    source: "codex-usage-api",
    status: "ok",
  },
  quotaWindows: [
    {
      window: "Weekly",
      availability: "available",
      usedPercent: 75,
      remainingPercent: 25,
      source: "codex-usage-api",
      observedAt: "2026-09-08T18:00:00.000Z",
    },
  ],
};

const context = {
  principal: {
    kind: "provider-session",
    sessionKey: "session",
    threadId: "thread",
    provider: "codex",
    turnId: "turn",
  },
  callerThreadId: "thread",
  callerThreadLabel: "Thread",
  callerSessionKey: "session",
  callerProvider: "codex",
  callerCapabilities: new Set(["usage:read"]),
  callerTurnId: "turn",
  assertCallerTurnActive: () => Effect.void,
  jsonRpcRequestId: "request",
} as ToolContext;

function resultJson(result: unknown) {
  const text = (result as { content: Array<{ text: string }> }).content[0]?.text ?? "null";
  return JSON.parse(text) as Record<string, unknown>;
}

const withAccount = (result: ServerAgentProviderUsage): ServerAgentProviderAccountUsage => ({
  ...result,
  instanceId: ProviderInstanceId.makeUnsafe(result.provider),
  displayName: result.provider,
  isDefault: true,
  enabled: true,
});

describe("makeAgentGatewayUsageTools", () => {
  it("registers both tools behind usage:read", () => {
    const tools = makeAgentGatewayUsageTools({ loadProviderUsage: () => Effect.succeed([usage]) });

    expect(tools.map((tool) => tool.definition.name)).toEqual([
      "synara_get_usage",
      "synara_list_provider_usage",
    ]);
    expect(tools.every((tool) => tool.requiredCapability === "usage:read")).toBe(true);
    expect(tools.every((tool) => tool.definition.annotations?.readOnlyHint === true)).toBe(true);
  });

  it("requests all configured accounts when synara_get_usage has no filters", async () => {
    let requestedQuery: unknown;
    const [tool] = makeAgentGatewayUsageTools({
      loadProviderUsage: (query) => {
        requestedQuery = query;
        return Effect.succeed([usage]);
      },
    });

    const result = await Effect.runPromise(tool!.handler({}, context));

    expect(requestedQuery).toEqual({});
    expect(resultJson(result).usage).toEqual([usage]);
  });

  it("retains the list alias with the same account filter semantics", async () => {
    let requestedQuery: unknown;
    const tools = makeAgentGatewayUsageTools({
      loadProviderUsage: (query) => {
        requestedQuery = query;
        return Effect.succeed([usage]);
      },
    });

    const query = { provider: "codex", instanceId: "codex" };
    const result = await Effect.runPromise(tools[1]!.handler(query, context));

    expect(requestedQuery).toEqual(query);
    expect(resultJson(result).usage).toEqual([usage]);
  });

  it("returns timed-out unavailable usage when the caller load stalls", async () => {
    const [tool] = makeAgentGatewayUsageTools({
      loadProviderUsage: () =>
        readProviderUsageForAgents({
          providers: ["codex"],
          enabledProviders: new Set(["codex"]),
          loadSnapshot: () => Effect.never,
          timeout: "10 millis",
        }).pipe(Effect.map((results) => results.map(withAccount))),
    });

    const result = await Effect.runPromise(tool!.handler({}, context));
    const [timedOut] = resultJson(result).usage as Array<Record<string, unknown>>;

    expect(timedOut?.provider).toBe("codex");
    expect(timedOut?.availability).toBe("unavailable");
    expect(timedOut?.unavailableReason).toBe("timed-out");
    expect(timedOut?.quotaWindows).toEqual([]);
  });

  it("preserves healthy provider quotas when another provider stalls", async () => {
    const tools = makeAgentGatewayUsageTools({
      loadProviderUsage: () =>
        readProviderUsageForAgents({
          providers: ["codex", "cursor"],
          enabledProviders: new Set(["codex", "cursor"]),
          loadSnapshot: (provider) =>
            provider === "codex" ? Effect.succeed(usage.snapshot) : Effect.never,
          timeout: "10 millis",
          now: () => Date.parse(usage.checkedAt),
        }).pipe(Effect.map((results) => results.map(withAccount))),
    });

    const result = await Effect.runPromise(tools[1]!.handler({}, context));
    const results = resultJson(result).usage as ServerAgentProviderUsage[];

    expect(result.isError).not.toBe(true);
    expect(results[0]?.quotaWindows[0]?.remainingPercent).toBe(25);
    expect(results[1]).toMatchObject({ provider: "cursor", unavailableReason: "timed-out" });
  });

  it("retains missing account identity instead of inventing caller quota", async () => {
    const missing = {
      ...usage,
      availability: "unavailable" as const,
      unavailableReason: "missing-snapshot" as const,
      snapshot: null,
      quotaWindows: [],
    };
    const [tool] = makeAgentGatewayUsageTools({
      loadProviderUsage: () => Effect.succeed([missing]),
    });
    const result = await Effect.runPromise(tool!.handler({}, context));
    expect(resultJson(result).usage).toEqual([missing]);
  });

  it("returns an error result when the load fails", async () => {
    const [tool] = makeAgentGatewayUsageTools({
      loadProviderUsage: () => Effect.fail(new Error("boom")),
    });

    const result = await Effect.runPromise(tool!.handler({}, context));

    expect(result.isError).toBe(true);
  });
});
