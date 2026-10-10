import "../../index.css";
import {
  MessageId,
  EventId,
  ThreadId,
  type OrchestrationThreadDetailSnapshot,
  type LoadProjectImportHistoryInput,
  type LoadProjectImportHistoryResult,
} from "@synara/contracts";
import { type LegendListRef } from "@legendapp/list/react";
import { act, createRef, useMemo, type ComponentProps } from "react";
import { page } from "vitest/browser";
import { afterEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const api = vi.hoisted(() => ({
  loadProjectImportHistory: vi.fn(),
  getThreadDetailSnapshot: vi.fn(),
}));
vi.mock("../../nativeApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../nativeApi")>()),
  ensureNativeApi: () => ({ orchestration: api }),
}));
import { ChatTranscriptPane } from "./ChatTranscriptPane";
import { ImportedHistoryButton, useImportedHistory } from "~/projectImport/ImportedHistoryButton";

import { useStore } from "../../store";
import { initialState } from "../../storeState";
import { getThreadFromState } from "../../threadDerivation";
import {
  makeState,
  makeThread,
  makeReadModelThread,
  makeDomainEvent,
} from "../../storeTestFixtures";
import { deriveTimelineEntries, deriveWorkLogEntries } from "../../session-logic";
afterEach(() => {
  useStore.setState(initialState);
  api.getThreadDetailSnapshot.mockReset();
});
const noop = () => {};
const recent = Array.from({ length: 10 }, (_, index) => ({
  id: `recent-${index}`,
  kind: "message" as const,
  createdAt: `2026-09-02T00:00:${String(index).padStart(2, "0")}.000Z`,
  message: {
    id: MessageId.makeUnsafe(`recent-${index}`),
    role: index % 2 ? ("assistant" as const) : ("user" as const),
    text: `Recent message ${index}. ${"Some conversation text. ".repeat(10)}`,
    createdAt: `2026-09-02T00:00:${String(index).padStart(2, "0")}.000Z`,
    streaming: false,
  },
}));
const props: ComponentProps<typeof ChatTranscriptPane> = {
  activeThreadId: "imported",
  isProjectImport: true,
  activeTurnInProgress: false,
  activeTurnStartedAt: null,
  chatFontSizePx: 15,
  emptyStateProjectName: undefined,
  hasMessages: true,
  isRevertingCheckpoint: false,
  isWorking: false,
  followLiveOutput: false,
  listRef: createRef<LegendListRef>(),
  markdownCwd: undefined,
  onExpandTimelineImage: noop,
  onMessagesClickCapture: noop,
  onMessagesMouseUp: noop,
  onMessagesPointerCancel: noop,
  onMessagesPointerDown: noop,
  onMessagesPointerUp: noop,
  onMessagesScroll: noop,
  onMessagesTouchEnd: noop,
  onMessagesTouchMove: noop,
  onMessagesTouchStart: noop,
  onMessagesWheel: noop,
  onIsAtEndChange: noop,
  onOpenTurnDiff: noop,
  onOpenThread: noop,
  onRevertUserMessage: noop,
  onScrollToBottom: noop,
  resolvedTheme: "dark",
  revertTurnCountByUserMessageId: new Map(),
  scrollButtonVisible: false,
  terminalWorkspaceTerminalTabActive: false,
  timelineEntries: recent,
  timestampFormat: "locale",
  turnDiffSummaryByAssistantMessageId: new Map(),
  workspaceRoot: undefined,
  worktreeSetup: null,
};

it("prepends older imported messages without moving the reading position and isolates late responses after switching chats", async () => {
  let attempts = 0;
  let finishLate: ((page: LoadProjectImportHistoryResult) => void) | undefined;
  api.loadProjectImportHistory.mockImplementation(async (input: LoadProjectImportHistoryInput) => {
    if (input.threadId !== "imported") return { messages: [], nextCursor: null };
    if (!input.cursor) return { messages: [], nextCursor: "1" };
    if (input.cursor === "2")
      return new Promise<LoadProjectImportHistoryResult>((resolve) => {
        finishLate = resolve;
      });
    if (++attempts === 1) throw new Error("History temporarily unavailable");
    return {
      nextCursor: "2",
      messages: Array.from({ length: 20 }, (_, index) => ({
        messageId: MessageId.makeUnsafe(`older-${index}`),
        role: index % 2 ? "assistant" : "user",
        text: `Older message ${index}`,
        createdAt: `2026-09-01T00:00:${String(index).padStart(2, "0")}.000Z`,
        updatedAt: "2026-09-01T00:00:30.000Z",
      })),
    };
  });
  const host = document.createElement("div");
  host.style.cssText =
    "display:flex;width:700px;height:520px;overflow:hidden;background:var(--background);";
  document.body.append(host);
  const screen = await render(<ChatTranscriptPane {...props} />, { container: host });
  try {
    await expect
      .element(page.getByRole("button", { name: "Load earlier messages" }))
      .toBeInTheDocument();
    await props.listRef.current!.scrollToOffset({ offset: 0, animated: false });
    await page.getByRole("button", { name: "Load earlier messages" }).click();
    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent("History temporarily unavailable");
    const firstRow = () =>
      host.querySelector('[data-message-id="recent-0"]')!.getBoundingClientRect().top;
    const before = firstRow();
    await page.screenshot({ path: "__screenshots__/import-history-before.png" });
    await page.getByRole("button", { name: "Retry loading earlier messages" }).click();
    await expect
      .element(page.getByRole("button", { name: "Load earlier messages" }))
      .toBeInTheDocument();
    await vi.waitFor(() => expect(Math.abs(firstRow() - before)).toBeLessThan(4));
    await props.listRef.current!.scrollToOffset({ offset: 0, animated: false });
    await expect.element(page.getByText("Older message 0", { exact: true })).toBeInTheDocument();
    await page.screenshot({ path: "__screenshots__/import-history-after.png" });
    await page.getByRole("button", { name: "Load earlier messages" }).click();
    await expect
      .element(page.getByRole("button", { name: "Loading earlier messages…" }))
      .toBeDisabled();
    await screen.rerender(
      <ChatTranscriptPane {...props} activeThreadId="other" isProjectImport={false} />,
    );
    finishLate!({
      nextCursor: null,
      messages: [
        {
          messageId: MessageId.makeUnsafe("late"),
          role: "assistant",
          text: "Late history from previous chat",
          createdAt: "2026-08-01T00:00:00.000Z",
          updatedAt: "2026-08-01T00:00:00.000Z",
        },
      ],
    });
    await expect.poll(() => host.textContent).not.toContain("Older message");
    await expect.poll(() => host.textContent).not.toContain("Late history from previous chat");
  } finally {
    await screen.unmount();
    host.remove();
  }
});

it("never requests imported history for an ordinary chat, before or after saving", async () => {
  let serverKnowsThread = false;
  api.loadProjectImportHistory.mockReset();
  api.loadProjectImportHistory.mockImplementation(async () => {
    if (!serverKnowsThread) throw new Error("The imported conversation no longer exists.");
    return { messages: [], nextCursor: "1" };
  });
  const host = document.createElement("div");
  host.style.cssText = "display:flex;width:700px;height:520px;overflow:hidden;";
  document.body.append(host);
  const draftProps = {
    ...props,
    isProjectImport: false,
    activeThreadId: "draft",
    hasMessages: false,
    timelineEntries: [],
  };
  const screen = await render(<ChatTranscriptPane {...draftProps} isLocalDraft />, {
    container: host,
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(api.loadProjectImportHistory).not.toHaveBeenCalled();
    expect(host.textContent).not.toContain("earlier messages");
    expect(page.getByRole("alert").query()).toBeNull();

    serverKnowsThread = true;
    await screen.rerender(<ChatTranscriptPane {...draftProps} isLocalDraft={false} />);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(api.loadProjectImportHistory).not.toHaveBeenCalled();
    expect(host.textContent).not.toContain("earlier messages");
    expect(page.getByRole("alert").query()).toBeNull();
  } finally {
    await screen.unmount();
    host.remove();
  }
});

it.each(["initial", "older-page"])(
  "recovers %s imported history from capacity errors without a manual retry",
  async (phase) => {
    let releaseCapacity = false;
    api.loadProjectImportHistory.mockReset();
    api.loadProjectImportHistory.mockImplementation(
      async (input: LoadProjectImportHistoryInput) => {
        if (phase === "older-page" && !input.cursor) return { messages: [], nextCursor: "1" };
        if (!releaseCapacity)
          throw Object.assign(new Error("WebSocket expensive-read request capacity exceeded."), {
            code: "RPC_EXPENSIVE_READ_CAPACITY_EXCEEDED",
            retryable: true,
            retryAfterMs: 50,
          });
        return {
          nextCursor: null,
          messages: [
            {
              messageId: MessageId.makeUnsafe("recovered"),
              role: "user",
              text: "Recovered earlier message",
              createdAt: "2026-08-01T00:00:00.000Z",
              updatedAt: "2026-08-01T00:00:00.000Z",
            },
          ],
        };
      },
    );
    const host = document.createElement("div");
    host.style.cssText = "display:flex;width:700px;height:520px;overflow:hidden;";
    document.body.append(host);
    const screen = await render(<ChatTranscriptPane {...props} />, { container: host });
    try {
      if (phase === "older-page")
        await page.getByRole("button", { name: "Load earlier messages" }).click();
      await expect
        .element(page.getByRole("button", { name: "Loading earlier messages…" }))
        .toBeDisabled();
      expect(page.getByRole("alert").query()).toBeNull();
      releaseCapacity = true;
      await expect
        .element(page.getByText("Recovered earlier message", { exact: true }))
        .toBeInTheDocument();
      const calls = api.loadProjectImportHistory.mock.calls.length;
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(api.loadProjectImportHistory).toHaveBeenCalledTimes(calls);
    } finally {
      await screen.unmount();
      host.remove();
    }
  },
);

it("cancels a scheduled capacity retry when switching to an ordinary chat", async () => {
  api.loadProjectImportHistory.mockReset();
  api.loadProjectImportHistory.mockRejectedValue(
    Object.assign(new Error("Server busy"), {
      code: "RPC_EXPENSIVE_READ_CAPACITY_EXCEEDED",
      retryable: true,
      retryAfterMs: 500,
    }),
  );
  const host = document.createElement("div");
  host.style.cssText = "display:flex;width:700px;height:520px;overflow:hidden;";
  document.body.append(host);
  const screen = await render(<ChatTranscriptPane {...props} />, { container: host });
  try {
    await expect
      .element(page.getByRole("button", { name: "Loading earlier messages…" }))
      .toBeDisabled();
    await screen.rerender(
      <ChatTranscriptPane {...props} activeThreadId="ordinary" isProjectImport={false} />,
    );
    const calls = api.loadProjectImportHistory.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(api.loadProjectImportHistory).toHaveBeenCalledTimes(calls);
    expect(host.textContent).not.toContain("earlier messages");
    expect(page.getByRole("alert").query()).toBeNull();
  } finally {
    await screen.unmount();
    host.remove();
  }
});

it("continues capacity recovery after backoff reaches its maximum delay", async () => {
  api.loadProjectImportHistory.mockReset();
  api.loadProjectImportHistory.mockRejectedValue(
    Object.assign(new Error("Server busy"), {
      code: "RPC_EXPENSIVE_READ_CAPACITY_EXCEEDED",
      retryable: true,
      retryAfterMs: 10_000,
    }),
  );
  function History() {
    const history = useImportedHistory("imported", true);
    return <ImportedHistoryButton history={history} />;
  }
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const screen = await render(<History />);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  try {
    expect(api.loadProjectImportHistory).toHaveBeenCalledTimes(1);
    for (let requests = 2; requests <= 4; requests += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(api.loadProjectImportHistory).toHaveBeenCalledTimes(requests);
    }
  } finally {
    await screen.unmount();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});

function NativeHistoryPane({ threadId, onNavigate }: { threadId: string; onNavigate: () => void }) {
  const thread = useStore((state) => getThreadFromState(state, ThreadId.makeUnsafe(threadId)));
  const entries = useMemo(
    () =>
      deriveTimelineEntries(
        thread?.messages ?? [],
        [],
        deriveWorkLogEntries(thread?.activities ?? [], undefined),
      ),
    [thread?.messages, thread?.activities],
  );
  return (
    <ChatTranscriptPane
      {...props}
      activeThreadId={threadId}
      isProjectImport={false}
      timelineEntries={entries}
      hasMessages={(thread?.messages.length ?? 0) > 0}
      onNavigate={onNavigate}
    />
  );
}

it("prepends native history while live settlement wins and the reader stays detached at the same anchor", async () => {
  const id = ThreadId.makeUnsafe("native-history");
  const messages = recent.map((row) => row.message);
  const cursor = { messageId: messages[0]!.id, createdAt: messages[0]!.createdAt, sequence: null };
  useStore.setState({
    ...makeState(makeThread({ id, messages })),
    threadDetailSyncById: { [id]: "synced" },
    threadDetailAppliedSequenceById: { [id]: 20 },
    threadHistoryById: { [id]: { totalMessageCount: 30, olderCursor: cursor } },
  });
  let finish!: (snapshot: OrchestrationThreadDetailSnapshot) => void;
  api.getThreadDetailSnapshot.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const onNavigate = vi.fn();
  const host = document.createElement("div");
  host.style.cssText = "display:flex;width:700px;height:520px;overflow:hidden;";
  document.body.append(host);
  const screen = await render(<NativeHistoryPane threadId={id} onNavigate={onNavigate} />, {
    container: host,
  });
  try {
    await props.listRef.current!.scrollToOffset({ offset: 0, animated: false });
    const firstRow = () =>
      host.querySelector('[data-message-id="recent-0"]')!.getBoundingClientRect().top;
    const before = firstRow();
    await page.getByRole("button", { name: "Load earlier messages" }).click();
    const newest = messages.at(-1)!;
    useStore
      .getState()
      .applyOrchestrationEvents([
        makeDomainEvent(
          "thread.message-sent",
          {
            threadId: id,
            messageId: newest.id,
            role: "assistant",
            text: newest.text + " Final live answer",
            turnId: null,
            streaming: false,
            source: "native",
            createdAt: newest.createdAt,
            updatedAt: "2026-09-02T00:01:00.000Z",
          },
          { sequence: 21 },
        ),
      ]);
    finish({
      snapshotSequence: 19,
      history: { totalMessageCount: 30, olderCursor: null },
      thread: makeReadModelThread({
        id,
        messages: [
          ...Array.from({ length: 20 }, (_, index) => ({
            id: MessageId.makeUnsafe(`native-old-${index}`),
            role: index % 2 ? ("assistant" as const) : ("user" as const),
            text: `Earlier native message ${index}`,
            source: "native" as const,
            turnId: null,
            streaming: false,
            createdAt: `2026-09-01T00:00:${String(index).padStart(2, "0")}.000Z`,
            updatedAt: "2026-09-01T00:00:30.000Z",
          })),
          {
            ...newest,
            turnId: null,
            source: "native",
            streaming: true,
            updatedAt: newest.createdAt,
            text: "stale",
          },
        ],
      }),
    });
    await vi.waitFor(() => expect(useStore.getState().messageIdsByThreadId?.[id]).toHaveLength(30));
    await vi.waitFor(() => expect(Math.abs(firstRow() - before)).toBeLessThan(4));
    expect(getThreadFromState(useStore.getState(), id)?.messages.at(-1)?.text).toBe(
      newest.text + " Final live answer",
    );
    expect(useStore.getState().threadDetailAppliedSequenceById?.[id]).toBe(21);
    expect(onNavigate).toHaveBeenCalledTimes(1);
    await props.listRef.current!.scrollToOffset({ offset: 0, animated: false });
    await expect
      .element(page.getByText("Earlier native message 0", { exact: true }))
      .toBeInTheDocument();
  } finally {
    await screen.unmount();
    host.remove();
  }
});

it("loads earlier tool-only work through the native history affordance with no chat messages", async () => {
  const id = ThreadId.makeUnsafe("native-tools");
  const current = {
    id: EventId.makeUnsafe("current-tool"),
    kind: "tool.completed",
    tone: "tool" as const,
    summary: "Ran command",
    turnId: null,
    createdAt: "2026-09-02T00:00:00.000Z",
    payload: {
      itemType: "command_execution",
      status: "completed",
      title: "Ran command",
      data: { command: "pwd", output: "recent" },
    },
  };
  useStore.setState({
    ...makeState(makeThread({ id, activities: [current] })),
    threadDetailSyncById: { [id]: "synced" },
    threadHistoryById: {
      [id]: {
        totalMessageCount: 0,
        olderCursor: null,
        olderActivityCursor: { activityId: current.id, createdAt: current.createdAt },
      },
    },
  });
  api.getThreadDetailSnapshot.mockResolvedValue({
    snapshotSequence: 10,
    history: { totalMessageCount: 0, olderCursor: null, olderActivityCursor: null },
    thread: makeReadModelThread({
      id,
      activities: [
        {
          ...current,
          id: EventId.makeUnsafe("earlier-tool"),
          createdAt: "2026-09-01T00:00:00.000Z",
          payload: { ...current.payload, data: { command: "echo earlier-tool-only" } },
        },
      ],
    }),
  });
  const host = document.createElement("div");
  host.style.cssText = "display:flex;width:700px;height:520px;overflow:hidden;";
  document.body.append(host);
  const screen = await render(<NativeHistoryPane threadId={id} onNavigate={noop} />, {
    container: host,
  });
  try {
    await page.getByRole("button", { name: "Load earlier messages" }).click();
    await expect.poll(() => getThreadFromState(useStore.getState(), id)?.activities.length).toBe(2);
    await props.listRef.current!.scrollToOffset({ offset: 0, animated: false });
    await page.getByRole("button", { name: "Ran 2 commands" }).click();
    await expect.poll(() => host.textContent).toContain("earlier-tool-only");
    expect(
      api.getThreadDetailSnapshot.mock.calls[0]?.[0]?.messageWindow.beforeActivity.activityId,
    ).toBe(current.id);
    expect(page.getByRole("button", { name: "Load earlier messages" }).query()).toBeNull();
  } finally {
    await screen.unmount();
    host.remove();
  }
});
