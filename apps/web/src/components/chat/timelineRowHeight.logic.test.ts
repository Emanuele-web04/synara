import { MessageId } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import type { MessagesTimelineRow } from "./MessagesTimeline.logic";
import {
  createTimelineRowHeightEstimator,
  estimateTimelineRowHeight,
  rememberTimelineRowHeight,
} from "./timelineRowHeight.logic";

const CACHE = { namespace: "plain-chat" };

const LAYOUT = { rowWidthPx: 736, chatFontSizePx: 13 };

function messageRow(id: string, role: "user" | "assistant", text: string): MessagesTimelineRow {
  return {
    kind: "message",
    id,
    createdAt: "2026-10-11T12:00:00.000Z",
    message: {
      id: MessageId.makeUnsafe(id),
      role,
      text,
      createdAt: "2026-10-11T12:00:00.000Z",
      streaming: false,
    },
    durationStart: "2026-10-11T12:00:00.000Z",
    showAssistantCopyButton: role === "assistant",
    assistantCopyStreaming: false,
  };
}

const paragraph = "Representative transcript prose that wraps across the chat column. ".repeat(6);

describe("estimateTimelineRowHeight", () => {
  it("grows with wrapped prose, blank lines and code fences", () => {
    const short = estimateTimelineRowHeight(messageRow("a", "assistant", "Done."), LAYOUT);
    const prose = estimateTimelineRowHeight(
      messageRow("b", "assistant", `${paragraph}\n\n${paragraph}`),
      LAYOUT,
    );
    const withCode = estimateTimelineRowHeight(
      messageRow(
        "c",
        "assistant",
        `${paragraph}\n\n${paragraph}\n\n\`\`\`ts\n${"x;\n".repeat(20)}\`\`\``,
      ),
      LAYOUT,
    );
    expect(short).toBeLessThan(prose);
    expect(prose).toBeLessThan(withCode);
    // A long answer is several times the old fixed 90px guess.
    expect(prose).toBeGreaterThan(180);
  });

  it("scales with the chat font size", () => {
    const user = estimateTimelineRowHeight(messageRow("u", "user", paragraph.repeat(3)), LAYOUT);
    const larger = estimateTimelineRowHeight(messageRow("u", "user", paragraph.repeat(3)), {
      ...LAYOUT,
      chatFontSizePx: 18,
    });
    expect(larger).toBeGreaterThan(user);
  });
});

describe("createTimelineRowHeightEstimator", () => {
  it("prefers a height measured in an earlier mount for the same layout", () => {
    const row = messageRow("remembered-row", "assistant", paragraph);
    const estimate = createTimelineRowHeightEstimator(() => LAYOUT, CACHE);
    const estimated = estimate(row);

    rememberTimelineRowHeight(row.id, LAYOUT, estimated + 333, { ...CACHE, row });

    expect(createTimelineRowHeightEstimator(() => LAYOUT, CACHE)(row)).toBe(estimated + 333);
    // A different column width cannot reuse that measurement.
    expect(
      createTimelineRowHeightEstimator(() => ({ ...LAYOUT, rowWidthPx: 420 }), CACHE)(row),
    ).not.toBe(estimated + 333);
  });

  it("re-estimates when the layout changes", () => {
    const row = messageRow("layout-row", "assistant", paragraph.repeat(4));
    let layout = LAYOUT;
    const estimate = createTimelineRowHeightEstimator(() => layout);
    const wide = estimate(row);
    layout = { ...LAYOUT, rowWidthPx: 360 };
    expect(estimate(row)).toBeGreaterThan(wide);
  });
  it("does not reuse another thread's measurement for a matching row id", () => {
    const row = messageRow("shared-id", "assistant", "Done.");
    rememberTimelineRowHeight(row.id, LAYOUT, 500, { namespace: "thread-a", row });
    expect(
      createTimelineRowHeightEstimator(() => LAYOUT, { namespace: "thread-b" })(row),
    ).toBeLessThan(100);
  });
  it("re-estimates content that grew while the thread was not mounted", () => {
    const row = messageRow("grown-row", "assistant", "Done.");
    rememberTimelineRowHeight(row.id, LAYOUT, 72, { ...CACHE, row });
    const changed = messageRow(row.id, "assistant", paragraph.repeat(20));
    expect(createTimelineRowHeightEstimator(() => LAYOUT, CACHE)(changed)).toBeGreaterThan(1000);
  });
  it("does not carry an expanded user message into a collapsed remount", () => {
    const row = messageRow("expanded-row", "user", "word ".repeat(300));
    rememberTimelineRowHeight(row.id, LAYOUT, 2000, { ...CACHE, row, allowed: false });
    expect(createTimelineRowHeightEstimator(() => LAYOUT, CACHE)(row)).toBeLessThan(500);
  });
  it("does not persist synthetic worktree rows with mutable steps", () => {
    const row: MessagesTimelineRow = {
      kind: "worktree-setup",
      id: "worktree-setup-row",
      steps: [],
      open: true,
    };
    rememberTimelineRowHeight(row.id, LAYOUT, 1000, { ...CACHE, row });
    expect(createTimelineRowHeightEstimator(() => LAYOUT, CACHE)(row)).toBeLessThan(100);
  });
  it("bounds estimation to the prefix instead of scanning unseen text", () => {
    const prefix = "Bounded prose text. ".repeat(300).slice(0, 4096);
    const prose = messageRow("budget-prose", "assistant", prefix + "a".repeat(1_000_000));
    const breaks = messageRow("budget-breaks", "assistant", prefix + "\n".repeat(1_000_000));
    expect(estimateTimelineRowHeight(prose, LAYOUT)).toBe(
      estimateTimelineRowHeight(breaks, LAYOUT),
    );
  });
});
