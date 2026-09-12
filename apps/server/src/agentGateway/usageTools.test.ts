import type { ServerAgentProviderUsage } from "@synara/contracts";
import { Effect } from "effect";

import { readProviderUsageForAgents } from "../providerUsage/agentReader";
import { describe, expect, it } from "vitest";

import type { ToolContext } from "./toolRuntime";
import { makeAgentGatewayUsageTools } from "./usageTools";

const usage: ServerAgentProviderUsage = {
  provider: "codex",
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

  it("scopes synara_get_usage to authenticated caller provider", async () => {
    let requestedProvider: string | undefined;
    const [tool] = makeAgentGatewayUsageTools({
      loadProviderUsage: (provider) => {
        requestedProvider = provider;
        return Effect.succeed([usage]);
      },
    });

    const result = await Effect.runPromise(tool!.handler({}, context));

    expect(requestedProvider).toBe("codex");
    expect(resultJson(result).usage).toEqual(usage);
  });

  it("lists enabled provider results without a caller-selected provider", async () => {
    let requestedProvider: string | undefined = "not-called";
    const tools = makeAgentGatewayUsageTools({
      loadProviderUsage: (provider) => {
        requestedProvider = provider;
        return Effect.succeed([usage]);
      },
    });

    const result = await Effect.runPromise(tools[1]!.handler({}, context));

    expect(requestedProvider).toBeUndefined();
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
        }),
    });

    const result = await Effect.runPromise(tool!.handler({}, context));
    const timedOut = resultJson(result).usage as Record<string, unknown>;

    expect(timedOut.provider).toBe("codex");
    expect(timedOut.availability).toBe("unavailable");
    expect(timedOut.unavailableReason).toBe("timed-out");
    expect(timedOut.quotaWindows).toEqual([]);
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
        }),
    });

    const result = await Effect.runPromise(tools[1]!.handler({}, context));
    const results = resultJson(result).usage as ServerAgentProviderUsage[];

    expect(result.isError).not.toBe(true);
    expect(results[0]?.quotaWindows[0]?.remainingPercent).toBe(25);
    expect(results[1]).toMatchObject({ provider: "cursor", unavailableReason: "timed-out" });
  });

  it("reports missing snapshots explicitly", async () => {
    const [tool] = makeAgentGatewayUsageTools({ loadProviderUsage: () => Effect.succeed([]) });
    const result = await Effect.runPromise(tool!.handler({}, context));
    expect(resultJson(result).usage).toMatchObject({
      provider: "codex",
      availability: "unavailable",
      unavailableReason: "missing-snapshot",
    });
  });

  it("returns an error result when the load fails", async () => {
    const [tool] = makeAgentGatewayUsageTools({
      loadProviderUsage: () => Effect.fail(new Error("boom")),
    });

    const result = await Effect.runPromise(tool!.handler({}, context));

    expect(result.isError).toBe(true);
  });
});
