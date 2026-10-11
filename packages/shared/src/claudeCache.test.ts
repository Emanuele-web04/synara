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
        requiresConfirmation: false,
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

  it.each([
    [299, "likely-warm", false],
    [300, "unknown", false],
    [3599, "unknown", false],
    [3600, "likely-expired", false],
  ] as const)("assesses mixed cache lifetimes after %i seconds", (seconds, state, confirmation) => {
    expect(assessClaudeCache({ ...baseline, partialTtlSeconds: 300 }, time(seconds))).toEqual({
      state,
      idleSeconds: seconds,
      requiresConfirmation: confirmation,
    });
  });

  it("keeps an authoritative native expired observation even inside an inferred TTL", () => {
    expect(
      assessClaudeCache({ ...baseline, state: "likely-expired", source: "session-start" }, time(1))
        .state,
    ).toBe("likely-expired");
  });

  it("asks only after Claude Code's 70-minute pause, whatever the cache state", () => {
    const expiredEarly = { ...baseline, ttlSeconds: 300 };
    expect(assessClaudeCache(expiredEarly, time(4_199)).requiresConfirmation).toBe(false);
    expect(assessClaudeCache(expiredEarly, time(4_200)).requiresConfirmation).toBe(true);
    const { ttlSeconds: _ttl, ...unknownTtl } = baseline;
    expect(assessClaudeCache(unknownTtl, time(4_200))).toEqual({
      state: "unknown",
      idleSeconds: 4_200,
      requiresConfirmation: true,
    });
    const { lastResponseAt: _last, ...unknownIdle } = baseline;
    expect(assessClaudeCache(unknownIdle, time(4_200)).requiresConfirmation).toBe(false);
  });

  it("asks from 100k context tokens, like Claude Code, and never for unknown context", () => {
    expect(
      assessClaudeCache({ ...baseline, contextTokens: 99_999 }, time(4_200)).requiresConfirmation,
    ).toBe(false);
    expect(
      assessClaudeCache({ ...baseline, contextTokens: 100_000 }, time(4_200)).requiresConfirmation,
    ).toBe(true);
    const { contextTokens: _context, ...unknownContext } = baseline;
    expect(assessClaudeCache(unknownContext, time(4_200)).requiresConfirmation).toBe(false);
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
    ).toEqual({ state: "likely-expired", idleSeconds: 0, requiresConfirmation: false });
  });
});
