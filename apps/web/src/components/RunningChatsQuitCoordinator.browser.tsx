import "../index.css";

import {
  ThreadId,
  type DesktopBridge,
  type DesktopQuitConfirmationReference,
} from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page, userEvent } from "vitest/browser";
import { afterEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { stopRunningChatsForQuit } from "~/lib/runningChatsQuitConfirmation";
import { useStore } from "~/store";
import { APP_SETTINGS_STORAGE_KEY } from "~/appSettingsStorage";

import { RunningChatsQuitCoordinator } from "./RunningChatsQuitCoordinator";

vi.mock("~/lib/wsHttpUrl", async (original) => ({
  ...(await original<typeof import("../lib/wsHttpUrl")>()),
  resolveWsHttpUrl: () => "",
}));

vi.mock("~/lib/runningChatsQuitConfirmation", async (original) => {
  const actual = await original<typeof import("../lib/runningChatsQuitConfirmation")>();
  return { ...actual, stopRunningChatsForQuit: vi.fn(actual.stopRunningChatsForQuit) };
});

const originalBridge = window.desktopBridge;
const originalState = useStore.getState();
const originalStoredSettings = window.localStorage.getItem(APP_SETTINGS_STORAGE_KEY);

afterEach(() => {
  vi.clearAllMocks();
  if (originalBridge) window.desktopBridge = originalBridge;
  else delete window.desktopBridge;
  useStore.setState(originalState, true);
  if (originalStoredSettings === null) window.localStorage.removeItem(APP_SETTINGS_STORAGE_KEY);
  else window.localStorage.setItem(APP_SETTINGS_STORAGE_KEY, originalStoredSettings);
});

function installBridge(options: { readonly beginQuit?: boolean } = {}) {
  let request: ((payload: DesktopQuitConfirmationReference) => void) | undefined;
  let repeat: ((payload: DesktopQuitConfirmationReference) => void) | undefined;
  let withdrawn: ((payload: DesktopQuitConfirmationReference) => void) | undefined;
  const reply = vi.fn();
  const beginQuitConfirmation = vi.fn(async () => options.beginQuit !== false);
  window.desktopBridge = {
    onQuitConfirmationRequest: (listener) => {
      request = listener;
      return () => {
        request = undefined;
      };
    },
    onQuitConfirmationRepeat: (listener) => {
      repeat = listener;
      return () => {
        repeat = undefined;
      };
    },
    onQuitConfirmationWithdrawn: (listener) => {
      withdrawn = listener;
      return () => {
        withdrawn = undefined;
      };
    },
    replyQuitConfirmation: reply,
    beginQuitConfirmation,
  } as Pick<
    DesktopBridge,
    | "onQuitConfirmationRequest"
    | "onQuitConfirmationRepeat"
    | "onQuitConfirmationWithdrawn"
    | "replyQuitConfirmation"
    | "beginQuitConfirmation"
  > as DesktopBridge;
  return {
    request: (requestId: string) => request?.({ requestId }),
    repeat: (requestId: string) => repeat?.({ requestId }),
    withdraw: (requestId: string) => withdrawn?.({ requestId }),
    reply,
    beginQuitConfirmation,
  };
}

async function renderCoordinator() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { enabled: false, retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RunningChatsQuitCoordinator />
    </QueryClientProvider>,
  );
}

function storeOneRunningChat(title: string) {
  const threadId = ThreadId.makeUnsafe("thread-running");
  useStore.setState({
    sidebarThreadSummaryById: {
      [threadId]: {
        id: threadId,
        projectId: "project-1" as never,
        title,
        modelSelection: { provider: "codex", model: "gpt-5.4" },
        interactionMode: "default",
        envMode: "local",
        branch: null,
        worktreePath: null,
        session: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        archivedAt: null,
        updatedAt: "2026-01-01T00:00:00.000Z",
        latestTurn: null,
        latestUserMessageAt: null,
        hasPendingApprovals: false,
        hasPendingUserInput: false,
        hasActionableProposedPlan: false,
        hasLiveTailWork: true,
        pendingBackgroundWorkCount: 0,
      },
    },
    threadSessionById: {},
    threadShellById: {},
    threadsHydrated: true,
  });
}

it("quits a desktop with nothing running without showing a question", async () => {
  const bridge = installBridge();
  useStore.setState({
    sidebarThreadSummaryById: {},
    threadSessionById: {},
    threadShellById: {},
    threadsHydrated: true,
  });

  const screen = await renderCoordinator();
  try {
    bridge.request("q1");
    await expect.poll(() => bridge.reply.mock.calls.length).toBeGreaterThan(0);
    expect(bridge.reply).toHaveBeenCalledWith({
      requestId: "q1",
      phase: "decision",
      allow: true,
    });
    await expect.element(page.getByRole("alertdialog")).not.toBeInTheDocument();
  } finally {
    await screen.unmount();
  }
});

it("asks while a chat is running, and remembers turning the question off only once the quit is taken", async () => {
  const title = "A chat is still running";
  const bridge = installBridge();
  storeOneRunningChat("Fix the tray");

  const screen = await renderCoordinator();
  try {
    bridge.request("q1");
    await expect
      .element(page.getByRole("alertdialog", { name: title }), { timeout: 5000 })
      .toBeVisible();
    expect(bridge.reply).toHaveBeenCalledWith({ requestId: "q1", phase: "ready" });
    await expect.element(page.getByText("Fix the tray")).toBeVisible();

    await page.getByRole("checkbox", { name: "Quit without asking" }).click();
    await userEvent.keyboard("{Escape}");
    expect(bridge.reply).toHaveBeenCalledWith({ requestId: "q1", phase: "decision", allow: false });
    expect(window.localStorage.getItem(APP_SETTINGS_STORAGE_KEY) ?? "").not.toContain(
      '"askBeforeQuitting":false',
    );

    bridge.request("q2");
    await expect
      .element(page.getByRole("alertdialog", { name: title }), { timeout: 5000 })
      .toBeVisible();
    await page.getByRole("checkbox", { name: "Quit without asking" }).click();
    await page.getByRole("button", { name: "Quit", exact: true }).click();
    expect(window.localStorage.getItem(APP_SETTINGS_STORAGE_KEY)).toContain(
      '"askBeforeQuitting":false',
    );

    bridge.request("q3");
    await expect.element(page.getByRole("alertdialog"), { timeout: 5000 }).not.toBeInTheDocument();
    expect(bridge.reply).toHaveBeenCalledWith({ requestId: "q3", phase: "decision", allow: true });
  } finally {
    await screen.unmount();
  }
});

it("quits through the interrupt path whether the question is clicked or answered by a repeat", async () => {
  for (const answer of ["click", "repeat"] as const) {
    const bridge = installBridge();
    storeOneRunningChat("Fix the tray");
    window.localStorage.setItem(
      APP_SETTINGS_STORAGE_KEY,
      JSON.stringify({ resumeChatsAfterQuit: false }),
    );

    const screen = await renderCoordinator();
    try {
      bridge.request("q1");
      await expect.element(page.getByRole("alertdialog"), { timeout: 5000 }).toBeVisible();

      if (answer === "click") {
        await page.getByRole("button", { name: "Quit", exact: true }).click();
      } else {
        bridge.repeat("q1");
      }
      await expect
        .poll(() => bridge.reply.mock.calls.filter(([reply]) => reply.phase === "decision").length)
        .toBe(1);
      expect(bridge.reply).toHaveBeenCalledWith({
        requestId: "q1",
        phase: "decision",
        allow: true,
      });
      await expect
        .element(page.getByRole("alertdialog"), { timeout: 5000 })
        .not.toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  }
});

it("takes a withdrawn question down without quitting, and asks again on the next request", async () => {
  const bridge = installBridge();
  storeOneRunningChat("Fix the tray");

  const screen = await renderCoordinator();
  try {
    bridge.request("q1");
    await expect.element(page.getByRole("alertdialog"), { timeout: 5000 }).toBeVisible();
    expect(bridge.reply).toHaveBeenCalledWith({ requestId: "q1", phase: "ready" });

    bridge.withdraw("q1");
    await expect.element(page.getByRole("alertdialog"), { timeout: 5000 }).not.toBeInTheDocument();
    expect(bridge.reply).toHaveBeenCalledTimes(1);

    bridge.request("q2");
    await expect.element(page.getByRole("alertdialog"), { timeout: 5000 }).toBeVisible();
    expect(bridge.reply).toHaveBeenCalledWith({ requestId: "q2", phase: "ready" });
  } finally {
    await screen.unmount();
  }
});

it("stops nothing when the desktop has already closed the question", async () => {
  const bridge = installBridge({ beginQuit: false });
  storeOneRunningChat("Fix the tray");

  const screen = await renderCoordinator();
  try {
    bridge.request("q1");
    await expect.element(page.getByRole("alertdialog"), { timeout: 5000 }).toBeVisible();

    await page.getByRole("button", { name: "Quit", exact: true }).click();

    await expect
      .poll(() => bridge.beginQuitConfirmation.mock.calls.length, { timeout: 5000 })
      .toBe(1);
    expect(bridge.beginQuitConfirmation).toHaveBeenCalledWith({ requestId: "q1" });
    expect(stopRunningChatsForQuit).not.toHaveBeenCalled();
    expect(bridge.reply).not.toHaveBeenCalledWith({
      requestId: "q1",
      phase: "decision",
      allow: true,
    });
    await expect.element(page.getByRole("alertdialog"), { timeout: 5000 }).not.toBeInTheDocument();

    bridge.request("q2");
    await expect.element(page.getByRole("alertdialog"), { timeout: 5000 }).toBeVisible();
    expect(bridge.reply).toHaveBeenCalledWith({ requestId: "q2", phase: "ready" });
  } finally {
    await screen.unmount();
  }
});
