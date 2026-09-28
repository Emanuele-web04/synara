import { describe, expect, it } from "vitest";
import { EventId, type OrchestrationThreadActivity, TurnId } from "@synara/contracts";

import {
  deriveContextWindowSelectionStatus,
  deriveComposerContextWindowLabel,
  deriveAppliedContextWindowSelection,
  deriveContextWindowMeterDisplay,
  deriveCumulativeCostUsd,
  deriveLatestContextWindowState,
  deriveSelectedContextWindowSnapshot,
  formatContextWindowTokens,
} from "./contextWindow";

function makeActivity(
  id: string,
  kind: string,
  payload: OrchestrationThreadActivity["payload"],
): OrchestrationThreadActivity {
  return {
    id: EventId.makeUnsafe(id),
    tone: "info",
    kind,
    summary: kind,
    payload,
    turnId: TurnId.makeUnsafe("turn-1"),
    createdAt: "2026-03-23T00:00:00.000Z",
  };
}

describe("contextWindow", () => {
  it("does not label a runtime threshold as the target when configuration history is missing", () => {
    expect(
      deriveContextWindowSelectionStatus({
        activeSnapshot: deriveSelectedContextWindowSnapshot("1m"),
        appliedValue: null,
        selectedValue: "auto",
      }),
    ).toEqual({ activeLabel: null, selectedLabel: "Auto", pendingSelectedLabel: null });
  });

  it("uses persisted applied modes so Auto is not permanently pending", () => {
    for (const [payload, appliedValue] of [
      [{ cleared: true }, "auto"],
      [{ maxTokens: 200_000 }, "200k"],
      [{ maxTokens: 1_000_000 }, "1m"],
    ] as const) {
      const applied = deriveAppliedContextWindowSelection([
        makeActivity("configured", "context-window.configured", payload),
      ]);
      expect(applied).toBe(appliedValue);
      expect(
        deriveContextWindowSelectionStatus({
          activeSnapshot: deriveSelectedContextWindowSnapshot("1m"),
          appliedValue: applied,
          selectedValue: appliedValue,
        }).pendingSelectedLabel,
      ).toBeNull();
    }
  });

  it("preserves validated Claude cache evidence from the latest usage snapshot", () => {
    const claudeCache = {
      observedAt: "2026-03-23T00:00:00.000Z",
      state: "unknown",
      source: "request-usage",
      contextTokens: 887_036,
      lastRequest: { messageId: "request-1", cacheCreationInputTokens: 887_036 },
    };
    const derive = (value: OrchestrationThreadActivity["payload"] | undefined) =>
      deriveLatestContextWindowState([
        makeActivity("cache", "context-window.updated", {
          usedTokens: 887_036,
          ...(value === undefined ? {} : { claudeCache: value }),
        }),
      ]).snapshot;
    expect(derive(claudeCache)?.claudeCache).toEqual(claudeCache);
    expect(derive(undefined)?.claudeCache).toBeNull();
    expect(derive({ ...claudeCache, state: "warm" })?.claudeCache).toBeNull();
    expect(derive({ ...claudeCache, contextTokens: -1 })?.claudeCache).toBeNull();
  });

  it("withholds old Claude processed totals while preserving context and other providers", () => {
    for (const provider of ["claudeAgent", "codex"]) {
      const payload = { provider, usedTokens: 100, totalProcessedTokens: 400 };
      const legacy = deriveLatestContextWindowState([
        makeActivity("legacy", "context-window.updated", payload),
      ]).snapshot;
      expect(legacy?.usedTokens).toBe(100);
      expect(legacy?.totalProcessedTokens).toBe(provider === "claudeAgent" ? null : 400);
      const corrected = deriveLatestContextWindowState([
        makeActivity("corrected", "context-window.updated", {
          ...payload,
          tokenAccountingVersion: 1,
        }),
      ]).snapshot;
      expect(corrected?.totalProcessedTokens).toBe(400);
    }
  });

  it("derives the latest valid context window snapshot", () => {
    const snapshot = deriveLatestContextWindowState([
      makeActivity("activity-1", "context-window.updated", {
        usedTokens: 1000,
      }),
      makeActivity("activity-2", "tool.started", {}),
      makeActivity("activity-3", "context-window.updated", {
        usedTokens: 14_000,
        maxTokens: 258_000,
        compactsAutomatically: true,
      }),
    ]).snapshot;

    expect(snapshot).not.toBeNull();
    expect(snapshot?.usedTokens).toBe(14_000);
    expect(snapshot?.totalProcessedTokens).toBeNull();
    expect(snapshot?.maxTokens).toBe(258_000);
    expect(snapshot?.compactsAutomatically).toBe(true);
  });

  it("invalidates earlier usage at a completed compaction until fresh usage arrives", () => {
    const beforeCompaction = [
      makeActivity("activity-1", "context-window.configured", {
        contextWindow: "200k",
        maxTokens: 200_000,
      }),
      makeActivity("activity-2", "context-window.updated", {
        usedTokens: 180_000,
        maxTokens: 200_000,
      }),
      makeActivity("activity-3", "context-compaction", {
        state: "compacted",
      }),
      makeActivity("activity-4", "context-window.updated", {
        usedTokens: 0,
        totalProcessedTokens: 340_000,
      }),
    ];

    expect(deriveLatestContextWindowState(beforeCompaction).snapshot).toBeNull();
    expect(deriveLatestContextWindowState(beforeCompaction).invalidatedByCompaction).toBe(true);

    const afterFreshUsage = deriveLatestContextWindowState([
      ...beforeCompaction,
      makeActivity("activity-5", "context-window.updated", {
        usedTokens: 20_000,
        maxTokens: 200_000,
      }),
    ]).snapshot;

    expect(afterFreshUsage?.usedTokens).toBe(20_000);
  });

  it("ignores malformed payloads", () => {
    const snapshot = deriveLatestContextWindowState([
      makeActivity("activity-1", "context-window.updated", {}),
    ]).snapshot;

    expect(snapshot).toBeNull();
  });

  it("derives real zero-percent context window snapshots", () => {
    const snapshot = deriveLatestContextWindowState([
      makeActivity("activity-1", "context-window.updated", {
        usedTokens: 0,
        usedPercent: 0,
        compactsAutomatically: true,
      }),
    ]).snapshot;

    expect(snapshot?.usedTokens).toBe(0);
    expect(snapshot?.usedPercent).toBe(0);
    expect(snapshot?.usedPercentage).toBe(0);
  });

  it("keeps zero-token usage reliable when runtime reports max tokens", () => {
    const snapshot = deriveLatestContextWindowState([
      makeActivity("activity-1", "context-window.updated", {
        usedTokens: 0,
        usedPercent: 0,
        maxTokens: 128_000,
        compactsAutomatically: true,
      }),
    ]).snapshot;

    expect(snapshot?.remainingTokens).toBe(128_000);
    expect(deriveContextWindowMeterDisplay(snapshot!)).toMatchObject({
      hasReliableTokenRatio: true,
      tokenUsageLabel: "0",
      compactLabel: "0%",
    });
  });

  it("does not infer remaining tokens from percent-only usage", () => {
    const snapshot = deriveLatestContextWindowState([
      makeActivity("activity-1", "context-window.configured", {
        contextWindow: "1m",
        maxTokens: 1_000_000,
      }),
      makeActivity("activity-2", "context-window.updated", {
        usedTokens: 0,
        usedPercent: 5.8,
        compactsAutomatically: true,
      }),
    ]).snapshot;

    expect(snapshot?.usedTokens).toBe(0);
    expect(snapshot?.usedPercentage).toBe(5.8);
    expect(snapshot?.maxTokens).toBeNull();
    expect(snapshot?.remainingTokens).toBeNull();
  });

  it("formats compact token counts", () => {
    expect(formatContextWindowTokens(999)).toBe("999");
    expect(formatContextWindowTokens(1400)).toBe("1.4k");
    expect(formatContextWindowTokens(14_000)).toBe("14k");
    expect(formatContextWindowTokens(258_000)).toBe("258k");
  });

  it("invalidates old usage when Auto is applied", () => {
    const snapshot = deriveLatestContextWindowState([
      makeActivity("activity-1", "context-window.configured", {
        contextWindow: "1m",
        maxTokens: 1_000_000,
      }),
      makeActivity("activity-2", "context-window.updated", {
        usedTokens: 23_000,
        maxTokens: 200_000,
      }),
      makeActivity("activity-3", "context-window.configured", { cleared: true }),
    ]).snapshot;

    expect(snapshot).toBeNull();
  });

  it("waits for runtime usage instead of presenting the target as a measurement", () => {
    const snapshot = deriveLatestContextWindowState([
      makeActivity("activity-1", "context-window.configured", {
        contextWindow: "1m",
        maxTokens: 1_000_000,
      }),
    ]).snapshot;

    expect(snapshot).toBeNull();
  });

  it("derives meter display labels without inventing token ratios", () => {
    const percentOnly = deriveLatestContextWindowState([
      makeActivity("activity-1", "context-window.configured", {
        contextWindow: "1m",
        maxTokens: 1_000_000,
      }),
      makeActivity("activity-2", "context-window.updated", {
        usedTokens: 0,
        usedPercent: 5.8,
      }),
    ]).snapshot;

    expect(percentOnly).not.toBeNull();
    expect(deriveContextWindowMeterDisplay(percentOnly!)).toMatchObject({
      usedPercentageLabel: "5.8%",
      tokenUsageLabel: "0",
      hasReliableTokenRatio: false,
      normalizedPercentage: 5.8,
      compactLabel: "6%",
      ariaLabel: "Context window 5.8% used",
    });
  });

  it("uses Cursor cumulative cost without summing it as a turn delta", () => {
    expect(
      deriveCumulativeCostUsd([
        makeActivity("turn-1", "turn.completed", {
          cumulativeCostUsd: 0.2,
        }),
        makeActivity("turn-2", "turn.completed", {
          cumulativeCostUsd: 0.25,
        }),
      ]),
    ).toBe(0.25);
  });

  it("marks a selected Claude context window as pending when the live session differs", () => {
    const snapshot = deriveLatestContextWindowState([
      makeActivity("activity-1", "context-window.updated", {
        usedTokens: 23_000,
        maxTokens: 200_000,
      }),
    ]).snapshot;

    expect(
      deriveContextWindowSelectionStatus({
        activeSnapshot: snapshot,
        selectedValue: "1m",
      }),
    ).toEqual({
      activeLabel: "200k",
      selectedLabel: "1M",
      pendingSelectedLabel: "1M",
    });
  });
});

describe("composer context budget label", () => {
  const model = "claude-fable-5-1";
  it.each([
    ["auto", "auto", 967000, model, "(1M)"],
    ["1m", "1m", 967000, `${model}[1m]`, "(1M)"],
    ["1m", "1m", 167000, model, "(200k)"],
    ["200k", "1m", 167000, model, "(200k · 1M next)"],
    ["1m", "auto", 967000, model, "(1M · Auto next)"],
    [null, "1m", null, null, "(1M next)"],
    [null, "auto", null, null, null],
    ["1m", "1m", 967000, "claude-opus-4-7", "(1M next)"],
    ["1m", "1m", 50000, model, "(1M target)"],
  ])(
    "applied %s, selected %s, budget %s, model %s",
    (applied, selected, maxTokens, observedModel, expected) => {
      const snapshot =
        maxTokens === null
          ? null
          : {
              ...deriveSelectedContextWindowSnapshot("1m")!,
              maxTokens,
              claudeCache: observedModel
                ? {
                    model: observedModel,
                    observedAt: "2026-09-17T00:00:00.000Z",
                    state: "unknown" as const,
                    source: "request-usage" as const,
                  }
                : null,
            };
      const status = deriveContextWindowSelectionStatus({
        activeSnapshot: snapshot,
        appliedValue: applied,
        selectedValue: selected,
      });
      expect(
        deriveComposerContextWindowLabel({ provider: "claudeAgent", model, snapshot, status }),
      ).toBe(expected);
      expect(
        deriveComposerContextWindowLabel({ provider: "codex", model, snapshot, status }),
      ).toBeNull();
    },
  );
});
