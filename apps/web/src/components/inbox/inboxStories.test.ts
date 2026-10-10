import { describe, expect, it } from "vitest";

import type { StatsGetRecapResult } from "@synara/contracts";

import type { InboxSlotSummary } from "./inbox.logic";
import { buildInboxDigest, buildInboxTiles, type DigestSentence } from "./inboxStories";

function totals(overrides: Partial<StatsGetRecapResult["totals"]> = {}) {
  return {
    from: "",
    to: "",
    prompts: 0,
    chats: 0,
    turns: 0,
    failedTurns: 0,
    agentWorkMs: 0,
    tokens: { user: 0, automation: 0, agent: 0 },
    ...overrides,
  };
}

function recap(overrides: Partial<StatsGetRecapResult> = {}): StatsGetRecapResult {
  return {
    generatedAt: "",
    totals: totals(),
    slots: [],
    projects: [],
    models: [],
    unavailableProviders: [],
    ...overrides,
  };
}

function slot(id: InboxSlotSummary["id"], label: string, agentMinutes: number): InboxSlotSummary {
  return {
    id,
    label,
    status: "done",
    prompts: 1,
    turns: 1,
    tokens: 1,
    agentWorkMs: agentMinutes * 60_000,
    hours: [],
  };
}

const busyDay = recap({
  totals: totals({
    prompts: 41,
    chats: 9,
    turns: 57,
    failedTurns: 2,
    agentWorkMs: 252 * 60_000,
    tokens: { user: 3_200_000, automation: 500_000, agent: 100_000 },
  }),
  models: [
    { provider: "codex", model: "gpt-5-codex", turns: 30, tokens: 2_204_000 },
    { provider: "cursor", model: "claude-sonnet-4-5", turns: 20, tokens: 1_596_000 },
  ],
  projects: [
    { projectId: "p1", title: "synara", prompts: 24, chats: 5, tokens: 2_400_000 },
    { projectId: "p2", title: "remodex", prompts: 11, chats: 3, tokens: 900_000 },
  ],
});
const yesterday = recap({
  totals: totals({ prompts: 35, chats: 7, tokens: { user: 3_100_000, automation: 0, agent: 0 } }),
  models: [{ provider: "claudeAgent", model: "claude-opus-4-1", turns: 20, tokens: 2_000_000 }],
});
const input = {
  recap: busyDay,
  previousRecap: yesterday,
  yesterdaySoFar: { prompts: 35, turns: 50, tokens: 3_100_000, agentWorkMs: 200 * 60_000 },
  slots: [slot("morning", "Morning", 90), slot("afternoon", "Afternoon", 162)],
};

const plain = (sentence: DigestSentence) => sentence.parts.map((part) => part.text).join("");

const track = (remainingPercent: number) => ({
  label: "Remaining",
  remainingPercent,
  markerPercent: null,
  fillClassName: "",
  markerClassName: "",
});

describe("buildInboxDigest", () => {
  it("closes with today's to-dos, and says nothing when there are none", () => {
    const tasksSentence = (tasks: { open: number; done: number; overdue: number }) => {
      const sentence = buildInboxDigest({ ...input, tasks }).find((item) => item.id === "tasks");
      return sentence ? plain(sentence) : null;
    };

    expect(tasksSentence({ open: 0, done: 0, overdue: 0 })).toBeNull();
    expect(tasksSentence({ open: 3, done: 0, overdue: 0 })).toBe("You have 3 tasks to do today.");
    expect(tasksSentence({ open: 2, done: 1, overdue: 1 })).toBe(
      "You finished 1 task today, 2 to go, 1 overdue.",
    );
    expect(tasksSentence({ open: 0, done: 3, overdue: 0 })).toBe(
      "You finished all 3 tasks for today.",
    );
    expect(tasksSentence({ open: 0, done: 1, overdue: 0 })).toBe(
      "You finished your 1 task for today.",
    );
    expect(buildInboxDigest(input).some((item) => item.id === "tasks")).toBe(false);
    // A quiet day still tells the to-dos.
    expect(
      buildInboxDigest({
        recap: recap(),
        previousRecap: undefined,
        yesterdaySoFar: null,
        slots: [],
        tasks: { open: 1, done: 0, overdue: 0 },
      }).map(plain),
    ).toEqual(["You have 1 task to do today."]);
  });

  it("tells the day in a few sentences with the facts marked", () => {
    const digest = buildInboxDigest(input);

    expect(digest.map(plain)).toEqual([
      "You sent 41 prompts across 9 chats, 17% more than this time yesterday.",
      expect.stringMatching(
        /^Most of it went into synara, with .+ carrying 58% of the tokens and .+ the rest\.$/,
      ),
      "Your agents ran for 4h 12m, mostly in the afternoon, and 2 turns failed.",
    ]);
    expect(digest[0]?.parts.find((part) => part.text === "17% more")).toMatchObject({
      tone: "good",
    });
    const modelPart = digest[1]?.parts.find(
      (part) => part.kind === "strong" && "icon" in part && part.icon?.kind === "provider",
    );
    expect(modelPart).toMatchObject({ icon: { kind: "provider", provider: "codex" } });
  });

  it("never calls a second model 'the rest' when a third one also ran", () => {
    const threeModels = recap({
      ...busyDay,
      models: [
        { provider: "codex", model: "gpt-5-codex", turns: 30, tokens: 2_280_000 },
        { provider: "cursor", model: "claude-sonnet-4-5", turns: 20, tokens: 1_140_000 },
        { provider: "grok", model: "grok-4", turns: 5, tokens: 380_000 },
      ],
    });

    const [, work] = buildInboxDigest({ ...input, recap: threeModels });

    expect(work && plain(work)).toMatch(/carrying 60% of the tokens, ahead of .+\.$/);
  });

  it("falls back to yesterday before anything ran today", () => {
    const digest = buildInboxDigest({ ...input, recap: recap(), slots: [] });

    expect(digest.map(plain)).toEqual([
      expect.stringMatching(
        /^Nothing ran yet today\. Yesterday you sent 35 prompts and used 3\.1m tokens, mostly with .+\.$/,
      ),
    ]);
  });

  it("tells an automation-only yesterday without zero prompts", () => {
    const automationDay = recap({
      totals: totals({ turns: 4, tokens: { user: 0, automation: 800_000, agent: 0 } }),
    });
    const digest = buildInboxDigest({
      ...input,
      recap: recap(),
      previousRecap: automationDay,
      slots: [],
    });
    const tiles = buildInboxTiles({
      ...input,
      recap: recap(),
      previousRecap: automationDay,
      quota: [],
    });

    expect(digest.map(plain)).toEqual([
      "Nothing ran yet today. Yesterday your agents used 800k tokens.",
    ]);
    expect(tiles.find((tile) => tile.id === "yesterday")?.detail).toBe("4 turns");
  });

  it("says nothing when there is nothing to tell", () => {
    expect(
      buildInboxDigest({ ...input, recap: recap(), previousRecap: undefined, slots: [] }),
    ).toEqual([]);
  });
});

describe("buildInboxTiles", () => {
  it("keeps one short line per tile and only tiles with data", () => {
    const tiles = buildInboxTiles({
      ...input,
      quota: [
        { provider: "codex", name: "Codex", window: "5h", remainingPercent: 62, track: track(62) },
        {
          provider: "claudeAgent",
          name: "Claude",
          window: "Weekly",
          remainingPercent: 44,
          resetText: "Resets in 3d",
          track: track(44),
        },
      ],
    });

    expect(tiles.map((tile) => [tile.id, tile.detail])).toEqual([
      ["model", "58% of tokens, 30 turns"],
      ["project", "24 prompts, then remodex"],
      ["tokens", "23% more than this time yesterday"],
      ["agents", "Mostly afternoon, 2 failed"],
      ["yesterday", expect.stringMatching(/^35 prompts, mostly .+$/)],
      ["quota", "Resets in 3d"],
    ]);
    expect(tiles.at(-1)).toMatchObject({
      lead: "Left on Claude, weekly",
      value: "44%",
      track: { remainingPercent: 44 },
    });
    expect(
      buildInboxTiles({ ...input, recap: recap(), previousRecap: undefined, quota: [] }),
    ).toEqual([]);
  });
});
