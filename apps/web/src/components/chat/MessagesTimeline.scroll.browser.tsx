import "../../index.css";

import { MessageId } from "@synara/contracts";
import { expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { MessagesTimeline } from "./MessagesTimeline";

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
