// FILE: MessagesTimeline.markerScroll.browser.tsx
// Purpose: Browser regressions for marker deep-link scrolling in duplicated transcript panes.
// Layer: Vitest browser tests

import "../../index.css";

import { MessageId, ThreadMarkerId, type ThreadMarker } from "@synara/contracts";
import { createRef, type RefObject } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { MessagesTimeline, type MessagesTimelineController } from "./MessagesTimeline";

const ASSISTANT_MESSAGE_ID = MessageId.makeUnsafe("assistant-shared-marker-message");
const MARKER_ID = ThreadMarkerId.makeUnsafe("marker-shared-between-panes");
const MESSAGE_TEXT = "Before the exact marker text and after.";
const MARKER_TEXT = "exact marker text";
const MARKER_START_OFFSET = MESSAGE_TEXT.indexOf(MARKER_TEXT);

const marker: ThreadMarker = {
  id: MARKER_ID,
  messageId: ASSISTANT_MESSAGE_ID,
  startOffset: MARKER_START_OFFSET,
  endOffset: MARKER_START_OFFSET + MARKER_TEXT.length,
  selectedText: MARKER_TEXT,
  style: "highlight",
  color: "yellow",
  label: null,
  done: false,
  createdAt: "2026-06-06T00:00:00.000Z",
  updatedAt: "2026-06-06T00:00:00.000Z",
};

function MarkerTimeline({
  controllerRef,
}: {
  controllerRef: RefObject<MessagesTimelineController | null>;
}) {
  return (
    <MessagesTimeline
      hasMessages
      isWorking={false}
      activeTurnInProgress={false}
      activeTurnStartedAt={null}
      controllerRef={controllerRef}
      threadMarkers={[marker]}
      timelineEntries={[
        {
          id: `entry-${ASSISTANT_MESSAGE_ID}`,
          kind: "message",
          createdAt: "2026-06-06T00:00:00.000Z",
          message: {
            id: ASSISTANT_MESSAGE_ID,
            role: "assistant",
            text: MESSAGE_TEXT,
            createdAt: "2026-06-06T00:00:00.000Z",
            streaming: false,
          },
        },
      ]}
      turnDiffSummaryByAssistantMessageId={new Map()}
      nowIso="2026-06-06T00:00:01.000Z"
      expandedWorkGroups={{}}
      onToggleWorkGroup={() => {}}
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
  );
}

describe("MessagesTimeline marker fine-scroll", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("scrolls the marker inside the controller's own timeline pane", async () => {
    const leftControllerRef = createRef<MessagesTimelineController | null>();
    const rightControllerRef = createRef<MessagesTimelineController | null>();
    // Captured via a holder object so the outer-scope reads keep `Element | null` (a bare `let`
    // assigned only inside the mock callback narrows to `null` at use sites).
    const scrolled: { element: Element | null } = { element: null };
    vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(function scrollIntoViewMock(
      this: Element,
      _options?: boolean | ScrollIntoViewOptions,
    ) {
      scrolled.element = this;
    });

    await render(
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: "16px",
          height: "480px",
        }}
      >
        <section data-pane="left" style={{ minHeight: 0 }}>
          <MarkerTimeline controllerRef={leftControllerRef} />
        </section>
        <section data-pane="right" style={{ minHeight: 0 }}>
          <MarkerTimeline controllerRef={rightControllerRef} />
        </section>
      </div>,
    );

    await expect.poll(() => rightControllerRef.current !== null).toBe(true);
    rightControllerRef.current?.scrollToMarker(marker);

    await expect
      .poll(() => scrolled.element?.closest("[data-pane]")?.getAttribute("data-pane"))
      .toBe("right");
    expect(scrolled.element?.getAttribute("data-thread-marker-id")).toBe(MARKER_ID);
    // The deep-link "active" ring is decorated imperatively (no markdown re-parse) on the jumped span.
    expect(scrolled.element?.classList.contains("thread-marker-active")).toBe(true);
  });
});
