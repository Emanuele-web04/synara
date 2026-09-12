import { describe, expect, it } from "vitest";
import { MindMemoryId, ProjectId, type MindMemory } from "@synara/contracts";

import {
  MIND_HISTORY_NOTE,
  countStaleMindMemories,
  formatMindCountLabel,
  formatMindDayLabel,
  formatMindDigestSuffix,
  formatMindHistoryActorLabel,
  formatMindHistoryOpLabel,
  formatMindWeightLabel,
  groupMindMemoriesByDay,
  isMindListTruncated,
  mindCapPercent,
  optimisticAffirmWeight,
  optimisticForgetCount,
  sortMindMemories,
} from "./mindList";

describe("isMindListTruncated", () => {
  it("is truncated only when fewer rows are shown than the true total", () => {
    expect(isMindListTruncated({ shown: 500, total: 2300 })).toBe(true);
    expect(isMindListTruncated({ shown: 2, total: 2 })).toBe(false);
    expect(isMindListTruncated({ shown: 0, total: 0 })).toBe(false);
  });
});

describe("formatMindCountLabel", () => {
  it("renders the plain count when the whole store is loaded", () => {
    expect(formatMindCountLabel({ shown: 2, total: 2, pinnedCount: 1, cap: 500 })).toBe(
      "2 memories · 1 pinned",
    );
  });

  it("renders the singular noun for one memory", () => {
    expect(formatMindCountLabel({ shown: 1, total: 1, pinnedCount: 0, cap: 500 })).toBe(
      "1 memory · 0 pinned",
    );
  });

  it("renders showing X of N when the page is truncated", () => {
    expect(formatMindCountLabel({ shown: 500, total: 2300, pinnedCount: 12, cap: 500 })).toBe(
      "Showing 500 of 2300 memories · 12 pinned",
    );
  });
});

describe("optimisticForgetCount", () => {
  it("decrements when the whole store is loaded", () => {
    expect(optimisticForgetCount({ count: 2, shown: 2 })).toBe(1);
    expect(optimisticForgetCount({ count: 0, shown: 0 })).toBe(0);
  });

  it("keeps the true total while truncated so the refetch converges it", () => {
    expect(optimisticForgetCount({ count: 2300, shown: 500 })).toBe(2300);
  });
});

let memoryCounter = 0;
const makeMemory = (overrides: Partial<MindMemory> = {}): MindMemory => {
  memoryCounter += 1;
  return {
    memoryId: MindMemoryId.makeUnsafe(`memory-${memoryCounter}`),
    projectId: ProjectId.makeUnsafe("project-1"),
    text: `fact ${memoryCounter}`,
    type: "semantic",
    weight: 0.6,
    accessCount: 0,
    pinned: false,
    createdAt: "2026-09-12T10:00:00.000Z",
    lastAccessedAt: "2026-09-12T10:00:00.000Z",
    provenance: { kind: "user" },
    ...overrides,
  };
};

describe("sortMindMemories", () => {
  it("sorts weight-desc with memory-id tie-break", () => {
    const light = makeMemory({ memoryId: MindMemoryId.makeUnsafe("b-memory"), weight: 0.5 });
    const heavy = makeMemory({ memoryId: MindMemoryId.makeUnsafe("a-memory"), weight: 0.9 });
    const tied = makeMemory({ memoryId: MindMemoryId.makeUnsafe("c-memory"), weight: 0.9 });
    expect(sortMindMemories([light, tied, heavy]).map((item) => item.memoryId)).toEqual([
      "a-memory",
      "c-memory",
      "b-memory",
    ]);
  });
});

describe("formatMindDayLabel", () => {
  // Local-noon construction keeps the buckets stable in any timezone.
  const now = new Date(2026, 8, 12, 12, 0, 0);
  it("labels today and yesterday", () => {
    expect(formatMindDayLabel(new Date(2026, 8, 12, 9, 0, 0), now)).toBe("Today");
    expect(formatMindDayLabel(new Date(2026, 8, 11, 9, 0, 0), now)).toBe("Yesterday");
  });

  it("formats older days as a date", () => {
    const label = formatMindDayLabel(new Date(2026, 8, 10, 9, 0, 0), now);
    expect(label).not.toBe("Today");
    expect(label).not.toBe("Yesterday");
    expect(label.length).toBeGreaterThan(0);
  });
});

describe("groupMindMemoriesByDay", () => {
  it("buckets by createdAt local day, newest day first, weight-desc inside a day", () => {
    const now = new Date(2026, 8, 12, 12, 0, 0);
    const todayIso = new Date(2026, 8, 12, 9, 0, 0).toISOString();
    const yesterdayIso = new Date(2026, 8, 11, 9, 0, 0).toISOString();
    const lightToday = makeMemory({
      memoryId: MindMemoryId.makeUnsafe("today-light"),
      weight: 0.5,
      createdAt: todayIso,
    });
    const heavyToday = makeMemory({
      memoryId: MindMemoryId.makeUnsafe("today-heavy"),
      weight: 0.9,
      createdAt: todayIso,
    });
    const yesterday = makeMemory({
      memoryId: MindMemoryId.makeUnsafe("yesterday"),
      weight: 0.95,
      createdAt: yesterdayIso,
    });
    // Heaviest row is yesterday's, so input order must not leak across groups.
    const groups = groupMindMemoriesByDay([yesterday, lightToday, heavyToday], now);
    expect(groups.map((group) => group.label)).toEqual(["Today", "Yesterday"]);
    expect(groups[0]?.memories.map((item) => item.memoryId)).toEqual([
      "today-heavy",
      "today-light",
    ]);
    expect(groups[1]?.memories.map((item) => item.memoryId)).toEqual(["yesterday"]);
  });
});

describe("countStaleMindMemories", () => {
  it("counts unpinned memories idle over 30 days only", () => {
    const nowMs = new Date(2026, 8, 12, 12, 0, 0).getTime();
    const dayMs = 86_400_000;
    const stale = makeMemory({
      lastAccessedAt: new Date(nowMs - 31 * dayMs).toISOString(),
    });
    const pinnedStale = makeMemory({
      pinned: true,
      lastAccessedAt: new Date(nowMs - 60 * dayMs).toISOString(),
    });
    const fresh = makeMemory({ lastAccessedAt: new Date(nowMs - 5 * dayMs).toISOString() });
    expect(countStaleMindMemories([stale, pinnedStale, fresh], nowMs)).toBe(1);
  });
});

describe("mindCapPercent", () => {
  it("rounds the share of cap in use and guards a zero cap", () => {
    expect(mindCapPercent({ count: 400, cap: 500 })).toBe(80);
    expect(mindCapPercent({ count: 1, cap: 3 })).toBe(33);
    expect(mindCapPercent({ count: 5, cap: 0 })).toBe(0);
  });
});

describe("formatMindDigestSuffix", () => {
  it("names stale memories and cap pressure in words", () => {
    expect(formatMindDigestSuffix({ staleCount: 3, count: 400, cap: 500 })).toBe(
      " · 3 need review · 80% of cap",
    );
    expect(formatMindDigestSuffix({ staleCount: 1, count: 400, cap: 500 })).toBe(
      " · 1 needs review · 80% of cap",
    );
  });

  it("stays quiet about the cap until half full", () => {
    expect(formatMindDigestSuffix({ staleCount: 0, count: 10, cap: 500 })).toBe("");
    expect(formatMindDigestSuffix({ staleCount: 1, count: 10, cap: 500 })).toBe(
      " · 1 needs review",
    );
  });

  it("is empty when there is no cap and nothing stale", () => {
    expect(formatMindDigestSuffix({ staleCount: 0, count: 0, cap: 0 })).toBe("");
  });
});

describe("formatMindWeightLabel", () => {
  it("says strong, fading, or needs review instead of a decimal", () => {
    expect(formatMindWeightLabel(0.9)).toBe("strong");
    expect(formatMindWeightLabel(0.6)).toBe("strong");
    expect(formatMindWeightLabel(0.42)).toBe("fading");
    expect(formatMindWeightLabel(0.25)).toBe("fading");
    expect(formatMindWeightLabel(0.24)).toBe("needs review");
    expect(formatMindWeightLabel(0)).toBe("needs review");
  });
});

describe("optimisticAffirmWeight", () => {
  it("bumps by 0.15 capped at 1.0", () => {
    expect(optimisticAffirmWeight(0.6)).toBe(0.75);
    expect(optimisticAffirmWeight(0.95)).toBe(1);
    expect(optimisticAffirmWeight(1)).toBe(1);
  });
});

describe("mind history render helpers", () => {
  it("labels every timeline op in the past tense", () => {
    expect(formatMindHistoryOpLabel("remember")).toBe("Saved");
    expect(formatMindHistoryOpLabel("confirm")).toBe("Confirmed");
    expect(formatMindHistoryOpLabel("edit")).toBe("Edited");
    expect(formatMindHistoryOpLabel("pin")).toBe("Pinned");
    expect(formatMindHistoryOpLabel("unpin")).toBe("Unpinned");
    expect(formatMindHistoryOpLabel("forget")).toBe("Forgotten");
    expect(formatMindHistoryOpLabel("prune")).toBe("Pruned");
  });

  it("labels user rows as you and agent rows with their provider", () => {
    expect(formatMindHistoryActorLabel({ kind: "user" })).toBe("you");
    expect(formatMindHistoryActorLabel({ kind: "agent", provider: "codex" })).toContain("agent");
  });

  it("frames history honestly: when, never what", () => {
    expect(MIND_HISTORY_NOTE).toContain("not what changed");
  });
});
