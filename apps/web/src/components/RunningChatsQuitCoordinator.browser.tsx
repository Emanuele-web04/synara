import "../index.css";

import type { DesktopBridge, DesktopQuitConfirmationRequest } from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page, userEvent } from "vitest/browser";
import { afterEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { setDesktopQuitAsks } from "~/hooks/useDesktopQuitPreference";
import { useStore } from "~/store";
import { APP_DISPLAY_NAME } from "~/branding";

import { RunningChatsQuitCoordinator } from "./RunningChatsQuitCoordinator";

const verifyIdle = vi.hoisted(() => vi.fn(async () => true));

vi.mock("~/lib/runningChatsQuitConfirmation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/runningChatsQuitConfirmation")>()),
  verifyDesktopChatsIdle: verifyIdle,
}));

vi.mock("~/lib/wsHttpUrl", async (original) => ({
  ...(await original<typeof import("../lib/wsHttpUrl")>()),
  resolveWsHttpUrl: () => "",
}));

const originalBridge = window.desktopBridge;
const originalState = useStore.getState();

afterEach(() => {
  if (originalBridge) window.desktopBridge = originalBridge;
  else delete window.desktopBridge;
  setDesktopQuitAsks(true);
  verifyIdle.mockReset();
  verifyIdle.mockResolvedValue(true);
  useStore.setState(originalState, true);
});

it("requires confirmation for an idle quit, supports Escape, and asks again after cancel", async () => {
  const title = `Quit ${APP_DISPLAY_NAME}?`;
  let request: ((payload: DesktopQuitConfirmationRequest) => void) | undefined;
  const reply = vi.fn();
  const reveal = vi.fn();
  window.desktopBridge = {
    onQuitConfirmationRequest: (listener) => {
      request = listener;
      return () => {
        request = undefined;
      };
    },
    replyQuitConfirmation: reply,
    revealQuitConfirmation: reveal,
  } as Pick<
    DesktopBridge,
    "onQuitConfirmationRequest" | "replyQuitConfirmation" | "revealQuitConfirmation"
  > as DesktopBridge;
  useStore.setState({
    threadsHydrated: true,
    sidebarThreadSummaryById: {},
    threadSessionById: {},
    threadShellById: {},
  });

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
    await expect
      .element(page.getByRole("alertdialog", { name: title }), { timeout: 5000 })
      .toBeVisible();
    expect(reveal).toHaveBeenCalledOnce();
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
    await expect
      .element(page.getByRole("alertdialog", { name: title }), { timeout: 5000 })
      .toBeVisible();
    await page.getByRole("button", { name: "Quit", exact: true }).click();
    expect(reply).toHaveBeenCalledWith({ requestId: "q2", phase: "decision", allow: true });
  } finally {
    await screen.unmount();
  }
});

it("confirms the open question with Command+Enter", async () => {
  const title = `Quit ${APP_DISPLAY_NAME}?`;
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
  useStore.setState({
    threadsHydrated: true,
    sidebarThreadSummaryById: {},
    threadSessionById: {},
    threadShellById: {},
  });

  const queryClient = new QueryClient({
    defaultOptions: { queries: { enabled: false, retry: false } },
  });
  const screen = await render(
    <QueryClientProvider client={queryClient}>
      <RunningChatsQuitCoordinator />
    </QueryClientProvider>,
  );
  try {
    request?.({ requestId: "q1", presentation: "in-app" });
    await expect
      .element(page.getByRole("alertdialog", { name: title }), { timeout: 5000 })
      .toBeVisible();

    await userEvent.keyboard("{Meta>}{Enter}{/Meta}");

    expect(reply).toHaveBeenCalledWith({ requestId: "q1", phase: "decision", allow: true });
  } finally {
    await screen.unmount();
  }
});

it("answers an idle quit without showing the question when asking is off", async () => {
  setDesktopQuitAsks(false);
  let request: ((payload: DesktopQuitConfirmationRequest) => void) | undefined;
  const reply = vi.fn();
  const reveal = vi.fn();
  window.desktopBridge = {
    onQuitConfirmationRequest: (listener) => {
      request = listener;
      return () => {
        request = undefined;
      };
    },
    replyQuitConfirmation: reply,
    revealQuitConfirmation: reveal,
    getQuitAsks: async () => false,
    setQuitAsks: vi.fn(),
    onQuitConfirmationWithdrawn: () => () => {},
  } as Pick<
    DesktopBridge,
    | "onQuitConfirmationRequest"
    | "replyQuitConfirmation"
    | "revealQuitConfirmation"
    | "getQuitAsks"
    | "setQuitAsks"
    | "onQuitConfirmationWithdrawn"
  > as DesktopBridge;
  useStore.setState({
    threadsHydrated: true,
    sidebarThreadSummaryById: {},
    threadSessionById: {},
    threadShellById: {},
  });

  const queryClient = new QueryClient({
    defaultOptions: { queries: { enabled: false, retry: false } },
  });
  const screen = await render(
    <QueryClientProvider client={queryClient}>
      <RunningChatsQuitCoordinator />
    </QueryClientProvider>,
  );
  try {
    request?.({ requestId: "q1", presentation: "in-app" });
    expect(reply).toHaveBeenCalledWith({
      requestId: "q1",
      phase: "ready",
      runningCount: 0,
      chats: [],
    });
    await vi.waitFor(() =>
      expect(reply).toHaveBeenCalledWith({ requestId: "q1", phase: "decision", allow: true }),
    );
    expect(page.getByRole("alertdialog").elements()).toHaveLength(0);
    expect(reveal).not.toHaveBeenCalled();
  } finally {
    await screen.unmount();
  }
});

it("still shows the question when the server reports live work", async () => {
  setDesktopQuitAsks(false);
  verifyIdle.mockResolvedValueOnce(false);
  let request: ((payload: DesktopQuitConfirmationRequest) => void) | undefined;
  const reply = vi.fn();
  const reveal = vi.fn();
  window.desktopBridge = {
    onQuitConfirmationRequest: (listener) => {
      request = listener;
      return () => {
        request = undefined;
      };
    },
    replyQuitConfirmation: reply,
    revealQuitConfirmation: reveal,
    getQuitAsks: async () => false,
    setQuitAsks: vi.fn(),
    onQuitConfirmationWithdrawn: () => () => {},
  } as Pick<
    DesktopBridge,
    | "onQuitConfirmationRequest"
    | "replyQuitConfirmation"
    | "revealQuitConfirmation"
    | "getQuitAsks"
    | "setQuitAsks"
    | "onQuitConfirmationWithdrawn"
  > as DesktopBridge;
  useStore.setState({
    threadsHydrated: true,
    sidebarThreadSummaryById: {},
    threadSessionById: {},
    threadShellById: {},
  });

  const queryClient = new QueryClient({
    defaultOptions: { queries: { enabled: false, retry: false } },
  });
  const screen = await render(
    <QueryClientProvider client={queryClient}>
      <RunningChatsQuitCoordinator />
    </QueryClientProvider>,
  );
  try {
    request?.({ requestId: "q1", presentation: "in-app" });
    await expect
      .element(page.getByRole("alertdialog", { name: `Quit ${APP_DISPLAY_NAME}?` }), {
        timeout: 5000,
      })
      .toBeVisible();
    expect(reveal).toHaveBeenCalledOnce();
    expect(reply).not.toHaveBeenCalledWith(
      expect.objectContaining({ phase: "decision", allow: true }),
    );
  } finally {
    await screen.unmount();
  }
});

it("still asks when the store has not hydrated, even with asking off", async () => {
  setDesktopQuitAsks(false);
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
    revealQuitConfirmation: vi.fn(),
    getQuitAsks: async () => false,
    setQuitAsks: vi.fn(),
    onQuitConfirmationWithdrawn: () => () => {},
  } as Pick<
    DesktopBridge,
    | "onQuitConfirmationRequest"
    | "replyQuitConfirmation"
    | "revealQuitConfirmation"
    | "getQuitAsks"
    | "setQuitAsks"
    | "onQuitConfirmationWithdrawn"
  > as DesktopBridge;
  useStore.setState({
    threadsHydrated: false,
    sidebarThreadSummaryById: {},
    threadSessionById: {},
    threadShellById: {},
  });

  const queryClient = new QueryClient({
    defaultOptions: { queries: { enabled: false, retry: false } },
  });
  const screen = await render(
    <QueryClientProvider client={queryClient}>
      <RunningChatsQuitCoordinator />
    </QueryClientProvider>,
  );
  try {
    request?.({ requestId: "q1", presentation: "in-app" });
    await expect
      .element(page.getByRole("alertdialog", { name: `Quit ${APP_DISPLAY_NAME}?` }), {
        timeout: 5000,
      })
      .toBeVisible();
    expect(reply).not.toHaveBeenCalledWith(
      expect.objectContaining({ phase: "decision", allow: true }),
    );
  } finally {
    await screen.unmount();
  }
});

it("turns the idle quit question off from the dialog", async () => {
  const title = `Quit ${APP_DISPLAY_NAME}?`;
  let request: ((payload: DesktopQuitConfirmationRequest) => void) | undefined;
  const reply = vi.fn();
  const setQuitAsks = vi.fn(async () => undefined);
  window.desktopBridge = {
    onQuitConfirmationRequest: (listener) => {
      request = listener;
      return () => {
        request = undefined;
      };
    },
    replyQuitConfirmation: reply,
    getQuitAsks: async () => true,
    setQuitAsks,
  } as Pick<
    DesktopBridge,
    "onQuitConfirmationRequest" | "replyQuitConfirmation" | "getQuitAsks" | "setQuitAsks"
  > as DesktopBridge;
  useStore.setState({
    threadsHydrated: true,
    sidebarThreadSummaryById: {},
    threadSessionById: {},
    threadShellById: {},
  });

  const queryClient = new QueryClient({
    defaultOptions: { queries: { enabled: false, retry: false } },
  });
  const screen = await render(
    <QueryClientProvider client={queryClient}>
      <RunningChatsQuitCoordinator />
    </QueryClientProvider>,
  );
  try {
    request?.({ requestId: "q1", presentation: "in-app" });
    await expect
      .element(page.getByRole("alertdialog", { name: title }), { timeout: 5000 })
      .toBeVisible();

    const quietSwitch = page.getByRole("switch", {
      name: "Quit without asking while nothing is running",
    });
    await expect.element(quietSwitch).toBeVisible();
    await quietSwitch.click();

    expect(setQuitAsks).toHaveBeenCalledWith(false);
  } finally {
    await screen.unmount();
  }
});

it("tells the app when resume preparation starts so its deadline pauses", async () => {
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
    revealQuitConfirmation: vi.fn(),
  } as Pick<
    DesktopBridge,
    "onQuitConfirmationRequest" | "replyQuitConfirmation" | "revealQuitConfirmation"
  > as DesktopBridge;
  useStore.setState({
    threadsHydrated: true,
    sidebarThreadSummaryById: {
      "thread-1": {
        id: "thread-1",
        title: "Running chat",
        hasLiveTailWork: true,
      } as never,
    },
    threadSessionById: {},
    threadShellById: {},
  });

  const queryClient = new QueryClient({
    defaultOptions: { queries: { enabled: false, retry: false } },
  });
  const screen = await render(
    <QueryClientProvider client={queryClient}>
      <RunningChatsQuitCoordinator />
    </QueryClientProvider>,
  );
  try {
    request?.({ requestId: "q1", presentation: "in-app" });
    await expect.element(page.getByRole("alertdialog"), { timeout: 5000 }).toBeVisible();
    await page.getByRole("button", { name: "Quit", exact: true }).click();

    expect(reply).toHaveBeenCalledWith({ requestId: "q1", phase: "preparing" });
  } finally {
    await screen.unmount();
  }
});

it("takes the question down when the app withdraws it", async () => {
  const title = `Quit ${APP_DISPLAY_NAME}?`;
  let request: ((payload: DesktopQuitConfirmationRequest) => void) | undefined;
  let withdraw: ((withdrawal: { requestId: string }) => void) | undefined;
  const reply = vi.fn();
  window.desktopBridge = {
    onQuitConfirmationRequest: (listener) => {
      request = listener;
      return () => {
        request = undefined;
      };
    },
    replyQuitConfirmation: reply,
    onQuitConfirmationWithdrawn: (listener) => {
      withdraw = listener;
      return () => {
        withdraw = undefined;
      };
    },
  } as Pick<
    DesktopBridge,
    "onQuitConfirmationRequest" | "replyQuitConfirmation" | "onQuitConfirmationWithdrawn"
  > as DesktopBridge;
  useStore.setState({
    threadsHydrated: true,
    sidebarThreadSummaryById: {},
    threadSessionById: {},
    threadShellById: {},
  });

  const queryClient = new QueryClient({
    defaultOptions: { queries: { enabled: false, retry: false } },
  });
  const screen = await render(
    <QueryClientProvider client={queryClient}>
      <RunningChatsQuitCoordinator />
    </QueryClientProvider>,
  );
  try {
    request?.({ requestId: "q1", presentation: "in-app" });
    await expect
      .element(page.getByRole("alertdialog", { name: title }), { timeout: 5000 })
      .toBeVisible();

    withdraw?.({ requestId: "q1" });

    await expect
      .element(page.getByRole("alertdialog", { name: title }), { timeout: 5000 })
      .not.toBeInTheDocument();
    expect(reply).not.toHaveBeenCalledWith(
      expect.objectContaining({ phase: "decision", allow: true }),
    );
  } finally {
    await screen.unmount();
  }
});
