import "../../index.css";

import { MessageId } from "@synara/contracts";
import { useState } from "react";
import { page } from "vitest/browser";
import { expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { MessagesTimeline } from "./MessagesTimeline";

const createdAt = "2026-10-11T12:00:00.000Z";
const entries = [
  {
    id: "entry-working-status",
    kind: "message" as const,
    createdAt,
    message: {
      id: MessageId.makeUnsafe("working-status"),
      role: "user" as const,
      text: "Review the current build.",
      createdAt,
      streaming: false,
    },
  },
];

function WorkingStatusTimeline() {
  const [fontSize, setFontSize] = useState(13);
  const [workingLabel, setWorkingLabel] = useState<"Thinking" | "Checking message delivery…">(
    "Thinking",
  );
  return (
    <div>
      <button type="button" onClick={() => setFontSize(18)}>
        Increase chat font
      </button>
      <button type="button" onClick={() => setWorkingLabel("Checking message delivery…")}>
        Check delivery
      </button>
      <output data-testid="requested-presentation">
        {fontSize}px; {workingLabel}
      </output>
      <div style={{ height: 360, width: 640 }}>
        <MessagesTimeline
          hasMessages
          isWorking
          workingLabel={workingLabel}
          activeTurnInProgress
          activeTurnStartedAt={createdAt}
          timelineEntries={entries}
          turnDiffSummaryByAssistantMessageId={new Map()}
          nowIso="2026-10-11T12:00:02.000Z"
          expandedWorkGroups={{}}
          onToggleWorkGroup={() => {}}
          onOpenTurnDiff={() => {}}
          revertTurnCountByUserMessageId={new Map()}
          onRevertUserMessage={() => {}}
          isRevertingCheckpoint={false}
          onImageExpand={() => {}}
          markdownCwd={undefined}
          resolvedTheme="dark"
          chatFontSizePx={fontSize}
          timestampFormat="locale"
          workspaceRoot={undefined}
        />
      </div>
    </div>
  );
}

const working = () =>
  document.querySelector<HTMLElement>('[data-timeline-row-kind="working"] .shimmer-group');

it("updates the retained working row and transcript when chat font size changes", async () => {
  const screen = await render(<WorkingStatusTimeline />);
  try {
    await expect.poll(() => working()?.textContent).toBe("Thinking");
    expect(getComputedStyle(working()!).fontSize).toBe("13px");
    await page.getByRole("button", { name: "Increase chat font", exact: true }).click();
    await expect.element(page.getByTestId("requested-presentation")).toHaveTextContent("18px");
    await expect.poll(() => getComputedStyle(working()!).fontSize).toBe("18px");
    const user = document.querySelector<HTMLElement>('[data-message-role="user"] .chat-markdown')!;
    expect(getComputedStyle(user).fontSize).toBe("18px");
    const mark = working()!.querySelector<SVGSVGElement>("svg")!;
    expect(mark.getBoundingClientRect().width / 18).toBeCloseTo(1.08, 2);
    expect(mark.getBoundingClientRect().height / 18).toBeCloseTo(1.08, 2);
  } finally {
    await screen.unmount();
  }
});

it("updates the retained working label and semantic icon without a transcript change", async () => {
  const screen = await render(<WorkingStatusTimeline />);
  try {
    await expect.poll(() => working()?.textContent).toBe("Thinking");
    expect(working()!.querySelector('[data-synara-working-loader="true"]')).not.toBeNull();
    await page.getByRole("button", { name: "Check delivery", exact: true }).click();
    await expect
      .element(page.getByTestId("requested-presentation"))
      .toHaveTextContent("Checking message delivery…");
    await expect.poll(() => working()?.textContent).toBe("Checking message delivery…");
    expect(working()!.querySelector('[data-synara-working-loader="true"]')).toBeNull();
    expect(working()!.querySelector('svg[data-slot="hugeicon"]')).not.toBeNull();
  } finally {
    await screen.unmount();
  }
});
