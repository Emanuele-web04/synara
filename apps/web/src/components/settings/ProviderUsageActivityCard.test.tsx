import type { ProfileTokenProviderUsage } from "@synara/contracts";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { ProviderUsageActivityCard } from "./ProviderUsageActivityCard";

const usage: ProfileTokenProviderUsage[] = [
  {
    provider: "opencode",
    tokens: 12_345,
    tokensReported: true,
    turnCount: 4,
    threadCount: 2,
    costUsd: null,
    lastUsedAt: "2026-08-08T12:00:00.000Z",
    models: [
      {
        provider: "opencode",
        model: "anthropic/claude-sonnet-4-6",
        tokens: 12_345,
        percent: 100,
        turnCount: 4,
        upstreamProviderId: "anthropic",
      },
    ],
    history: [
      {
        day: "2026-08-08",
        tokens: 12_345,
        turnCount: 4,
        threadCount: 2,
        costUsd: null,
      },
    ],
  },
];

describe("ProviderUsageActivityCard", () => {
  it("renders actual tokens, turns, provider, and honest missing cost", () => {
    const markup = renderToStaticMarkup(
      <ProviderUsageActivityCard usage={usage} isLoading={false} />,
    );

    expect(markup).toContain("Actual usage");
    expect(markup).toContain("12.3k");
    expect(markup).toContain("4 turns");
    expect(markup).toContain("Not reported");
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain("anthropic/claude-sonnet-4-6");
  });

  it("renders bounded loading and empty states", () => {
    expect(
      renderToStaticMarkup(<ProviderUsageActivityCard usage={[]} isLoading={true} />),
    ).toContain("Loading actual usage");
    expect(
      renderToStaticMarkup(<ProviderUsageActivityCard usage={[]} isLoading={false} />),
    ).toContain("No usage recorded in Synara yet");
  });
});
