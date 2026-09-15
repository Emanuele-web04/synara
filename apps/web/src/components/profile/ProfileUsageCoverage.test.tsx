// FILE: ProfileUsageCoverage.test.tsx
// Purpose: Verify missing telemetry stays visible in profile rankings and exported cards.
// Layer: web profile feature tests.

import type { ProfileTokenStats } from "@synara/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProfileSettingsPanel } from "../settings/ProfileSettingsPanel";
import { ShareCard } from "./ShareCard";
import { baseStats, tokenStats } from "./profileTestFixtures";

const queryState = vi.hoisted(() => ({ tokenStats: null as ProfileTokenStats | null }));

vi.mock("~/lib/serverReactQuery", () => ({
  serverProfileStatsQueryOptions: () => ({ queryKey: ["core"] }),
  serverProfileTokenStatsQueryOptions: () => ({ queryKey: ["tokens"] }),
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: { queryKey: string[] }) => ({
    data: options.queryKey[0] === "core" ? baseStats : queryState.tokenStats,
    isPending: false,
    isError: false,
  }),
}));
vi.mock("./ShareDialog", () => ({ ShareDialog: () => null }));
vi.mock("./EditProfileDialog", () => ({ EditProfileDialog: () => null }));

function renderCard() {
  return renderToStaticMarkup(
    <ShareCard
      stats={baseStats}
      tokenStats={queryState.tokenStats}
      displayName="Synara"
      handle="@synara"
      avatarColor="#000000"
      avatarImage={null}
    />,
  );
}

describe("profile ranking coverage", () => {
  beforeEach(() => {
    queryState.tokenStats = tokenStats;
  });

  it("qualifies the 100% provider result and names missing providers on both profile rankings", () => {
    queryState.tokenStats = {
      ...tokenStats,
      topProviderPercent: 100,
      unavailableProviders: ["grok", "devin"],
    };
    const markup = renderToStaticMarkup(<ProfileSettingsPanel />);
    expect(markup).toContain("100% of tracked tokens");
    expect(markup).toContain("Share of tracked tokens.");
    expect(markup.match(/Token data is unavailable for Grok, Devin/g)).toHaveLength(2);
    expect(markup).toContain("Claude token totals use verifiable records");
  });

  it("includes missing-provider disclosure in the exported card itself", () => {
    queryState.tokenStats = { ...tokenStats, unavailableProviders: ["grok"] };
    const markup = renderCard();
    expect(markup).toContain("top provider · tracked tokens");
    expect(markup).toContain("Token data is unavailable for Grok.");
    expect(markup).toContain("Percentages reflect tracked tokens only.");
  });

  it("omits missing-provider notices when all providers have telemetry", () => {
    for (const markup of [renderToStaticMarkup(<ProfileSettingsPanel />), renderCard()]) {
      expect(markup).not.toContain("Token data is unavailable");
      expect(markup).toContain("tracked tokens");
    }
  });

  it.each([null, { ...tokenStats, available: false, unavailableProviders: ["grok"] }])(
    "labels fallback percentages as turns without a token exclusion notice",
    (unavailable) => {
      queryState.tokenStats = unavailable as ProfileTokenStats | null;
      const profile = renderToStaticMarkup(<ProfileSettingsPanel />);
      expect(profile).toContain("66.7% of turns");
      expect(profile).toContain("Share of turns.");
      const card = renderCard();
      expect(card).toContain("top provider · turns");
      for (const markup of [profile, card]) {
        expect(markup).not.toContain("Token data is unavailable");
      }
    },
  );
});
