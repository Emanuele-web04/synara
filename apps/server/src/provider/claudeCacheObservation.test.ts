import { describe, expect, it } from "vitest";
import {
  claudeCacheContextTokens,
  claudeCacheFromRequest,
  claudeCacheFromSessionStart,
  claudeCacheForModel,
  observedClaudeCacheTtl,
} from "./claudeCacheObservation";

const observedAt = "2026-09-16T10:00:00.000Z";

describe("Claude native cache observations", () => {
  it("adds response output only when summary and last API input correspond", () => {
    const apiUsage = {
      input_tokens: 2,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 120000,
      output_tokens: 4,
    };
    expect(claudeCacheContextTokens({ totalTokens: 120002, apiUsage })).toBe(120006);
    expect(claudeCacheContextTokens({ totalTokens: 4000, apiUsage })).toBe(4000);
  });
  it("extracts optional resume fields without inventing usage or a TTL", () => {
    expect(
      claudeCacheFromSessionStart(
        {
          hook_event_name: "SessionStart",
          session_id: "native",
          seconds_since_last_response: 3600,
          context_tokens: 896542,
          prompt_cache_likely_expired: true,
          estimated_cache_write_usd: 2.5,
        },
        observedAt,
        "generation",
      ),
    ).toEqual({
      nativeSessionId: "native",
      lifecycleGeneration: "generation",
      observedAt,
      contextTokens: 896542,
      lastResponseAt: "2026-09-16T09:00:00.000Z",
      state: "likely-expired",
      source: "session-start",
      estimatedCacheWriteUsd: 2.5,
    });
  });

  it("leaves fields unknown on older hooks", () => {
    expect(
      claudeCacheFromSessionStart(
        { hook_event_name: "SessionStart", session_id: "native" },
        observedAt,
      ),
    ).toEqual({ nativeSessionId: "native", observedAt, state: "unknown", source: "session-start" });
  });

  it("separates a large cache rebuild from ordinary input and includes output in context", () => {
    const observation = claudeCacheFromRequest({
      messageId: "response",
      observedAt,
      usage: {
        input_tokens: 2,
        cache_read_input_tokens: 9506,
        cache_creation_input_tokens: 887036,
        output_tokens: 100,
        cache_creation: { ephemeral_1h_input_tokens: 887036 },
      },
    });
    expect(observation.contextTokens).toBe(896644);
    expect(observation.ttlSeconds).toBe(3600);
    expect(observation.lastRequest).toEqual({
      messageId: "response",
      inputTokens: 2,
      cacheReadInputTokens: 9506,
      cacheCreationInputTokens: 887036,
    });
  });

  it("uses the shortest native TTL for mixed cache durations", () => {
    expect(
      observedClaudeCacheTtl({
        cache_creation: { ephemeral_1h_input_tokens: 9000, ephemeral_5m_input_tokens: 1 },
      }),
    ).toBe(300);
    expect(observedClaudeCacheTtl({ cache_creation_input_tokens: 9000 })).toBeUndefined();
  });

  it("does not reuse a TTL across a native session or model change", () => {
    const previous = claudeCacheFromRequest({
      observedAt,
      messageId: "first",
      nativeSessionId: "one",
      model: "opus",
      usage: {
        cache_creation: { ephemeral_1h_input_tokens: 100 },
        cache_creation_input_tokens: 100,
      },
    });
    for (const identity of [
      { nativeSessionId: "two", model: "opus" },
      { nativeSessionId: "one", model: "sonnet" },
    ]) {
      expect(
        claudeCacheFromRequest({
          ...identity,
          observedAt,
          messageId: "next",
          previous,
          usage: { cache_read_input_tokens: 100 },
        }).ttlSeconds,
      ).toBeUndefined();
    }
  });

  it("does not extend a request's cache lifetime with later output snapshots", () => {
    const first = claudeCacheFromRequest({
      observedAt,
      messageId: "first",
      usage: {
        cache_creation_input_tokens: 100,
        cache_creation: { ephemeral_5m_input_tokens: 100 },
      },
    });
    const later = claudeCacheFromRequest({
      observedAt: "2026-09-16T10:10:00.000Z",
      messageId: "first",
      previous: first,
      usage: { cache_read_input_tokens: 100, output_tokens: 200 },
    });
    expect(later.cacheReferenceAt).toBe(observedAt);
    expect(later.lastResponseAt).toBe("2026-09-16T10:10:00.000Z");
    const next = claudeCacheFromRequest({
      observedAt: "2026-09-16T10:11:02.000Z",
      cacheReferenceAt: "2026-09-16T10:11:00.000Z",
      messageId: "next",
      previous: later,
      usage: { cache_read_input_tokens: 100 },
    });
    expect(next.cacheReferenceAt).toBe("2026-09-16T10:11:00.000Z");
  });

  it("keeps old-model cache evidence invalid until a new request refreshes it", () => {
    const previous = claudeCacheFromRequest({
      observedAt,
      messageId: "first",
      model: "opus",
      usage: { cache_read_input_tokens: 100 },
    });
    const changed = claudeCacheForModel(previous, "sonnet");
    expect(changed?.state).toBe("likely-expired");
    expect(changed?.model).toBe("opus");
    expect(claudeCacheForModel(changed, "sonnet")?.state).toBe("likely-expired");
  });
});
