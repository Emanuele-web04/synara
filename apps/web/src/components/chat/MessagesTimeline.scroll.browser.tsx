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
