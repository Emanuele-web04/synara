import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { ComputerAuditHistorySection } from "./ComputerAuditHistorySection";
import { ComputerGettingStarted } from "./ComputerGettingStarted";
import { ComputerSettingsPanel } from "./ComputerSettingsPanel";
import { AppSettingsSchema } from "~/appSettings";
import type { ComputerStatusResult, DesktopAppSnapState } from "@synara/contracts";
import { COMPUTER_PERMISSION_KINDS } from "@synara/shared/computerGrants";
import { serverQueryKeys } from "~/lib/serverReactQuery";

const api = vi.hoisted(() => ({ getAuditHistory: vi.fn(), getStatus: vi.fn() }));
vi.mock("~/nativeApi", () => ({ ensureNativeApi: () => ({ computer: api }) }));

beforeEach(() => {
  api.getAuditHistory.mockReset();
  api.getStatus.mockReset();
  window.localStorage.removeItem("synara:computer-getting-started:v1");
});

it("remembers dismissal of the first-use guide and lets the user reopen it", async () => {
  const first = await render(<ComputerGettingStarted appSnapAvailable={true} />);
  await first.getByRole("button", { name: "Got it", exact: true }).click();
  await expect.element(first.getByRole("button", { name: "Show guide" })).toBeVisible();
  await first.unmount();

  const reopened = await render(<ComputerGettingStarted appSnapAvailable={true} />);
  await expect.element(reopened.getByRole("button", { name: "Got it" })).not.toBeInTheDocument();
  await reopened.getByRole("button", { name: "Show guide" }).click();
  await expect.element(reopened.getByRole("heading", { name: "Follow and stop" })).toBeVisible();
  await reopened.unmount();
});

it("reads history only when opened, pages on request, and refreshes from the latest entry", async () => {
  const record = {
    id: "1".repeat(64),
    ts: "2026-09-20T12:00:00.000Z",
    tool: "computer_browser_click",
    effect: "dispatched-unknown",
  };
  api.getAuditHistory
    .mockResolvedValueOnce({
      entries: [record],
      nextCursor: "older-page",
      status: "available",
      truncated: false,
    })
    .mockResolvedValueOnce({
      entries: [{ ...record, id: "2".repeat(64) }],
      nextCursor: null,
      status: "available",
      truncated: false,
    })
    .mockResolvedValueOnce({
      entries: [],
      nextCursor: null,
      status: "available",
      truncated: false,
    });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const screen = await render(
    <QueryClientProvider client={queryClient}>
      <ComputerAuditHistorySection />
    </QueryClientProvider>,
  );
  expect(api.getAuditHistory).not.toHaveBeenCalled();

  await screen.getByRole("button", { name: "Show history" }).click();
  await expect.poll(() => api.getAuditHistory.mock.calls.length).toBe(1);
  expect(api.getAuditHistory).toHaveBeenNthCalledWith(1, { limit: 30 });
  await screen.getByRole("button", { name: "Load older actions" }).click();
  await expect.poll(() => api.getAuditHistory.mock.calls.length).toBe(2);
  expect(api.getAuditHistory).toHaveBeenNthCalledWith(2, { limit: 30, before: "older-page" });

  await screen.getByRole("button", { name: "Refresh history" }).click();
  await expect.poll(() => api.getAuditHistory.mock.calls.length).toBe(3);
  expect(api.getAuditHistory).toHaveBeenNthCalledWith(3, { limit: 30 });
  await expect.element(screen.getByText("No recorded actions yet.")).toBeVisible();
  await screen.getByRole("button", { name: "Hide history" }).click();
  expect(api.getAuditHistory).toHaveBeenCalledTimes(3);
  await screen.unmount();
  queryClient.clear();
});

afterEach(() => vi.unstubAllGlobals());

it.each<{
  platform: DesktopAppSnapState["platform"];
  supported: boolean;
  endpoint: string;
  showSetup: boolean;
  setupError?: string;
  unrelatedAppSnapError?: string;
}>([
  { platform: "macos" as const, supported: true, endpoint: "ws://127.0.0.1:4111", showSetup: true },
  {
    platform: "linux" as const,
    supported: false,
    endpoint: "ws://127.0.0.1:4111",
    showSetup: false,
  },
  {
    platform: "macos" as const,
    supported: true,
    endpoint: "wss://remote.synara.test",
    showSetup: false,
  },
  {
    platform: "macos",
    supported: true,
    endpoint: "ws://127.0.0.1:4111",
    showSetup: true,
    setupError:
      "macOS cannot locate this running app. Move this app to Applications and reopen it before granting access.",
  },
  {
    platform: "macos",
    supported: true,
    endpoint: "ws://127.0.0.1:4111",
    showSetup: true,
    unrelatedAppSnapError: "The selected AppSnap window closed before capture.",
  },
])(
  "uses local supported grant evidence in Computer settings: $platform/$endpoint",
  async ({ platform, supported, endpoint, showSetup, setupError, unrelatedAppSnapError }) => {
    const appSnapState: DesktopAppSnapState = {
      platform,
      supported,
      enabled: false,
      status: setupError || unrelatedAppSnapError ? "error" : "disabled",
      shortcut: null,
      accessibilityPermission: "denied",
      inputMonitoringPermission: "denied",
      screenRecordingPermission: "denied",
      message: setupError ?? unrelatedAppSnapError ?? null,
      ...(setupError
        ? { permissionSetupErrorCode: "permission_setup_registration_unresolved" as const }
        : {}),
      appDisplayName: "Synara",
    };
    const appSnap = {
      getState: vi.fn(async () => appSnapState),
      onState: vi.fn(() => () => {}),
      onPermissionGuideState: vi.fn(() => () => {}),
    };
    vi.stubGlobal("desktopBridge", { getWsUrl: () => endpoint, appSnap });
    const idleStatus: ComputerStatusResult = {
      computerId: "desktop",
      availability: { kind: "available", backend: "cua" },
      health: {
        status: "connected",
        consecutiveFailures: 0,
        reconnects: 0,
        captureAvailable: true,
      },
      capabilities: {
        windows: true,
        windowBounds: true,
        stacking: true,
        capture: true,
        input: platform === "macos",
        clipboard: true,
        focus: false,
        raise: false,
        ghostCursor: false,
        visibleDesktop: true,
      },
    };
    api.getStatus.mockResolvedValue(idleStatus);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(serverQueryKeys.computerStatus(), idleStatus);
    const settings = AppSettingsSchema.makeUnsafe({});
    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <ComputerSettingsPanel
          settings={settings}
          defaults={settings}
          updateSettings={vi.fn()}
          active
        />
      </QueryClientProvider>,
    );
    if (endpoint.includes("127.0.0.1")) {
      await expect.poll(() => appSnap.getState.mock.calls.length).toBe(1);
      expect(appSnap.getState).toHaveBeenCalledWith(COMPUTER_PERMISSION_KINDS);
    } else {
      expect(appSnap.getState).not.toHaveBeenCalled();
    }
    if (showSetup) {
      await expect
        .element(screen.getByRole("button", { name: "Set up", exact: true }))
        .toBeVisible();
      if (setupError) {
        await expect
          .element(screen.getByText("Computer permission setup needs attention"))
          .toBeVisible();
        await expect.element(screen.getByText(setupError)).toBeVisible();
      } else {
        await expect
          .element(screen.getByText("Computer permission setup needs attention"))
          .not.toBeInTheDocument();
        if (unrelatedAppSnapError)
          await expect.element(screen.getByText(unrelatedAppSnapError)).not.toBeInTheDocument();
        await expect
          .element(
            screen.getByText(
              "Computer control needs Accessibility, Screen Recording and Input Monitoring",
            ),
          )
          .toBeVisible();
      }
      await screen.getByRole("button", { name: "Show", exact: true }).click();
      await expect.element(screen.getByText("Input Monitoring", { exact: true })).toBeVisible();
    } else {
      await expect
        .element(screen.getByRole("button", { name: "Set up", exact: true }))
        .not.toBeInTheDocument();
      await screen.getByRole("button", { name: "Show", exact: true }).click();
      await expect
        .element(screen.getByText("Input Monitoring", { exact: true }))
        .not.toBeInTheDocument();
    }
    await screen.unmount();
    queryClient.clear();
  },
);
