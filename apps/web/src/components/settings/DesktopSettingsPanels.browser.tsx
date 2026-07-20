// FILE: DesktopSettingsPanels.browser.tsx
// Purpose: Lock the browser/native lifecycle behavior owned by the desktop settings panels.
// Layer: Browser UI test

import "../../index.css";

import type { DesktopAppSnapState } from "@synara/contracts";
import type { AppSettingsBinding } from "~/appSettings";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const harness = vi.hoisted(() => ({
  settings: {
    appSnapPlaySound: true,
    enableAppSnap: false,
    enableSystemTaskCompletionNotifications: false,
    enableTaskCompletionToasts: true,
  },
  defaults: {
    appSnapPlaySound: true,
    enableAppSnap: false,
    enableSystemTaskCompletionNotifications: false,
    enableTaskCompletionToasts: true,
  },
  updateSettings: vi.fn(),
  readBrowserPermission: vi.fn(() => "default"),
  requestBrowserPermission: vi.fn(),
  toastAdd: vi.fn(),
}));

vi.mock("~/env", () => ({ isElectron: false }));

vi.mock("~/notifications/taskCompletion", () => ({
  buildNotificationSettingsSupportText: (permission: string) => `Permission: ${permission}`,
  readBrowserNotificationPermissionState: harness.readBrowserPermission,
  requestBrowserNotificationPermission: harness.requestBrowserPermission,
}));

vi.mock("~/components/ui/toast", () => ({
  toastManager: { add: harness.toastAdd },
}));

import { AppSnapSettingsPanel, NotificationsSettingsPanel } from "./DesktopSettingsPanels";

function settingsBinding(): AppSettingsBinding {
  return {
    settings: harness.settings,
    defaults: harness.defaults,
    updateSettings: harness.updateSettings,
  } as unknown as AppSettingsBinding;
}

function AppSnapActivityHarness() {
  const [active, setActive] = useState(true);
  return (
    <>
      <button type="button" onClick={() => setActive(false)}>
        Leave AppSnap
      </button>
      <button type="button" onClick={() => setActive(true)}>
        Return to AppSnap
      </button>
      <AppSnapSettingsPanel active={active} {...settingsBinding()} />
    </>
  );
}

const READY_STATE: DesktopAppSnapState = {
  platform: "macos",
  supported: true,
  enabled: true,
  status: "ready",
  shortcut: "both-option-keys",
  inputMonitoringPermission: "granted",
  screenRecordingPermission: "granted",
  message: null,
};

function setDesktopBridge(value: unknown): void {
  Object.defineProperty(window, "desktopBridge", {
    configurable: true,
    value,
  });
}

beforeEach(() => {
  harness.updateSettings.mockReset();
  harness.readBrowserPermission.mockReset().mockReturnValue("default");
  harness.requestBrowserPermission.mockReset();
  harness.toastAdd.mockReset();
  setDesktopBridge(undefined);
});

afterEach(() => {
  document.body.innerHTML = "";
  setDesktopBridge(undefined);
});

describe("NotificationsSettingsPanel", () => {
  it("keeps the preference disabled and explains a denied browser permission", async () => {
    harness.requestBrowserPermission.mockResolvedValue("denied");
    const mounted = await render(<NotificationsSettingsPanel active {...settingsBinding()} />);

    await mounted.getByLabelText("Desktop activity notifications").click();

    await vi.waitFor(() => {
      expect(harness.updateSettings).toHaveBeenCalledWith({
        enableSystemTaskCompletionNotifications: false,
      });
      expect(harness.toastAdd).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "warning",
          title: "Desktop notifications unavailable",
        }),
      );
    });

    await mounted.unmount();
  });
});

describe("AppSnapSettingsPanel", () => {
  it("owns the native state subscription and releases it on unmount", async () => {
    const unsubscribe = vi.fn();
    const getState = vi.fn().mockResolvedValue(READY_STATE);
    const requestPermissions = vi.fn().mockResolvedValue(READY_STATE);
    const setEnabled = vi.fn().mockResolvedValue(READY_STATE);
    const onState = vi.fn(() => unsubscribe);
    setDesktopBridge({
      appSnap: {
        getState,
        requestPermissions,
        setEnabled,
        onState,
      },
    });

    const mounted = await render(<AppSnapActivityHarness />);
    await expect
      .element(mounted.getByText("Listening — press both Option keys to snap"))
      .toBeVisible();
    expect(onState).toHaveBeenCalledOnce();

    await mounted.getByRole("button", { name: "Leave AppSnap" }).click();
    await mounted.getByRole("button", { name: "Return to AppSnap" }).click();
    expect(onState).toHaveBeenCalledOnce();
    expect(unsubscribe).not.toHaveBeenCalled();

    await mounted.getByLabelText("Enable AppSnap").click();
    await vi.waitFor(() => {
      expect(requestPermissions).toHaveBeenCalledOnce();
      expect(setEnabled).toHaveBeenCalledWith(true);
      expect(harness.updateSettings).toHaveBeenCalledWith({ enableAppSnap: true });
    });

    await mounted.unmount();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
