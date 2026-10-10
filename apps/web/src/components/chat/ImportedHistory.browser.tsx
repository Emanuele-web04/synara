import "../../index.css";
import {
  MessageId,
  type LoadProjectImportHistoryInput,
  type LoadProjectImportHistoryResult,
} from "@synara/contracts";
import { type LegendListRef } from "@legendapp/list/react";
import { act, createRef, type ComponentProps } from "react";
import { page } from "vitest/browser";
import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const api = vi.hoisted(() => ({ loadProjectImportHistory: vi.fn() }));
vi.mock("../../nativeApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../nativeApi")>()),
  ensureNativeApi: () => ({ orchestration: api }),
}));
import { ChatTranscriptPane } from "./ChatTranscriptPane";
import { ImportedHistoryButton, useImportedHistory } from "~/projectImport/ImportedHistoryButton";

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
