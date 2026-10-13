import "../../index.css";

import { MessageId } from "@synara/contracts";
import { expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { MessagesTimeline } from "./MessagesTimeline";

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

it.each([960, 430])(
  "keeps a static transcript vertical at %ipx while wide code scrolls independently",
  async (width) => {
    const now = "2026-10-04T12:00:00.000Z";
    const code = "long_identifier_".repeat(80);
    const result = await render(
      <div style={{ width, height: 400 }}>
        <MessagesTimeline
          hasMessages
          isWorking={false}
          activeTurnInProgress={false}
          activeTurnStartedAt={null}
          timelineEntries={[
            {
              id: "static-reply",
              kind: "message",
              createdAt: now,
              message: {
                id: MessageId.makeUnsafe("static-reply"),
                role: "assistant",
                text: `A static reply.\n\n\`\`\`text\n${code}\n\`\`\`\n\n${"More reply text.\n\n".repeat(30)}`,
                createdAt: now,
                streaming: false,
              },
            },
          ]}
          turnDiffSummaryByAssistantMessageId={new Map()}
          nowIso={now}
          onOpenTurnDiff={() => {}}
          revertTurnCountByUserMessageId={new Map()}
          onRevertUserMessage={() => {}}
          isRevertingCheckpoint={false}
          onImageExpand={() => {}}
          markdownCwd={undefined}
          resolvedTheme="light"
          timestampFormat="locale"
          workspaceRoot={undefined}
        />
      </div>,
    );

    try {
      await expect.poll(() => document.querySelector("pre code")?.textContent).toContain(code);
      const transcript = document.querySelector<HTMLElement>("[data-chat-scroll-container]")!;
      const codeBlock = transcript.querySelector<HTMLElement>("pre")!;

      // Check the rendered scroll policy: dependency inline styles can override
      // the transcript's CSS class even when this particular reply fits.
      expect(getComputedStyle(transcript).overflowX).toBe("hidden");
      expect(getComputedStyle(transcript).overflowY).toBe("auto");
      await expect.poll(() => transcript.scrollHeight).toBeGreaterThan(transcript.clientHeight);
      transcript.scrollTop = 0;
      transcript.scrollTop = 100;
      expect(transcript.scrollTop).toBeGreaterThan(0);

      await expect.poll(() => codeBlock.scrollWidth).toBeGreaterThan(codeBlock.clientWidth);
      codeBlock.scrollLeft = 100;
      expect(codeBlock.scrollLeft).toBeGreaterThan(0);
      expect(transcript.scrollLeft).toBe(0);
    } finally {
      await result.unmount();
    }
  },
);

it("keeps attached follow through a large measured tail growth and yields to reader detachment", async () => {
  const now = "2026-10-04T12:00:00.000Z";
  const timeline = (text: string, following: boolean) => (
    <div style={{ width: 500, height: 400 }}>
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        followLiveOutput={following}
        timelineEntries={[
          {
            id: "growing-reply",
            kind: "message",
            createdAt: now,
            message: {
              id: MessageId.makeUnsafe("growing-reply"),
              role: "assistant",
              text,
              createdAt: now,
              streaming: true,
            },
          },
        ]}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso={now}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />
    </div>
  );
  const screen = await render(timeline("Initial paragraph.\n\n".repeat(30), true));
  try {
    await expect
      .poll(() => document.querySelector<HTMLElement>("[data-chat-scroll-container]"))
      .not.toBeNull();
    const node = document.querySelector<HTMLElement>("[data-chat-scroll-container]")!;
    await expect.poll(() => node.scrollHeight).toBeGreaterThan(node.clientHeight);
    await expect
      .poll(() => node.scrollHeight - node.clientHeight - node.scrollTop)
      .toBeLessThanOrEqual(4);
    const tail = node.querySelector<HTMLElement>("[data-message-id='growing-reply'] p:last-child")!;
    tail.style.paddingBottom = "1800px";
    await expect
      .poll(() => node.scrollHeight - node.clientHeight - node.scrollTop)
      .toBeLessThanOrEqual(4);
    tail.style.paddingBottom = "";
    await screen.rerender(timeline("Large new paragraph.\n\n".repeat(100), true));
    await expect
      .poll(
        () =>
          Array.from(node.querySelectorAll("[data-message-id='growing-reply'] p")).filter(
            (p) => p.textContent === "Large new paragraph.",
          ).length,
      )
      .toBe(100);
    await expect
      .poll(() => node.scrollHeight - node.clientHeight - node.scrollTop)
      .toBeLessThanOrEqual(4);
    await screen.rerender(timeline("Large new paragraph.\n\n".repeat(100), false));
    node.scrollTop = 200;
    node.dispatchEvent(new Event("scroll"));
    const readingTop = node.scrollTop;
    await screen.rerender(timeline("Large new paragraph.\n\n".repeat(140), false));
    await expect
      .poll(
        () =>
          Array.from(node.querySelectorAll("[data-message-id='growing-reply'] p")).filter(
            (p) => p.textContent === "Large new paragraph.",
          ).length,
      )
      .toBe(140);
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    expect(node.scrollTop).toBeCloseTo(readingTop, 0);
  } finally {
    await screen.unmount();
  }
});

it("reveals a remounted transcript of measured rows without waiting for a timer fallback", async () => {
  const now = "2026-10-04T12:00:00.000Z";
  const rowCount = 24;
  const timeline = (
    <div style={{ width: 500, height: 400 }}>
      <MessagesTimeline
        hasMessages
        heightCacheScope="measured-transcript"
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        // The floating composer inset puts the end target past what the scroller can
        // reach, so the remount's instant scroll leaves it pinned at its native end.
        contentInsetBottomPx={48}
        timelineEntries={Array.from({ length: rowCount }, (_, index) => ({
          id: `measured-${index}`,
          kind: "message" as const,
          createdAt: now,
          message: {
            id: MessageId.makeUnsafe(`measured-${index}`),
            role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
            text: `Turn ${index}.\n\n${"Paragraph text.\n\n".repeat(1 + (index % 4))}`,
            createdAt: now,
            streaming: false,
          },
        }))}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso={now}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />
    </div>
  );
  const lastRowVisible = () =>
    document
      .querySelector(`[data-message-id='measured-${rowCount - 1}']`)
      ?.checkVisibility({ opacityProperty: true }) ?? false;

  // Read the whole history once so every row height is remembered for the remount.
  const first = await render(timeline);
  await expect.poll(lastRowVisible).toBe(true);
  const node = document.querySelector<HTMLElement>("[data-chat-scroll-container]")!;
  for (let top = node.scrollTop; top > 0; top -= 200) {
    node.scrollTop = Math.max(0, top - 200);
    await nextFrame();
    await nextFrame();
  }
  await first.unmount();

  // Hold back every timer fallback: the remounted list must reveal from its own frame check.
  const originalSetTimeout = window.setTimeout;
  window.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]) =>
    (delay ?? 0) >= 100
      ? 0
      : originalSetTimeout(handler, delay, ...args)) as typeof window.setTimeout;
  let screen: Awaited<ReturnType<typeof render>> | null = null;
  try {
    screen = await render(timeline);
    let frames = 0;
    while (!lastRowVisible() && frames < 30) {
      await nextFrame();
      frames += 1;
    }
    expect(lastRowVisible()).toBe(true);
    const remounted = document.querySelector<HTMLElement>("[data-chat-scroll-container]")!;
    expect(
      remounted.scrollHeight - remounted.clientHeight - remounted.scrollTop,
    ).toBeLessThanOrEqual(1);
  } finally {
    window.setTimeout = originalSetTimeout;
    await screen?.unmount();
  }
});
