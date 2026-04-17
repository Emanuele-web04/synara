import { describe, expect, it } from "vitest";
import { EventId, type OrchestrationThreadActivity, TurnId } from "@t3tools/contracts";

import {
  deriveContextWindowSelectionStatus,
  deriveLatestContextWindowSnapshot,
  formatContextWindowSelectionLabel,
  formatContextWindowTokens,
  inferContextWindowSelectionValue,
} from "./contextWindow";

function makeActivity(id: string, kind: string, payload: unknown): OrchestrationThreadActivity {
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
  it("derives the latest valid context window snapshot", () => {
    const snapshot = deriveLatestContextWindowSnapshot([
      makeActivity("activity-1", "context-window.updated", {
        usedTokens: 1000,
      }),
      makeActivity("activity-2", "tool.started", {}),
      makeActivity("activity-3", "context-window.updated", {
        usedTokens: 14_000,
        maxTokens: 258_000,
        compactsAutomatically: true,
      }),
    ]);

    expect(snapshot).not.toBeNull();
    expect(snapshot?.usedTokens).toBe(14_000);
    expect(snapshot?.totalProcessedTokens).toBeNull();
    expect(snapshot?.maxTokens).toBe(258_000);
    expect(snapshot?.compactsAutomatically).toBe(true);
  });

  it("ignores malformed payloads", () => {
    const snapshot = deriveLatestContextWindowSnapshot([
      makeActivity("activity-1", "context-window.updated", {}),
    ]);

    expect(snapshot).toBeNull();
  });

  it("formats compact token counts", () => {
    expect(formatContextWindowTokens(999)).toBe("999");
    expect(formatContextWindowTokens(1400)).toBe("1.4k");
    expect(formatContextWindowTokens(14_000)).toBe("14k");
    expect(formatContextWindowTokens(258_000)).toBe("258k");
  });

  it("includes total processed tokens when available", () => {
    const snapshot = deriveLatestContextWindowSnapshot([
      makeActivity("activity-1", "context-window.updated", {
        usedTokens: 81_659,
        totalProcessedTokens: 748_126,
        maxTokens: 258_400,
        lastUsedTokens: 81_659,
      }),
    ]);

    expect(snapshot?.usedTokens).toBe(81_659);
    expect(snapshot?.totalProcessedTokens).toBe(748_126);
  });

  it("formats context window selection labels for Claude options", () => {
    expect(formatContextWindowSelectionLabel("1m")).toBe("1M");
    expect(formatContextWindowSelectionLabel("200k")).toBe("200k");
  });

  it("infers the active Claude context window from max tokens", () => {
    expect(inferContextWindowSelectionValue(200_000)).toBe("200k");
    expect(inferContextWindowSelectionValue(1_000_000)).toBe("1m");
    expect(inferContextWindowSelectionValue(333_000)).toBeNull();
  });

  it("marks a selected Claude context window as pending when the live session differs", () => {
    const snapshot = deriveLatestContextWindowSnapshot([
      makeActivity("activity-1", "context-window.updated", {
        usedTokens: 23_000,
        maxTokens: 200_000,
      }),
    ]);

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
