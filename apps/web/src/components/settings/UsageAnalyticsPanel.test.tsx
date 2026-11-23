import type { StatsGetUsageAnalyticsResult, StatsUsageAnalyticsScope } from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { serverQueryKeys } from "~/lib/serverReactQuery";
import { UsageAnalyticsPanel } from "./UsageAnalyticsPanel";
import { localDayKey, usageAnalyticsWindow } from "./usageAnalytics.logic";

function defaultWindow() {
  const noon = new Date(`${localDayKey(new Date())}T12:00:00`);
  return usageAnalyticsWindow("30d", noon);
}

function makeResult(
  scope: StatsUsageAnalyticsScope,
  overrides: Partial<StatsGetUsageAnalyticsResult> = {},
): StatsGetUsageAnalyticsResult {
  const window = defaultWindow();
  return {
    generatedAt: window.to.toISOString(),
    from: (window.previousFrom ?? window.from).toISOString(),
    to: window.to.toISOString(),
    tokens: [],
    turns: [],
    costs: [],
    pricing: { status: "fresh", fetchedAt: null },
    scope,
    sessionFileProviders: [],
    projects: [],
    unavailableProviders: [],
    ...overrides,
  };
}

function renderPanel(
  scope: StatsUsageAnalyticsScope,
  result: StatsGetUsageAnalyticsResult,
): string {
  const window = defaultWindow();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(
    serverQueryKeys.usageAnalytics({
      from: (window.previousFrom ?? window.from).toISOString(),
      to: window.to.toISOString(),
      scope,
    }),
    result,
  );
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <UsageAnalyticsPanel initialScope={scope} />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("UsageAnalyticsPanel", () => {
  it("shows This Device copy on non-Mac platforms in the scope picker and empty state", () => {
    vi.stubGlobal("navigator", { platform: "Linux x86_64" });

    const markup = renderPanel("mac", makeResult("mac"));

    expect(markup).toContain("This Device");
    expect(markup).not.toContain("This Mac");
    expect(markup).toContain(
      "Chats in Synara and Claude Code or Codex sessions on this device show up here.",
    );
  });

  it("shows this device in session-file notes on non-Mac platforms", () => {
    vi.stubGlobal("navigator", { platform: "Win32" });
    const window = defaultWindow();
    const activeHour = new Date(window.to.getTime() - 3_600_000).toISOString();

    const markup = renderPanel(
      "mac",
      makeResult("mac", {
        tokens: [
          {
            hour: activeHour,
            provider: "claudeAgent",
            model: "claude-opus",
            projectId: null,
            origin: null,
            tokens: 1200,
            cacheReadTokens: 0,
            unpricedTokens: 0,
            unsplitTokens: 0,
          },
        ],
        turns: [
          {
            hour: activeHour,
            provider: "claudeAgent",
            model: "claude-opus",
            projectId: null,
            turns: 1,
            failedTurns: 0,
          },
        ],
        costs: [
          {
            hour: activeHour,
            provider: "claudeAgent",
            model: "claude-opus",
            projectId: null,
            source: "reported",
            costUsd: 0.42,
            turns: 1,
          },
        ],
        sessionFileProviders: ["claudeAgent"],
      }),
    );

    expect(markup).toContain("This Device");
    expect(markup).toContain("every session on this device, read from their own session files.");
    expect(markup).not.toContain("on this Mac");
  });

  it("keeps This Mac copy on macOS platforms", () => {
    vi.stubGlobal("navigator", { platform: "MacIntel" });

    const markup = renderPanel("mac", makeResult("mac"));

    expect(markup).toContain("This Mac");
    expect(markup).not.toContain("This Device");
    expect(markup).toContain(
      "Chats in Synara and Claude Code or Codex sessions on this Mac show up here.",
    );
  });
});
