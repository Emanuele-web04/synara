import { MessageId, TurnId } from "@synara/contracts";
import { useRef } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

import { deriveTimelineEntries, type WorkLogEntry } from "../../session-logic";
import type { ChatMessage, ProposedPlan } from "../../types";

import { useTailAnchorScroll } from "./useTailAnchorScroll";

const ANCHOR_ID = MessageId.makeUnsafe("delayed-steer");

function DelayedLayout({
  contentRevision,
  messageRevision,
  onFinished,
}: {
  contentRevision: unknown;
  messageRevision: unknown;
  onFinished: () => void;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef({ getScrollableNode: (): HTMLElement => containerRef.current! });
  useTailAnchorScroll({
    listRef,
    timelineRootRef: rootRef,
    anchorMessageId: ANCHOR_ID,
    animateAnchorSlide: false,
    contentChangeSignal: contentRevision,
    messageChangeSignal: messageRevision,
    onAnchorSlideFinished: onFinished,
  });
  return (
    <div ref={rootRef}>
      <div
        ref={containerRef}
        data-testid="viewport"
        style={{ height: 200, overflow: "auto", overflowAnchor: "none" }}
      >
        <div data-testid="delayed-content" style={{ height: 300 }} />
        <div data-message-id={ANCHOR_ID} style={{ height: 20 }} />
        <div style={{ height: 180 }} />
      </div>
    </div>
  );
}

it("holds a steer while newly received content is still waiting for layout", async () => {
  vi.useFakeTimers({ toFake: ["performance", "requestAnimationFrame", "cancelAnimationFrame"] });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const onFinished = vi.fn();
  try {
    flushSync(() =>
      root.render(
        <DelayedLayout contentRevision={0} messageRevision={0} onFinished={onFinished} />,
      ),
    );
    await vi.advanceTimersByTimeAsync(400);
    const viewport = host.querySelector<HTMLElement>('[data-testid="viewport"]')!;
    const anchor = host.querySelector<HTMLElement>(`[data-message-id="${ANCHOR_ID}"]`)!;
    const offset = () => anchor.getBoundingClientRect().top - viewport.getBoundingClientRect().top;
    expect(Math.abs(offset())).toBeLessThanOrEqual(1);

    // A new chunk reaches React before deferred Markdown changes the row height.
    flushSync(() =>
      root.render(
        <DelayedLayout contentRevision={1} messageRevision={1} onFinished={onFinished} />,
      ),
    );
    await vi.advanceTimersByTimeAsync(200);
    expect(onFinished).not.toHaveBeenCalled();

    host.querySelector<HTMLElement>('[data-testid="delayed-content"]')!.style.height = "350px";
    await vi.advanceTimersByTimeAsync(16);
    expect(Math.abs(offset())).toBeLessThanOrEqual(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(onFinished).toHaveBeenCalledTimes(1);
  } finally {
    flushSync(() => root.unmount());
    host.remove();
    vi.useRealTimers();
  }
});

it("does not let tool or work activity extend the anchor hold", async () => {
  vi.useFakeTimers({ toFake: ["performance", "requestAnimationFrame", "cancelAnimationFrame"] });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const onFinished = vi.fn();
  try {
    flushSync(() =>
      root.render(
        <DelayedLayout contentRevision={0} messageRevision={0} onFinished={onFinished} />,
      ),
    );
    await vi.advanceTimersByTimeAsync(400);
    expect(onFinished).not.toHaveBeenCalled();

    // Tool or work activity updates the full timeline without a new message.
    flushSync(() =>
      root.render(
        <DelayedLayout contentRevision={1} messageRevision={0} onFinished={onFinished} />,
      ),
    );
    await vi.advanceTimersByTimeAsync(50);
    expect(onFinished).not.toHaveBeenCalled();

    // The original message hold window should expire; the work activity did not restart it.
    await vi.advanceTimersByTimeAsync(200);
    expect(onFinished).toHaveBeenCalledTimes(1);
  } finally {
    flushSync(() => root.unmount());
    host.remove();
    vi.useRealTimers();
  }
});

const SEGMENT_DATE = "2026-09-13T00:00:00.000Z";
const segmentedMessages: ChatMessage[] = [
  {
    id: MessageId.makeUnsafe("segmented-assistant"),
    role: "assistant",
    text: "ABCD",
    createdAt: SEGMENT_DATE,
    turnId: TurnId.makeUnsafe("plan-turn"),
    streaming: false,
    textSegments: ["A", "B", "C", "D"].map((text, index) => ({
      text,
      sequence: index * 10,
      startedAt: SEGMENT_DATE,
      endedAt: SEGMENT_DATE,
    })),
  },
];
const segmentPlans: ProposedPlan[] = [
  {
    id: "plan",
    turnId: TurnId.makeUnsafe("plan-turn"),
    planMarkdown: "# Plan",
    createdAt: SEGMENT_DATE,
    updatedAt: SEGMENT_DATE,
    implementedAt: null,
    implementationThreadId: null,
  },
];
const segmentWork: WorkLogEntry = {
  id: "intervening-tool",
  label: "Running tool",
  tone: "tool",
  sequence: 15,
  createdAt: SEGMENT_DATE,
};

function SourceMessageLayout({
  messages,
  plans,
  work,
  onFinished,
}: {
  messages: ChatMessage[];
  plans: ProposedPlan[];
  work: WorkLogEntry[];
  onFinished: () => void;
}) {
  // Match ChatView: the message signal comes from the source array, before
  // plans and work rows clone or split its presentation entries.
  const entries = deriveTimelineEntries(messages, plans, work);
  return (
    <DelayedLayout contentRevision={entries} messageRevision={messages} onFinished={onFinished} />
  );
}

it.each(["plan-linked segment clones", "late tool insertion"])(
  "releases the message hold despite %s",
  async (scenario) => {
    vi.useFakeTimers({ toFake: ["performance", "requestAnimationFrame", "cancelAnimationFrame"] });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const onFinished = vi.fn();
    const plans = scenario === "plan-linked segment clones" ? segmentPlans : [];
    const initialWork = scenario === "plan-linked segment clones" ? [segmentWork] : [];
    try {
      flushSync(() =>
        root.render(
          <SourceMessageLayout
            messages={segmentedMessages}
            plans={plans}
            work={initialWork}
            onFinished={onFinished}
          />,
        ),
      );
      await vi.advanceTimersByTimeAsync(400);
      flushSync(() =>
        root.render(
          <SourceMessageLayout
            messages={segmentedMessages}
            plans={plans}
            work={[{ ...segmentWork, label: "Tool completed" }]}
            onFinished={onFinished}
          />,
        ),
      );
      await vi.advanceTimersByTimeAsync(250);
      expect(onFinished).toHaveBeenCalledTimes(1);
    } finally {
      flushSync(() => root.unmount());
      host.remove();
      vi.useRealTimers();
    }
  },
);
