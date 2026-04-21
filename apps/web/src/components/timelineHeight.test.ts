import { describe, expect, it } from "vitest";

import { appendTerminalContextsToPrompt } from "../lib/terminalContext";
import { buildInlineTerminalContextText } from "./chat/userMessageTerminalContexts";
import {
  estimateChangedFilesSummaryHeight,
  estimateTimelineMessageHeight,
  estimateTimelineWorkGroupHeight,
} from "./timelineHeight";

describe("estimateTimelineMessageHeight", () => {
  it("uses assistant sizing rules for assistant messages", () => {
    expect(
      estimateTimelineMessageHeight({
        role: "assistant",
        text: "a".repeat(144),
      }),
    ).toBe(118);
  });

  it("uses assistant sizing rules for system messages", () => {
    expect(
      estimateTimelineMessageHeight({
        role: "system",
        text: "a".repeat(144),
      }),
    ).toBe(118);
  });

  it("adds one attachment row for one or two user attachments", () => {
    expect(
      estimateTimelineMessageHeight({
        role: "user",
        text: "hello",
        attachments: [{ id: "1", type: "image" }],
      }),
    ).toBe(181);

    expect(
      estimateTimelineMessageHeight({
        role: "user",
        text: "hello",
        attachments: [
          { id: "1", type: "image" },
          { id: "2", type: "image" },
        ],
      }),
    ).toBe(181);
  });

  it("adds a second attachment row for three or four user attachments", () => {
    expect(
      estimateTimelineMessageHeight({
        role: "user",
        text: "hello",
        attachments: [
          { id: "1", type: "image" },
          { id: "2", type: "image" },
          { id: "3", type: "image" },
        ],
      }),
    ).toBe(181);

    expect(
      estimateTimelineMessageHeight({
        role: "user",
        text: "hello",
        attachments: [
          { id: "1", type: "image" },
          { id: "2", type: "image" },
          { id: "3", type: "image" },
          { id: "4", type: "image" },
        ],
      }),
    ).toBe(181);
  });

  it("caps long user message estimates to the collapsed preview", () => {
    expect(
      estimateTimelineMessageHeight({
        role: "user",
        text: "a".repeat(56 * 120),
      }),
    ).toBe(337);
  });

  it("counts explicit newlines for user message estimates", () => {
    expect(
      estimateTimelineMessageHeight({
        role: "user",
        text: "first\nsecond\nthird",
      }),
    ).toBe(157);
  });

  it("adds terminal context chrome without counting the hidden block as message text", () => {
    const prompt = appendTerminalContextsToPrompt("Investigate this", [
      {
        terminalId: "default",
        terminalLabel: "Terminal 1",
        lineStart: 40,
        lineEnd: 43,
        text: [
          "git status",
          "M apps/web/src/components/chat/MessagesTimeline.tsx",
          "?? tmp",
          "",
        ].join("\n"),
      },
    ]);

    expect(
      estimateTimelineMessageHeight({
        role: "user",
        text: prompt,
      }),
    ).toBe(
      estimateTimelineMessageHeight({
        role: "user",
        text: `${buildInlineTerminalContextText([{ header: "Terminal 1 lines 40-43" }])} Investigate this`,
      }),
    );
  });

  it("uses narrower width to increase user line wrapping", () => {
    const message = {
      role: "user" as const,
      text: "a".repeat(52),
    };

    expect(estimateTimelineMessageHeight(message, { timelineWidthPx: 320 })).toBe(137);
    expect(estimateTimelineMessageHeight(message, { timelineWidthPx: 768 })).toBe(117);
  });

  it("does not clamp user wrapping too aggressively on very narrow layouts", () => {
    const message = {
      role: "user" as const,
      text: "a".repeat(20),
    };

    expect(estimateTimelineMessageHeight(message, { timelineWidthPx: 100 })).toBe(157);
    expect(estimateTimelineMessageHeight(message, { timelineWidthPx: 320 })).toBe(117);
  });

  it("uses narrower width to increase assistant line wrapping", () => {
    const message = {
      role: "assistant" as const,
      text: "a".repeat(200),
    };

    expect(estimateTimelineMessageHeight(message, { timelineWidthPx: 320 })).toBe(158);
    expect(estimateTimelineMessageHeight(message, { timelineWidthPx: 768 })).toBe(118);
  });

  it("adds diff summary chrome to assistant message estimates", () => {
    expect(
      estimateTimelineMessageHeight(
        {
          role: "assistant",
          text: "done",
          diffSummaryFiles: [{ path: "src/index.ts", additions: 3, deletions: 1 }],
        },
        { timelineWidthPx: 768 },
      ),
    ).toBe(224);
  });

  it("accounts for inline code spans that wrap wider than plain text", () => {
    expect(
      estimateTimelineMessageHeight(
        {
          role: "assistant",
          text: "`0123456789012345678901234567890123456789`",
        },
        { timelineWidthPx: 120 },
      ),
    ).toBeGreaterThan(
      estimateTimelineMessageHeight(
        {
          role: "assistant",
          text: "0123456789012345678901234567890123456789",
        },
        { timelineWidthPx: 120 },
      ),
    );
  });

  it("accounts for the completion divider in assistant message estimates", () => {
    expect(
      estimateTimelineMessageHeight(
        {
          role: "assistant",
          text: "done",
          showCompletionDivider: true,
        },
        { timelineWidthPx: 768 },
      ),
    ).toBe(138);
  });
});

describe("estimateChangedFilesSummaryHeight", () => {
  it("grows when nested directories are expanded", () => {
    const files = [
      { path: "apps/web/src/index.ts", additions: 1, deletions: 0 },
      { path: "apps/web/src/components/Button.tsx", additions: 2, deletions: 1 },
    ];

    expect(estimateChangedFilesSummaryHeight(files, false)).toBe(100);
    expect(estimateChangedFilesSummaryHeight(files, true)).toBe(178);
  });
});

describe("estimateTimelineWorkGroupHeight", () => {
  it("caps collapsed work groups to the visible tail entries", () => {
    const entries = Array.from({ length: 8 }, (_, index) => ({
      tone: "tool" as const,
      detail: `detail-${index}`,
    }));

    expect(
      estimateTimelineWorkGroupHeight(entries, {
        expanded: false,
        maxVisibleEntries: 6,
      }),
    ).toBe(234);
    expect(
      estimateTimelineWorkGroupHeight(entries, {
        expanded: true,
        maxVisibleEntries: 6,
      }),
    ).toBe(298);
  });

  it("adds room for changed-file chips in work log rows", () => {
    expect(
      estimateTimelineWorkGroupHeight(
        [
          {
            tone: "tool",
            detail: "Updated files",
            changedFiles: ["src/a.ts", "src/b.ts"],
          },
        ],
        {
          expanded: true,
          maxVisibleEntries: 6,
        },
      ),
    ).toBe(78);
  });
});
