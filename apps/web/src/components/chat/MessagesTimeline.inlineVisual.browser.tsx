import "../../index.css";

import type { LegendListRef } from "@legendapp/list/react";
import { MessageId, type NativeApi, ThreadId, TurnId } from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useRef } from "react";
import { userEvent } from "vitest/browser";
import { afterEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import type { TimelineEntry } from "../../session-logic";
import { MessagesTimeline } from "./MessagesTimeline";
import { useChatTranscriptScroll } from "./useChatTranscriptScroll";

vi.mock("~/env", () => ({ isElectron: true }));

const THREAD_ID = ThreadId.makeUnsafe("thread-visual-follow");
const NOW = "2026-10-12T12:00:00.000Z";
const VISUAL = {
  visualId: `vis_${"9".repeat(32)}`,
  title: "Growing chart",
  height: 120,
  byteLength: 300,
  sha256: "e".repeat(64),
};
// The page grows when the test asks, the way a chart grows once its data
// renders. It reports readiness through the only channel it has.
const GROWING_PAGE = `<div id="box" style="height:200px;background:var(--series-1)">chart body</div><script>
  addEventListener("message", (event) => {
    if (event.data && typeof event.data.grow === "number") box.style.height = event.data.grow + "px";
    // A reader's wheel over the page, as the page's own document sees it.
    if (event.data && event.data.wheel) dispatchEvent(new WheelEvent("wheel", { deltaY: event.data.wheel }));
  });
  addEventListener("load", () => parent.postMessage({ probe: "visual-ready" }, "*"));
</script>`;

const baseEntries: TimelineEntry[] = [
  {
    id: "entry-reply",
    kind: "message",
    createdAt: NOW,
    message: {
      id: MessageId.makeUnsafe("reply"),
      role: "assistant",
      text: "Measured every package.\n\n".repeat(40),
      createdAt: NOW,
      streaming: false,
    },
  },
  {
    id: "entry-visual",
    kind: "work",
    createdAt: "2026-10-12T12:00:01.000Z",
    entry: {
      id: "visual",
      createdAt: "2026-10-12T12:00:01.000Z",
      label: "Visual: Growing chart",
      tone: "info",
      activityKind: "visual.shown",
      inlineVisual: VISUAL,
    },
  },
];
interface TurnState {
  readonly timelineEntries: TimelineEntry[];
  readonly activeTurnId?: TurnId;
  readonly activeTurnStartedAt?: string;
}

/** The transcript as ChatView wires it: the real follow hook drives the list. */
function Transcript({ turn = { timelineEntries: baseEntries } }: { turn?: TurnState }) {
  const listRef = useRef<LegendListRef | null>(null);
  const working = turn.activeTurnId !== undefined;
  const scroll = useChatTranscriptScroll({
    activeThreadId: THREAD_ID,
    legendListRef: listRef,
    timelineEntries: turn.timelineEntries,
    hasStreamingAssistantText: working,
    composerTranscriptInsetPx: 0,
    isInactiveSplitPane: false,
  });
  return (
    <div
      style={{ width: 640, height: 420 }}
      data-follow={scroll.isUserScrollDetached ? "detached" : "following"}
    >
      <MessagesTimeline
        hasMessages
        isWorking={working}
        activeTurnInProgress={working}
        activeTurnStartedAt={turn.activeTurnStartedAt ?? null}
        {...(turn.activeTurnId ? { activeTurnId: turn.activeTurnId } : {})}
        listRef={listRef}
        threadId={THREAD_ID}
        followLiveOutput={!scroll.isUserScrollDetached}
        onIsAtEndChange={scroll.onIsAtEndChange}
        onMessagesScroll={scroll.onMessagesScrollBase}
        onMessagesWheel={scroll.onMessagesWheelBase}
        onMessagesPointerDown={scroll.onMessagesPointerDownBase}
        onMessagesPointerUp={scroll.onMessagesPointerUpBase}
        onEmbeddedScrollIntent={scroll.onEmbeddedScrollIntent}
        timelineEntries={turn.timelineEntries}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso={NOW}
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
}

let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => {
  await cleanup?.();
  cleanup = null;
  vi.unstubAllGlobals();
});

async function mountTranscript() {
  vi.stubGlobal("nativeApi", {
    orchestration: {
      getInlineVisual: vi.fn(async () => ({ visualId: VISUAL.visualId, html: GROWING_PAGE })),
    },
  } as unknown as NativeApi);
  let ready = false;
  const onReady = (event: MessageEvent) => {
    if (event.data?.probe === "visual-ready") ready = true;
  };
  window.addEventListener("message", onReady);
  const client = new QueryClient();
  const screen = await render(
    <QueryClientProvider client={client}>
      <Transcript />
    </QueryClientProvider>,
  );
  cleanup = async () => {
    window.removeEventListener("message", onReady);
    await screen.unmount();
    client.clear();
  };
  await expect.poll(() => ready).toBe(true);
  const list = document.querySelector<HTMLElement>("[data-chat-scroll-container]")!;
  const frame = document.querySelector<HTMLIFrameElement>("iframe[data-inline-visual-frame]")!;
  await expect.poll(() => frame.getBoundingClientRect().height).toBe(200);
  const distanceFromEnd = () => list.scrollHeight - list.clientHeight - list.scrollTop;
  const grow = async (height: number) => {
    frame.contentWindow!.postMessage({ grow: height }, "*");
    await expect.poll(() => frame.getBoundingClientRect().height).toBe(height);
    // Let the list re-measure and settle before reading its position.
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 50))),
    );
  };
  return { list, frame, distanceFromEnd, grow, followState };
}

const followState = () =>
  document.querySelector("[data-follow]")?.getAttribute("data-follow") ?? null;

it("keeps a reader at the end while a visual grows", async () => {
  const { distanceFromEnd, grow } = await mountTranscript();
  await expect.poll(distanceFromEnd).toBeLessThanOrEqual(4);

  await grow(900);

  await expect.poll(distanceFromEnd).toBeLessThanOrEqual(4);
});

it("leaves a reader who scrolled up in place while a visual grows", async () => {
  const { list, distanceFromEnd, grow } = await mountTranscript();
  await expect.poll(distanceFromEnd).toBeLessThanOrEqual(4);

  // Not so far that the visual leaves the viewport: Chromium throttles
  // rendering in off-screen cross-origin frames, so they report no growth.
  await userEvent.wheel(list, { delta: { y: -120 } });
  await expect.poll(distanceFromEnd).toBeGreaterThan(60);
  const readingTop = list.scrollTop;
  const readingDistance = distanceFromEnd();

  await grow(900);

  // The reader stays put; the 700px of growth all lands below them.
  expect(list.scrollTop).toBeCloseTo(readingTop, 0);
  expect(distanceFromEnd()).toBeCloseTo(readingDistance + 700, 0);
});

it("releases follow when the reader scrolls up over a visual", async () => {
  const { list, frame, distanceFromEnd, grow, followState } = await mountTranscript();
  await expect.poll(distanceFromEnd).toBeLessThanOrEqual(4);
  expect(followState()).toBe("following");

  // Trusted wheel input over the iframe exercises actual browser ancestor scroll chaining.
  await userEvent.wheel(frame, { delta: { y: -120 } });
  await expect.poll(distanceFromEnd).toBeGreaterThan(60);
  // Detached exactly as a wheel on the transcript would leave it, so the
  // next message cannot snap the reader back.
  await expect.poll(followState).toBe("detached");
  const readingTop = list.scrollTop;

  await grow(900);

  expect(list.scrollTop).toBeCloseTo(readingTop, 0);
  expect(followState()).toBe("detached");
});

const TURN_ID = TurnId.makeUnsafe("turn-visual");
const at = (second: number) => `2026-10-12T12:01:0${second}.000Z`;
const TURN_VISUAL = { ...VISUAL, visualId: `vis_${"7".repeat(32)}`, title: "Budget" };
// The page keeps a value the reader set and reports it when asked.
const TURN_PAGE = `<p style="height:160px">budget tool</p><script>
  let value = 0;
  addEventListener("message", (event) => {
    if (event.data && typeof event.data.set === "number") value = event.data.set;
    if (event.data && event.data.ask) parent.postMessage({ probe: "value", value }, "*");
  });
  parent.postMessage({ probe: "visual-ready" }, "*");
</script>`;

const ANSWER_LEAD = "Two dependencies are over budget.";
const ANSWER_TAIL = "Trim them first.";

/**
 * A turn that publishes a visual, live (answer streaming) or settled. The
 * answer places the visual between its two paragraphs unless `placed` is false.
 */
function turnEntries(settled: boolean, placed = true): TimelineEntry[] {
  return [
    {
      id: "entry-request",
      kind: "message",
      createdAt: at(0),
      message: {
        id: MessageId.makeUnsafe("request"),
        role: "user",
        text: "Check the bundle budget.",
        createdAt: at(0),
        streaming: false,
        turnId: TURN_ID,
      },
    },
    {
      id: "entry-tool",
      kind: "work",
      createdAt: at(1),
      entry: {
        id: "tool",
        createdAt: at(1),
        label: "Read bundle stats",
        tone: "tool",
        turnId: TURN_ID,
      },
    },
    {
      id: "entry-turn-visual",
      kind: "work",
      createdAt: at(2),
      entry: {
        id: "turn-visual",
        createdAt: at(2),
        label: "Visual: Budget",
        tone: "info",
        activityKind: "visual.shown",
        turnId: TURN_ID,
        inlineVisual: TURN_VISUAL,
      },
    },
    {
      id: "entry-answer",
      kind: "message",
      createdAt: at(3),
      message: {
        id: MessageId.makeUnsafe("answer"),
        role: "assistant",
        text: placed
          ? `${ANSWER_LEAD}\n\n\`\`\`synara-visual\n${TURN_VISUAL.visualId}\n\`\`\`\n\n${ANSWER_TAIL}`
          : ANSWER_LEAD,
        createdAt: at(3),
        streaming: !settled,
        turnId: TURN_ID,
        ...(settled ? { completedAt: at(4) } : {}),
      },
    },
  ];
}

/** Mounts the live turn after `earlier` rows; `settle` re-renders it settled. */
async function mountLiveTurn(earlier: TimelineEntry[] = []) {
  vi.stubGlobal("nativeApi", {
    orchestration: {
      getInlineVisual: vi.fn(async () => ({ visualId: TURN_VISUAL.visualId, html: TURN_PAGE })),
    },
  } as unknown as NativeApi);
  const probes: Array<Record<string, unknown>> = [];
  const onProbe = (event: MessageEvent) => {
    if (event.data?.probe) probes.push(event.data as Record<string, unknown>);
  };
  window.addEventListener("message", onProbe);
  const client = new QueryClient();
  const view = (turn: TurnState) => (
    <QueryClientProvider client={client}>
      <Transcript turn={turn} />
    </QueryClientProvider>
  );
  const screen = await render(
    view({
      timelineEntries: [...earlier, ...turnEntries(false)],
      activeTurnId: TURN_ID,
      activeTurnStartedAt: at(0),
    }),
  );
  cleanup = async () => {
    window.removeEventListener("message", onProbe);
    await screen.unmount();
    client.clear();
  };
  await expect.poll(() => probes.some((entry) => entry.probe === "visual-ready")).toBe(true);
  const frame = document.querySelector<HTMLIFrameElement>(`iframe[title="${TURN_VISUAL.title}"]`)!;
  const list = document.querySelector<HTMLElement>("[data-chat-scroll-container]")!;
  const settle = async () => {
    await screen.rerender(view({ timelineEntries: [...earlier, ...turnEntries(true)] }));
    await vi.waitUntil(() =>
      [...document.querySelectorAll("button, span")].some((element) =>
        element.textContent?.trim().startsWith("Worked for"),
      ),
    );
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 50))),
    );
  };
  return { frame, list, probes, settle };
}

it("keeps a placed visual's page inside the answer when the turn settles", async () => {
  const { frame, probes, settle } = await mountLiveTurn();
  // The reader uses the visual while the answer still streams.
  frame.contentWindow!.postMessage({ set: 7 }, "*");

  await settle();
  const header = [...document.querySelectorAll("button, span")].find((element) =>
    element.textContent?.trim().startsWith("Worked for"),
  )!;

  // Same frame and page, never reloaded: the value the reader set survives.
  expect(document.querySelector("iframe[data-inline-visual-frame]")).toBe(frame);
  frame.contentWindow!.postMessage({ ask: true }, "*");
  await expect.poll(() => probes.find((entry) => entry.probe === "value")?.value).toBe(7);
  expect(probes.filter((entry) => entry.probe === "visual-ready")).toHaveLength(1);
  // One reading block: Worked for, then the answer with the visual where it
  // placed it, inside the answer's own row.
  const paragraph = (text: string) =>
    [...document.querySelectorAll("p")].find((element) => element.textContent === text)!;
  expect(header.getBoundingClientRect().bottom).toBeLessThanOrEqual(
    paragraph(ANSWER_LEAD).getBoundingClientRect().top,
  );
  expect(paragraph(ANSWER_LEAD).getBoundingClientRect().bottom).toBeLessThanOrEqual(
    frame.getBoundingClientRect().top,
  );
  expect(frame.getBoundingClientRect().bottom).toBeLessThanOrEqual(
    paragraph(ANSWER_TAIL).getBoundingClientRect().top,
  );
  expect(frame.closest("[data-timeline-row-kind]")?.getAttribute("data-timeline-row-kind")).toBe(
    "message",
  );
  expect(document.querySelector('[data-timeline-row-kind="inline-visual"]')).toBeNull();
});

it("shows a visual the answer never placed only once the turn settles, under its header", async () => {
  vi.stubGlobal("nativeApi", {
    orchestration: {
      getInlineVisual: vi.fn(async () => ({ visualId: TURN_VISUAL.visualId, html: TURN_PAGE })),
    },
  } as unknown as NativeApi);
  const client = new QueryClient();
  const view = (turn: TurnState) => (
    <QueryClientProvider client={client}>
      <Transcript turn={turn} />
    </QueryClientProvider>
  );
  const screen = await render(
    view({
      timelineEntries: turnEntries(false, false),
      activeTurnId: TURN_ID,
      activeTurnStartedAt: at(0),
    }),
  );
  cleanup = async () => {
    await screen.unmount();
    client.clear();
  };
  await vi.waitUntil(() => document.body.textContent?.includes(ANSWER_LEAD));
  // While the answer streams the visual waits rather than sitting above it.
  expect(document.querySelector("iframe[data-inline-visual-frame]")).toBeNull();

  await screen.rerender(view({ timelineEntries: turnEntries(true, false) }));

  const frame = await vi.waitUntil(() =>
    document.querySelector<HTMLIFrameElement>("iframe[data-inline-visual-frame]"),
  );
  const answer = [...document.querySelectorAll("p")].find(
    (element) => element.textContent === ANSWER_LEAD,
  )!;
  expect(frame.getBoundingClientRect().bottom).toBeLessThanOrEqual(
    answer.getBoundingClientRect().top,
  );
});

it("leaves follow as the reader set it when a turn with a visual settles", async () => {
  // An earlier long answer makes the transcript scroll.
  const { list, settle } = await mountLiveTurn(baseEntries.slice(0, 1));
  const distanceFromEnd = () => list.scrollHeight - list.clientHeight - list.scrollTop;
  await expect.poll(distanceFromEnd).toBeLessThanOrEqual(4);
  expect(followState()).toBe("following");

  // The reader scrolls up into the earlier answer while this one streams.
  await userEvent.wheel(list, { delta: { y: -300 } });
  await expect.poll(followState).toBe("detached");
  const readingTop = list.scrollTop;

  await settle();

  // Settling folds rows below the reader; it neither moves them nor rearms follow.
  expect(list.scrollTop).toBeCloseTo(readingTop, 0);
  expect(followState()).toBe("detached");
});

it("keeps a reader at the end when a turn with a visual settles", async () => {
  const { list, settle } = await mountLiveTurn(baseEntries.slice(0, 1));
  const distanceFromEnd = () => list.scrollHeight - list.clientHeight - list.scrollTop;
  await expect.poll(distanceFromEnd).toBeLessThanOrEqual(4);

  await settle();

  await expect.poll(distanceFromEnd).toBeLessThanOrEqual(4);
  expect(followState()).toBe("following");
});
