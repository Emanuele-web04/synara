import "../index.css";

import {
  ThreadId,
  TurnId,
  type DesktopBridge,
  type DesktopQuitConfirmationRequest,
  type NativeApi,
} from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page, userEvent } from "vitest/browser";
import { afterEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { useStore } from "~/store";

import { RunningChatsQuitCoordinator } from "./RunningChatsQuitCoordinator";

vi.mock("~/lib/wsHttpUrl", async (original) => ({
  ...(await original<typeof import("../lib/wsHttpUrl")>()),
  resolveWsHttpUrl: () => "",
}));

const originalBridge = window.desktopBridge;
const originalNativeApi = window.nativeApi;
const originalState = useStore.getState();
const appSettingsStorageKey = "synara:app-settings:v1";
const originalAppSettings = localStorage.getItem(appSettingsStorageKey);

afterEach(() => {
  if (originalBridge) window.desktopBridge = originalBridge;
  else delete window.desktopBridge;
  if (originalNativeApi) window.nativeApi = originalNativeApi;
  else delete window.nativeApi;
  useStore.setState(originalState, true);
  if (originalAppSettings === null) localStorage.removeItem(appSettingsStorageKey);
  else localStorage.setItem(appSettingsStorageKey, originalAppSettings);
});

it.each([false, true])(
  "keeps the quit dialog disabled until interrupt admission is acknowledged (resume=%s)",
  async (resumeAfterRestart) => {
    let request: ((payload: DesktopQuitConfirmationRequest) => void) | undefined;
    const reply = vi.fn();
    let acknowledge!: () => void;
    const acknowledgement = new Promise<void>((resolve) => {
      acknowledge = resolve;
    });
    const prepareQuitResume = vi.fn(() => acknowledgement);
    const dispatchCommand = vi.fn();
    window.desktopBridge = {
      onQuitConfirmationRequest: (listener) => {
        request = listener;
        return () => {
          request = undefined;
        };
      },
      replyQuitConfirmation: reply,
    } as Pick<
      DesktopBridge,
      "onQuitConfirmationRequest" | "replyQuitConfirmation"
    > as DesktopBridge;
    window.nativeApi = {
      orchestration: { prepareQuitResume, dispatchCommand },
    } as unknown as NativeApi;
    const threadId = ThreadId.makeUnsafe("pending-quit-thread");
    useStore.setState({
      sidebarThreadSummaryById: {},
      threadShellById: {},
      threadSessionById: {
        [threadId]: {
          status: "running",
          provider: "codex",
          runtimeMode: "full-access",
          activeTurnId: TurnId.makeUnsafe("pending-quit-turn"),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          orchestrationStatus: "running",
        },
      },
    });
    localStorage.setItem(
      appSettingsStorageKey,
      JSON.stringify({ resumeChatsAfterQuit: resumeAfterRestart }),
    );

    const queryClient = new QueryClient({
      defaultOptions: { queries: { enabled: false, retry: false } },
    });
    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <RunningChatsQuitCoordinator />
      </QueryClientProvider>,
    );
    try {
      request?.({ requestId: "pending-quit", presentation: "in-app" });
      await expect.element(page.getByRole("alertdialog")).toBeVisible();
      expect(reply).toHaveBeenCalledWith(
        expect.objectContaining({ requestId: "pending-quit", phase: "ready", runningCount: 1 }),
      );
      const quit = page.getByRole("button", { name: "Quit", exact: true });
      await quit.click();
      await expect.poll(() => prepareQuitResume.mock.calls.length).toBe(1);
      expect(prepareQuitResume).toHaveBeenCalledWith(
        expect.objectContaining({ threadIds: [threadId], resumeAfterRestart }),
      );
      await expect.element(page.getByRole("alertdialog")).toBeVisible();
      await expect.element(quit).toBeDisabled();
      await expect.element(page.getByRole("button", { name: /^Cancel/ })).toBeDisabled();
      await expect.element(page.getByRole("checkbox")).toBeDisabled();
      expect(reply).not.toHaveBeenCalledWith(
        expect.objectContaining({ phase: "decision", allow: true }),
      );

      acknowledge();
      await expect
        .poll(() => reply.mock.calls)
        .toContainEqual([{ requestId: "pending-quit", phase: "decision", allow: true }]);
      await expect.element(page.getByRole("alertdialog")).not.toBeInTheDocument();
      expect(prepareQuitResume).toHaveBeenCalledTimes(1);
      expect(dispatchCommand).not.toHaveBeenCalled();
    } finally {
      acknowledge();
      await screen.unmount();
      queryClient.clear();
    }
  },
);

it("requires confirmation for an idle quit, supports Escape, and asks again after cancel", async () => {
  let request: ((payload: DesktopQuitConfirmationRequest) => void) | undefined;
  const reply = vi.fn();
  window.desktopBridge = {
    onQuitConfirmationRequest: (listener) => {
      request = listener;
      return () => {
        request = undefined;
      };
    },
    replyQuitConfirmation: reply,
  } as Pick<DesktopBridge, "onQuitConfirmationRequest" | "replyQuitConfirmation"> as DesktopBridge;
  useStore.setState({ sidebarThreadSummaryById: {}, threadSessionById: {}, threadShellById: {} });

  const queryClient = new QueryClient({
    defaultOptions: { queries: { enabled: false, retry: false } },
  });
  const screen = await render(
    <QueryClientProvider client={queryClient}>
      <RunningChatsQuitCoordinator />
    </QueryClientProvider>,
  );
  try {
    await expect.element(page.getByRole("alertdialog")).not.toBeInTheDocument();
    request?.({ requestId: "q1", presentation: "in-app" });
    await expect.element(page.getByRole("alertdialog")).toBeVisible();
    expect(reply).toHaveBeenCalledWith({
      requestId: "q1",
      phase: "ready",
      runningCount: 0,
      chats: [],
    });
    expect(reply).not.toHaveBeenCalledWith(
      expect.objectContaining({ phase: "decision", allow: true }),
    );
    await expect.element(page.getByRole("checkbox")).not.toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(reply).toHaveBeenCalledWith({ requestId: "q1", phase: "decision", allow: false });

    request?.({ requestId: "q2", presentation: "in-app" });
    await expect.element(page.getByRole("alertdialog")).toBeVisible();
    await page.getByRole("button", { name: "Quit", exact: true }).click();
    expect(reply).toHaveBeenCalledWith({ requestId: "q2", phase: "decision", allow: true });
  } finally {
    await screen.unmount();
  }
});
