import type { ClaudeCacheObservation } from "@synara/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ClaudeCacheDetails } from "./ClaudeCacheDetails";

const observedAt = "2026-09-16T10:00:00.000Z";

function renderDetails(overrides: Partial<ClaudeCacheObservation> = {}, elapsedMinutes = 0) {
  return renderToStaticMarkup(
    <ClaudeCacheDetails
      observation={{
        observedAt,
        lastResponseAt: observedAt,
        state: "likely-warm",
        source: "session-start",
        ttlSeconds: 3600,
        contextTokens: 887_036,
        ...overrides,
      }}
      nowMs={Date.parse(observedAt) + elapsedMinutes * 60_000}
    />,
  );
}

describe("ClaudeCacheDetails", () => {
  it("ages persisted evidence without implying a guaranteed cache hit", () => {
    expect(renderDetails({}, 30)).toContain("Likely warm");
    const expired = renderDetails({}, 240);
    expect(expired).toContain("Likely expired");
    expect(expired).toContain("4 hours ago");
    expect(expired).toContain("next request may reprocess about");
    expect(expired).toContain("Cache state is estimated.");
    expect(expired).not.toContain("saved");
  });

  it("keeps unavailable timing and token counters distinct from zero", () => {
    const markup = renderDetails({
      state: "unknown",
      ttlSeconds: undefined,
      lastResponseAt: undefined,
      lastRequest: { messageId: "request-1", cacheReadInputTokens: 0 },
    });
    expect(markup).toContain("Unknown");
    expect(markup).toContain("Cache lifetime is unavailable.");
    expect(markup).toContain("0 tokens");
    expect(markup.match(/Unavailable/g)).toHaveLength(2);
    expect(markup).not.toContain("Last response:");
  });
});
