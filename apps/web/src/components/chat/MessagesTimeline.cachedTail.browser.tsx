// FILE: MessagesTimeline.cachedTail.browser.tsx
// Purpose: Browser regression for the IndexedDB cached-tail paint: a transcript
//          opened with cached rows keeps end-follow while the live snapshot
//          reconciles them by id, and a reader who left the bottom is not
//          re-pinned when the stale tail is replaced.
// Layer: Vitest browser tests

import "../../index.css";

import { MessageId } from "@synara/contracts";
import { type LegendListRef } from "@legendapp/list/react";
import { useRef, useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { MessagesTimeline } from "./MessagesTimeline";
import type { deriveTimelineEntries } from "../../session-logic";

type TimelineEntries = ReturnType<typeof deriveTimelineEntries>;

const VIEWPORT_HEIGHT_PX = 420;
// maintainScrollAtEnd re-sticks within its threshold rather than to the exact
// pixel bottom; anything within this tolerance counts as following the tail.
const AUTO_FOLLOW_TOLERANCE_PX = 96;

function messageEntry(
  id: string,
  role: "user" | "assistant",
  text: string,
): TimelineEntries[number] {
  return {
    id: `entry-${id}`,
    kind: "message",
    createdAt: "2026-03-17T19:12:28.000Z",
    message: {
      id: MessageId.makeUnsafe(id),
      role,
      text,
      createdAt: "2026-03-17T19:12:28.000Z",
      streaming: false,
    },
  };
}

function cachedTailEntries(): TimelineEntries {
  const entries: TimelineEntries = [];
  for (let index = 0; index < 8; index += 1) {
    entries.push(messageEntry(`cached-user-${index}`, "user", `Cached question ${index}.`));
    entries.push(
      messageEntry(
        `cached-assistant-${index}`,
        "assistant",
        `Cached tail row ${index}. ${"Settled response text. ".repeat(8)}`,
      ),
    );
  }
  // A stale row the server rolled back while the app was closed — the live
  // snapshot drops it during reconcile.
  entries.push(messageEntry("cached-stale", "assistant", "Stale rolled-back row."));
  return entries;
}

interface HarnessHandle {
  listRef: React.RefObject<LegendListRef | null>;
  reconcile: (entries: TimelineEntries) => void;
}

function CachedTailTimeline({ handleRef }: { handleRef: { current: HarnessHandle | null } }) {
  const listRef = useRef<LegendListRef | null>(null);
  const [entries, setEntries] = useState<TimelineEntries>(cachedTailEntries);

  handleRef.current = {
    listRef,
    // What the EventRouter applies once the authoritative snapshot lands:
    // same id space, the rolled-back row gone, one fresh row appended.
    reconcile: (next: TimelineEntries) => setEntries(next),
  };

  return (
    <div style={{ height: VIEWPORT_HEIGHT_PX }}>
      <MessagesTimeline
        hasMessages={entries.length > 0}
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        listRef={listRef}
        tailAnchorMessageId={null}
        followLiveOutput={false}
        timelineEntries={entries}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso="2026-03-17T19:12:30.000Z"
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="dark"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />
    </div>
  );
}

function getScrollContainer(): HTMLElement {
  const node = document.querySelector<HTMLElement>("[data-chat-scroll-container]");
  if (!node) {
    throw new Error("scroll container not available");
  }
  return node;
}

function distanceFromBottomPx(): number {
  const container = getScrollContainer();
  return container.scrollHeight - container.clientHeight - container.scrollTop;
}

async function settleFrames(count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await new Promise<void>((resolve) => {
      window.requestAnimationFrame(() => resolve());
    });
  }
}

function liveSnapshotEntries(): TimelineEntries {
  const entries = cachedTailEntries().filter(
    (entry) => entry.kind === "message" && entry.message.id !== "cached-stale",
  );
  entries.push(messageEntry("live-new", "assistant", "Fresh live row appended by the snapshot."));
  return entries;
}

describe("MessagesTimeline cached-tail paint", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("keeps end-follow while a painted cached tail is reconciled by the live snapshot", async () => {
    const handleRef: { current: HarnessHandle | null } = { current: null };
    const result = await render(<CachedTailTimeline handleRef={handleRef} />);
    try {
      const handle = handleRef.current!;
      await expect.poll(() => distanceFromBottomPx()).toBeLessThanOrEqual(AUTO_FOLLOW_TOLERANCE_PX);

      handle.reconcile(liveSnapshotEntries());
      await expect.poll(() => distanceFromBottomPx()).toBeLessThanOrEqual(AUTO_FOLLOW_TOLERANCE_PX);
      // The stale cached row is gone after reconcile.
      await expect
        .poll(() => document.querySelector('[data-message-id="cached-stale"]'))
        .toBeNull();
    } finally {
      await result.unmount();
    }
  });

  it("does not re-pin a reader scrolled away when the cached tail is replaced", async () => {
    const handleRef: { current: HarnessHandle | null } = { current: null };
    const result = await render(<CachedTailTimeline handleRef={handleRef} />);
    try {
      const handle = handleRef.current!;
      const container = getScrollContainer();
      await expect.poll(() => container.scrollHeight > container.clientHeight).toBe(true);

      // Reader scrolled up off the bottom before the snapshot lands: an
      // upward wheel gesture detaches follow, then the position moves up.
      container.dispatchEvent(new WheelEvent("wheel", { deltaY: -120, bubbles: true }));
      await settleFrames(2);
      container.scrollTop = 0;
      await settleFrames(2);
      handle.reconcile(liveSnapshotEntries());
      await settleFrames(3);
      expect(distanceFromBottomPx()).toBeGreaterThan(AUTO_FOLLOW_TOLERANCE_PX);
    } finally {
      await result.unmount();
    }
  });
});
