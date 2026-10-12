import { describe, expect, it } from "vitest";

import { deriveRetryAttemptMetrics, parseRetryAttemptMetrics } from "./effortRetryMetrics";

const row = (kind: string, turnId: string, createdAt: string, payload: unknown = {}) => ({
  kind,
  turnId,
  createdAt,
  payload,
});

describe("retry attempt metrics", () => {
  it("sums the exact turn's normalized model usage and elapsed time", () => {
    const rows = [
      row("turn.started", "source", "2026-10-11T10:00:00.000Z"),
      row("turn.completed", "other", "2026-10-11T10:00:01.000Z", {
        modelUsage: { other: { inputTokens: 50, outputTokens: 50, totalTokens: 100 } },
      }),
      row("turn.completed", "source", "2026-10-11T10:00:02.500Z", {
        modelUsage: {
          main: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
          child: { inputTokens: 30, outputTokens: 5, totalTokens: 35 },
        },
        totalCostUsd: 0.041,
      }),
    ];
    expect(deriveRetryAttemptMetrics(rows, "source")).toEqual({
      inputTokens: 130,
      outputTokens: 25,
      totalTokens: 155,
      durationMs: 2500,
      costUsd: 0.041,
    });
    expect(deriveRetryAttemptMetrics(rows, "missing")).toEqual({});
  });

  it("rejects cumulative context tokens and incomplete or malformed model usage", () => {
    const rows = [
      row("context-window.updated", "source", "2026-10-11T10:00:01.000Z", {
        usedTokens: 99_999,
      }),
      row("turn.completed", "source", "2026-10-11T10:00:02.000Z", {
        modelUsage: { main: { inputTokens: 20, outputTokens: -3, totalTokens: 17 } },
      }),
    ];
    expect(deriveRetryAttemptMetrics(rows, "source")).toEqual({});
    expect(parseRetryAttemptMetrics(null)).toEqual({});
    expect(parseRetryAttemptMetrics({ inputTokens: 10, outputTokens: 5 })).toEqual({});
    expect(
      parseRetryAttemptMetrics({
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 99,
        durationMs: -1,
        costUsd: Number.POSITIVE_INFINITY,
      }),
    ).toEqual({});
  });

  it("retains independently known costs without fabricating token counts", () => {
    const rows = [
      row("turn.completed", "source", "2026-10-11T10:00:02.000Z", {
        totalCostUsd: 0.02,
      }),
    ];
    expect(deriveRetryAttemptMetrics(rows, "source")).toEqual({ costUsd: 0.02 });
    expect(
      parseRetryAttemptMetrics({
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        durationMs: 1500,
        costUsd: 0,
      }),
    ).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      durationMs: 1500,
      costUsd: 0,
    });
  });
});
