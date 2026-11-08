import "../index.css";

import type { DesktopBridge, DesktopQuitConfirmationRequest } from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page, userEvent } from "vitest/browser";
import { afterEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { useStore } from "~/store";
import { APP_DISPLAY_NAME } from "~/branding";
import { setLanguagePreference } from "~/i18n";

import { RunningChatsQuitCoordinator } from "./RunningChatsQuitCoordinator";

vi.mock("~/lib/wsHttpUrl", async (original) => ({
  ...(await original<typeof import("../lib/wsHttpUrl")>()),
  resolveWsHttpUrl: () => "",
}));

const originalBridge = window.desktopBridge;
const originalState = useStore.getState();

afterEach(() => {
  setLanguagePreference("en");
  if (originalBridge) window.desktopBridge = originalBridge;
  else delete window.desktopBridge;
  useStore.setState(originalState, true);
});

it.each([
  { locale: "en" as const, title: `Quit ${APP_DISPLAY_NAME}?`, quit: "Quit" },
  { locale: "zh-CN" as const, title: `退出 ${APP_DISPLAY_NAME}？`, quit: "退出" },
])(
  "requires localized confirmation for an idle quit ($locale), supports Escape, and asks again after cancel",
  async ({ locale, title, quit }) => {
    setLanguagePreference(locale);
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
    } as Pick<
      DesktopBridge,
      "onQuitConfirmationRequest" | "replyQuitConfirmation"
    > as DesktopBridge;
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
      await expect
        .element(page.getByRole("alertdialog", { name: title }), { timeout: 5000 })
        .toBeVisible();
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
      await page.getByRole("button", { name: quit, exact: true }).click();
      expect(reply).toHaveBeenCalledWith({ requestId: "q2", phase: "decision", allow: true });
    } finally {
      await screen.unmount();
    }
  },
);
