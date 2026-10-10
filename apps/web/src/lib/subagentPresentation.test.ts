import { describe, expect, it } from "vitest";

import {
  formatSubagentModelLabel,
  normalizeSubagentStatusKind,
  resolveSubagentPresentation,
  resolveSubagentPresentationForThread,
} from "./subagentPresentation";

describe("resolveSubagentPresentation", () => {
  it("prefers explicit nickname and role over generic thread titles", () => {
    const presentation = resolveSubagentPresentation({
      nickname: "Halley",
      role: "Explorer",
      title: "New Thread",
      fallbackId: "subagent:thread-1",
    });

    expect(presentation.primaryLabel).toBe("Halley");
    expect(presentation.nickname).toBe("Halley");
    expect(presentation.role).toBe("explorer");
    expect(presentation.fullLabel).toBe("Halley [explorer]");
  });

  it("parses bracketed labels from child-thread titles", () => {
    const presentation = resolveSubagentPresentation({
      title: "Harvey [worker]",
      fallbackId: "subagent:thread-2",
    });

    expect(presentation.nickname).toBe("Harvey");
    expect(presentation.role).toBe("worker");
    expect(presentation.primaryLabel).toBe("Harvey");
  });

  it("hides worker-tier agent types passed as explicit roles", () => {
    const presentation = resolveSubagentPresentation({
      nickname: "Halley",
      role: "worker-low",
      title: null,
      fallbackId: "subagent:thread-1",
    });

    expect(presentation.role).toBeNull();
    expect(presentation.primaryLabel).toBe("Halley");
    expect(presentation.fullLabel).toBe("Halley");
  });

  it("strips worker-tier suffixes baked into persisted thread titles", () => {
    const presentation = resolveSubagentPresentation({
      title: "Research scheduling market - players [worker-medium]",
      fallbackId: "subagent:thread-2",
    });

    expect(presentation.nickname).toBe("Research scheduling market - players");
    expect(presentation.role).toBeNull();
    expect(presentation.primaryLabel).toBe("Research scheduling market - players");
    expect(presentation.fullLabel).toBe("Research scheduling market - players");
  });

  it("falls back past worker-tier-only placeholder titles", () => {
    const presentation = resolveSubagentPresentation({
      title: "Subagent [worker-high]",
      fallbackId: "subagent:thread-1:agent-1",
    });

    expect(presentation.role).toBeNull();
    expect(presentation.title).toBeNull();
    expect(presentation.primaryLabel).toBe("Subagent");
  });

  it("treats provider-id placeholder titles as generic subagent labels", () => {
    const presentation = resolveSubagentPresentation({
      title: "Subagent 019d8cae-0628-7bf1-bf86-5cbc31cd582c",
      fallbackId: "subagent:thread-1:agent-1",
    });

    expect(presentation.title).toBeNull();
    expect(presentation.primaryLabel).toBe("Subagent");
  });

  it("never shows a raw provider id as the label until richer metadata arrives", () => {
    const presentation = resolveSubagentPresentation({
      title: "Subagent 019d8cae-0628-7bf1-bf86-5cbc31cd582c",
      fallbackId: "subagent:thread-1:019d8cae-0628-7bf1-bf86-5cbc31cd582c",
    });

    expect(presentation.primaryLabel).toBe("Subagent");
    expect(presentation.fullLabel).toBe("Subagent");
  });

  it("keeps the role parsed from a generic bracketed placeholder title", () => {
    const presentation = resolveSubagentPresentation({
      title: "Subagent [code reviewer]",
      fallbackId: "subagent:thread-1:toolu_01P6abc",
    });

    expect(presentation.role).toBe("code reviewer");
    expect(presentation.title).toBeNull();
    expect(presentation.primaryLabel).toBe("Code reviewer");
  });

  it("uses the caller placeholder when no identity is known", () => {
    const presentation = resolveSubagentPresentation({
      fallbackId: "toolu_01P6abc",
      placeholderLabel: "Starting subagent…",
    });

    expect(presentation.primaryLabel).toBe("Starting subagent…");
    expect(presentation.fullLabel).toBe("Starting subagent…");
  });

  it("keeps the accent color seeded by the provider id for anonymous rows", () => {
    const first = resolveSubagentPresentation({ fallbackId: "subagent:p:toolu_01P6abc" });
    const again = resolveSubagentPresentation({ fallbackId: "subagent:p:toolu_01P6abc" });

    expect(first.primaryLabel).toBe("Subagent");
    expect(first.accentColor).toBe(again.accentColor);
  });
});

describe("resolveSubagentPresentationForThread", () => {
  it("derives the nickname from the parent collab activity when thread metadata is still a placeholder", () => {
    const presentation = resolveSubagentPresentationForThread({
      thread: {
        id: "subagent:thread-1:child-provider-1",
        title: "Subagent 019d8cae-0628-7bf1-bf86-5cbc31cd582c",
        parentThreadId: "thread-1",
        subagentNickname: null,
        subagentRole: null,
      },
      threads: [
        {
          id: "thread-1",
          activities: [
            {
              payload: {
                data: {
                  item: {
                    receiverThreadIds: ["child-provider-1"],
                    receiverAgents: [
                      {
                        threadId: "child-provider-1",
                        agentNickname: "Locke",
                        agentRole: "explorer",
                      },
                    ],
                  },
                },
              },
            },
          ],
        },
      ],
    });

    expect(presentation.nickname).toBe("Locke");
    expect(presentation.role).toBe("explorer");
    expect(presentation.fullLabel).toBe("Locke [explorer]");
  });

  it("matches parent activity identity by agent id when the child thread id is namespaced locally", () => {
    const presentation = resolveSubagentPresentationForThread({
      thread: {
        id: "subagent:thread-1:child-provider-1",
        title: "Subagent child-provider-1",
        parentThreadId: "thread-1",
        subagentAgentId: "agent-1",
        subagentNickname: null,
        subagentRole: null,
      },
      threads: [
        {
          id: "thread-1",
          activities: [
            {
              payload: {
                data: {
                  item: {
                    agentStatuses: [
                      {
                        threadId: "child-provider-2",
                        agentId: "agent-1",
                        agentNickname: "Harper",
                        agentRole: "reviewer",
                      },
                    ],
                  },
                },
              },
            },
          ],
        },
      ],
    });

    expect(presentation.fullLabel).toBe("Harper [reviewer]");
  });

  it("keeps the earlier nickname when a later parent activity only carries sparse agent state", () => {
    const presentation = resolveSubagentPresentationForThread({
      thread: {
        id: "subagent:thread-1:child-provider-1",
        title: "Subagent child-provider-1",
        parentThreadId: "thread-1",
        subagentAgentId: "agent-1",
        subagentNickname: null,
        subagentRole: null,
      },
      threads: [
        {
          id: "thread-1",
          activities: [
            {
              payload: {
                data: {
                  item: {
                    receiverAgents: [
                      {
                        threadId: "child-provider-1",
                        agentId: "agent-1",
                        agentNickname: "Locke",
                        agentRole: "explorer",
                      },
                    ],
                  },
                },
              },
            },
            {
              payload: {
                data: {
                  item: {
                    agentStates: {
                      "child-provider-1": {
                        status: "completed",
                      },
                    },
                  },
                },
              },
            },
          ],
        },
      ],
    });

    expect(presentation.fullLabel).toBe("Locke [explorer]");
  });

  describe("anonymous children", () => {
    const codexChildProviderId = "01a107de-12ee-7240-9d16-abcdef012345";
    const codexChild = {
      id: `subagent:parent-1:${codexChildProviderId}`,
      title: `Subagent ${codexChildProviderId}`,
      parentThreadId: "parent-1",
      subagentNickname: null,
      subagentRole: null,
      createdAt: "2026-10-01T00:00:02.000Z",
    };
    const firstSibling = {
      id: "subagent:parent-1:00aa0000-0000-7000-8000-000000000000",
      title: "Subagent",
      parentThreadId: "parent-1",
      createdAt: "2026-10-01T00:00:01.000Z",
    };

    it("labels an existing Codex child from the parent's spawn prompt", () => {
      const presentation = resolveSubagentPresentationForThread({
        thread: codexChild,
        threads: [
          {
            id: "parent-1",
            activities: [
              {
                payload: {
                  data: {
                    item: {
                      type: "collabAgentToolCall",
                      tool: "spawnAgent",
                      receiverThreadIds: [codexChildProviderId],
                      prompt: "  Count lines of   calc.py \nthen report",
                    },
                  },
                },
              },
            ],
          },
          firstSibling,
          codexChild,
        ],
      });

      expect(presentation.primaryLabel).toBe("Count lines of calc.py");
      expect(presentation.fullLabel).toBe("Count lines of calc.py");
    });

    it("clips long spawn prompts like the server does for new child titles", () => {
      const prompt = `${"a".repeat(70)}\nsecond line`;
      const presentation = resolveSubagentPresentationForThread({
        thread: codexChild,
        threads: [
          {
            id: "parent-1",
            activities: [
              {
                payload: { data: { item: { receiverThreadIds: [codexChildProviderId], prompt } } },
              },
            ],
          },
        ],
      });

      expect(presentation.primaryLabel).toBe(`${"a".repeat(59)}…`);
    });

    it("numbers the child among its siblings when the parent has no prompt for it", () => {
      const presentation = resolveSubagentPresentationForThread({
        thread: codexChild,
        threads: [{ id: "parent-1", activities: [] }, codexChild, firstSibling],
      });

      expect(presentation.primaryLabel).toBe("Subagent 2");
      expect(presentation.primaryLabel).not.toContain(codexChildProviderId);
    });

    it("falls back to a neutral label when siblings cannot be determined", () => {
      const presentation = resolveSubagentPresentationForThread({
        thread: codexChild,
        threads: [{ id: "parent-1", activities: [] }],
      });

      expect(presentation.primaryLabel).toBe("Subagent");
    });

    it("never labels a Claude child by its tool_use id", () => {
      const presentation = resolveSubagentPresentationForThread({
        thread: {
          id: "subagent:p:toolu_01P6abc",
          title: "Subagent toolu_01P6abc",
          parentThreadId: "p",
        },
      });

      expect(presentation.primaryLabel).not.toContain("toolu_");
      expect(presentation.fullLabel).not.toContain("toolu_");
    });

    it("keeps nickname and role ahead of the spawn prompt", () => {
      const presentation = resolveSubagentPresentationForThread({
        thread: { ...codexChild, subagentNickname: "Locke", subagentRole: "explorer" },
        threads: [
          {
            id: "parent-1",
            activities: [
              {
                payload: {
                  data: {
                    item: { receiverThreadIds: [codexChildProviderId], prompt: "Count lines" },
                  },
                },
              },
            ],
          },
        ],
      });

      expect(presentation.fullLabel).toBe("Locke [explorer]");
    });
  });
});

describe("normalizeSubagentStatusKind", () => {
  it("maps common provider statuses into Remodex-style buckets", () => {
    expect(normalizeSubagentStatusKind("in_progress")).toBe("running");
    expect(normalizeSubagentStatusKind("completed")).toBe("completed");
    expect(normalizeSubagentStatusKind("errored")).toBe("failed");
    expect(normalizeSubagentStatusKind("interrupted")).toBe("stopped");
    expect(normalizeSubagentStatusKind("pending")).toBe("queued");
    expect(normalizeSubagentStatusKind("idle")).toBe("idle");
  });
});

describe("formatSubagentModelLabel", () => {
  it("drops the redundant Claude prefix for agent rows", () => {
    expect(formatSubagentModelLabel("claude-haiku-4-5-20251001")).toBe("Haiku 4.5");
    expect(formatSubagentModelLabel("claude-sonnet-4-6")).toBe("Sonnet 4.6");
    expect(formatSubagentModelLabel("haiku")).toBe("Haiku");
  });
});
