import { describe, expect, it } from "vitest";
import type { ClaudeCacheObservation } from "@synara/contracts";
import {
  IDLE_COMPACTION_MIN_CONTEXT_TOKENS,
  IDLE_COMPACTION_TTL_FRACTION,
  idleCompactionDue,
  idleCompactionLeaseKey,
} from "./idleCompaction";

const baseline: ClaudeCacheObservation = {
  observedAt: "2026-09-16T10:00:00.000Z",
  lastResponseAt: "2026-09-16T10:00:00.000Z",
  cacheReferenceAt: "2026-09-16T10:00:00.000Z",
  contextTokens: 896_542,
  ttlSeconds: 3_600,
  state: "likely-warm",
  source: "request-usage",
};
const time = (seconds: number) => Date.parse(baseline.cacheReferenceAt!) + seconds * 1_000;

describe("Idle compaction eligibility", () => {
  it.each([300, 3_600])(
    "fires inside the last fifth of an observed %i-second TTL",
    (ttlSeconds) => {
      const observation = { ...baseline, ttlSeconds };
      const boundary = ttlSeconds * IDLE_COMPACTION_TTL_FRACTION;
      expect(idleCompactionDue(observation, time(boundary - 1))).toBe(false);
      expect(idleCompactionDue(observation, time(boundary))).toBe(true);
      expect(idleCompactionDue(observation, time(ttlSeconds - 1))).toBe(true);
      expect(idleCompactionDue(observation, time(ttlSeconds))).toBe(false);
    },
  );

  it("never fires on missing or expired evidence", () => {
    const { ttlSeconds: _ttl, ...noTtl } = baseline;
    expect(idleCompactionDue(noTtl, time(3_300))).toBe(false);
    const { cacheReferenceAt: _ref, lastResponseAt: _resp, ...noLease } = baseline;
    expect(idleCompactionDue(noLease, time(3_300))).toBe(false);
    expect(idleCompactionDue(undefined, time(3_300))).toBe(false);
    expect(idleCompactionDue({ ...baseline, state: "likely-expired" }, time(3_300))).toBe(false);
  });

  it("requires enough context to justify a maintenance request", () => {
    expect(
      idleCompactionDue(
        { ...baseline, contextTokens: IDLE_COMPACTION_MIN_CONTEXT_TOKENS - 1 },
        time(3_300),
      ),
    ).toBe(false);
    expect(
      idleCompactionDue(
        { ...baseline, contextTokens: IDLE_COMPACTION_MIN_CONTEXT_TOKENS },
        time(3_300),
      ),
    ).toBe(true);
    const { contextTokens: _tokens, ...noTokens } = baseline;
    expect(idleCompactionDue(noTokens, time(3_300))).toBe(false);
  });

  it("anchors the lease on the cache reference, falling back to the last response", () => {
    expect(idleCompactionLeaseKey(baseline)).toBe(baseline.cacheReferenceAt);
    const { cacheReferenceAt: _ref, ...responseOnly } = baseline;
    expect(idleCompactionLeaseKey(responseOnly)).toBe(baseline.lastResponseAt);
  });
});
