import { describe, expect, it } from "vitest";
import type { ClaudeCacheObservation } from "@synara/contracts";
import { assessClaudeCache } from "./claudeCache";

const baseline: ClaudeCacheObservation = {
  observedAt: "2026-09-16T10:00:00.000Z",
  lastResponseAt: "2026-09-16T10:00:00.000Z",
  contextTokens: 896_542,
  ttlSeconds: 3_600,
  state: "likely-warm",
  source: "request-usage",
};
const time = (seconds: number) => Date.parse(baseline.observedAt) + seconds * 1_000;

describe("Claude cache assessment", () => {
  it.each([300, 3_600])(
    "uses the observed %i-second TTL across idle in the same process",
    (ttlSeconds) => {
      const observation = { ...baseline, ttlSeconds };
      expect(assessClaudeCache(observation, time(ttlSeconds - 1)).state).toBe("likely-warm");
      expect(assessClaudeCache(observation, time(ttlSeconds))).toEqual({
        state: "likely-expired",
        idleSeconds: ttlSeconds,
        requiresConfirmation: true,
      });
    },
  );

  it("does not invent a TTL or treat missing evidence as zero", () => {
    const { ttlSeconds: _ttl, ...unknownTtl } = baseline;
    expect(assessClaudeCache(unknownTtl, time(1)).state).toBe("unknown");
    expect(assessClaudeCache(undefined, time(1))).toEqual({
      state: "unknown",
      requiresConfirmation: false,
    });
  });

  it("keeps an authoritative native expired observation even inside an inferred TTL", () => {
    expect(
      assessClaudeCache({ ...baseline, state: "likely-expired", source: "session-start" }, time(1))
        .requiresConfirmation,
    ).toBe(true);
  });

  it("does not prompt for small or unknown context", () => {
    expect(
      assessClaudeCache({ ...baseline, contextTokens: 100_000 }, time(4000)).requiresConfirmation,
    ).toBe(false);
    const { contextTokens: _context, ...unknownContext } = baseline;
    expect(assessClaudeCache(unknownContext, time(4000)).requiresConfirmation).toBe(false);
  });

  it("rejects clock skew and malformed ordering", () => {
    expect(assessClaudeCache(baseline, time(-1)).state).toBe("unknown");
    expect(
      assessClaudeCache(
        { ...baseline, lastResponseAt: new Date(time(1)).toISOString() },
        time(4000),
      ).state,
    ).toBe("unknown");
  });

  it("expires from request start even when response output finishes much later", () => {
    expect(
      assessClaudeCache(
        {
          ...baseline,
          ttlSeconds: 300,
          cacheReferenceAt: baseline.observedAt,
          observedAt: new Date(time(600)).toISOString(),
          lastResponseAt: new Date(time(600)).toISOString(),
        },
        time(600),
      ),
    ).toEqual({ state: "likely-expired", idleSeconds: 0, requiresConfirmation: true });
  });
});
