import { ThreadId, type CanvasStreamEvent } from "@synara/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { selectRightDockState, useRightDockStore } from "~/rightDockStore";
import { openCanvasPaneForAgent, useCanvasPaneOpenRequests } from "./canvasPane";
import { useCanvasPaneRequestStore } from "./canvasStores";

type ActivityEvent = Extract<CanvasStreamEvent, { type: "activity" }>;
const chat = ThreadId.makeUnsafe("chat-on-screen");
const background = ThreadId.makeUnsafe("chat-in-background");
const activity = (overrides: Partial<ActivityEvent> = {}): ActivityEvent => ({
  type: "activity",
  workId: "work1",
  pageId: "page1",
  frameIds: ["f1"],
  threadId: chat,
  expiresAt: new Date(Date.now() + 40_000).toISOString(),
  kind: "write",
  ...overrides,
});
/** What CanvasEventBridge does with every activity event from the server. */
const receive = (event: ActivityEvent) => useCanvasPaneRequestStore.getState().noteActivity(event);
const dock = (threadId: ThreadId) => selectRightDockState(threadId)(useRightDockStore.getState());
const canvasPane = (threadId: ThreadId) => dock(threadId).panes.find((p) => p.kind === "canvas");

const hydrated: string[] = [];

/** A chat surface as SingleChatSurface wires it: the composer has focus. */
function ChatSurface({ threadId }: { threadId: ThreadId }) {
  useCanvasPaneOpenRequests({
    onOpenPaneRequested: (request) =>
      openCanvasPaneForAgent({
        currentThreadId: threadId,
        request,
        requestImmediateHydration: () => hydrated.push(request.threadId),
      }),
  });
  return <textarea data-testid="composer" aria-label="Composer" autoFocus />;
}

const composer = () => document.querySelector<HTMLTextAreaElement>('[data-testid="composer"]')!;

describe("canvas pane beside the chat on agent canvas work", () => {
  beforeEach(() => {
    useCanvasPaneRequestStore.setState({ surfaced: {}, pending: [] });
    useRightDockStore.getState().clearThreadDockState(chat);
    useRightDockStore.getState().clearThreadDockState(background);
    hydrated.length = 0;
  });
  afterEach(() => {
    useRightDockStore.getState().clearThreadDockState(chat);
    useRightDockStore.getState().clearThreadDockState(background);
  });

  it("opens the agent's work and page beside its chat without taking the composer's focus", async () => {
    const screen = await render(<ChatSurface threadId={chat} />);
    try {
      composer().focus();
      expect(document.activeElement).toBe(composer());
      receive(activity({ kind: "read" }));
      await new Promise((resolve) => setTimeout(resolve, 50));
      // A read shows nothing.
      expect(canvasPane(chat)).toBeUndefined();

      receive(activity({ pageId: "page2" }));
      await vi.waitFor(() => expect(canvasPane(chat)).toBeTruthy());
      expect(canvasPane(chat)).toMatchObject({ canvasWorkId: "work1", canvasPageId: "page2" });
      expect(dock(chat).open).toBe(true);
      expect(dock(chat).activePaneId).toBe(canvasPane(chat)!.id);
      expect(hydrated).toEqual([chat]);
      expect(document.activeElement).toBe(composer());
    } finally {
      await screen.unmount();
    }
  });

  it("leaves a pane the user closed closed for the rest of that turn", async () => {
    const screen = await render(<ChatSurface threadId={chat} />);
    try {
      receive(activity());
      await vi.waitFor(() => expect(canvasPane(chat)).toBeTruthy());
      useRightDockStore.getState().closePane(chat, canvasPane(chat)!.id);
      receive(activity({ kind: "edit" }));
      receive(activity({ kind: "write", frameIds: ["f2"] }));
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(canvasPane(chat)).toBeUndefined();

      // The next turn's first write brings it back.
      receive(activity({ ended: true }));
      receive(activity({ kind: "edit" }));
      await vi.waitFor(() => expect(canvasPane(chat)).toBeTruthy());
    } finally {
      await screen.unmount();
    }
  });

  it("remembers a background chat's pane on that chat, and waits for a surface to show it", async () => {
    // Work that arrives while no chat is on screen waits for one.
    receive(activity({ threadId: background, workId: "work2", pageId: "p9" }));
    const screen = await render(<ChatSurface threadId={chat} />);
    try {
      await vi.waitFor(() => expect(canvasPane(background)).toBeTruthy());
      expect(canvasPane(background)).toMatchObject({ canvasWorkId: "work2", canvasPageId: "p9" });
      // The chat on screen keeps its own dock, and only it is ever hydrated.
      expect(canvasPane(chat)).toBeUndefined();
      expect(hydrated).toEqual([]);
      // Taken once: remounting a surface does not replay it.
      useRightDockStore.getState().closePane(background, canvasPane(background)!.id);
      await screen.rerender(<ChatSurface threadId={background} />);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(canvasPane(background)).toBeUndefined();
    } finally {
      await screen.unmount();
    }
  });
});
