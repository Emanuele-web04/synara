import "../index.css";

import type { KeepAwakeMode, ServerKeepAwakeUpdatedPayload } from "@synara/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "vitest-browser-react";
import { page } from "vitest/browser";
import { useState } from "react";

const pushes = vi.hoisted(() => ({
  listeners: new Set<(payload: ServerKeepAwakeUpdatedPayload) => void>(),
}));

vi.mock("../wsNativeApi", async (original) => ({
  ...(await original<typeof import("../wsNativeApi")>()),
  onServerKeepAwakeUpdated: (listener: (payload: ServerKeepAwakeUpdatedPayload) => void) => {
    pushes.listeners.add(listener);
    return () => pushes.listeners.delete(listener);
  },
}));

import type { DesktopKeepAwakeState } from "@synara/contracts";
import { useDesktopKeepAwake } from "../hooks/useDesktopKeepAwake";
import { useKeepAwakeState } from "../hooks/useKeepAwakeState";
import { KeepAwakeSettingsSection, RemoteAccessKeepAwakeRow } from "./KeepAwakeControls";

const desktopKeepAwake = {
  state: { enabled: false, active: false, onBattery: false } as DesktopKeepAwakeState,
  getState: vi.fn(async () => desktopKeepAwake.state),
  setEnabled: vi.fn(async (enabled: boolean) => {
    desktopKeepAwake.state = { ...desktopKeepAwake.state, enabled, active: enabled };
    return desktopKeepAwake.state;
  }),
  setRemoteAccessAllowed: vi.fn(async () => desktopKeepAwake.state),
};

/** General › Power: the agent keep-awake plus the desktop's remote-access keep-awake. */
function PowerHarness() {
  const state = useKeepAwakeState();
  const remote = useDesktopKeepAwake();
  const [mode, setMode] = useState<KeepAwakeMode>("off");
  return (
    <KeepAwakeSettingsSection
      title="settings:general_power"
      state={state}
      mode={mode}
      defaultMode="off"
      onSelectMode={setMode}
      extraRows={remote.state ? <RemoteAccessKeepAwakeRow keepAwake={remote} /> : null}
    />
  );
}

function ControlsHarness() {
  const state = useKeepAwakeState();
  const [mode, setMode] = useState<KeepAwakeMode>("off");
  return (
    <KeepAwakeSettingsSection
      title="settings:general_power"
      state={state}
      mode={mode}
      defaultMode="off"
      onSelectMode={setMode}
    />
  );
}

function push(mode: KeepAwakeMode, active = false, available = true, error: string | null = null) {
  for (const listener of pushes.listeners) {
    listener({ keepAwake: { available, mode, active, error } });
  }
}

beforeEach(async () => {
  pushes.listeners.clear();
  await page.viewport(800, 600);
});

afterEach(async () => {
  await cleanup();
  pushes.listeners.clear();
});

describe("Keep Awake controls", () => {
  it("hides before the first push and when the server is unavailable", async () => {
    const mounted = await render(<ControlsHarness />);
    expect(mounted.container.querySelector("button")).toBeNull();
    push("always", false, false);
    await expect.poll(() => mounted.container.querySelector("button")).toBeNull();
    push("always", true);
    await expect
      .element(page.getByRole("radiogroup", { name: "Keep computer awake" }))
      .toBeVisible();
    push("always", false, false);
    await expect
      .element(page.getByRole("radiogroup", { name: "Keep computer awake" }))
      .not.toBeInTheDocument();
  });

  it("tracks idle, active and error state from server pushes", async () => {
    await render(<ControlsHarness />);
    push("agent");
    await expect.element(page.getByText("Agent · Idle", { exact: true })).toBeVisible();
    push("agent", true);
    await expect.element(page.getByText("Agent · Active", { exact: true })).toBeVisible();
    push("agent", false, true, "caffeinate could not start");
    await expect
      .element(page.getByText("caffeinate could not start", { exact: true }))
      .toBeVisible();
  });

  it("selects a mode and resets it in Settings", async () => {
    await render(<ControlsHarness />);
    push("off");
    await page.getByRole("radio", { name: "Agent", exact: true }).click();
    await expect.element(page.getByRole("radio", { name: "Agent", exact: true })).toBeChecked();
    await page.getByRole("button", { name: "Reset keep computer awake to default" }).click();
    await expect.element(page.getByRole("radio", { name: "Off", exact: true })).toBeChecked();
  });

  it("selects the always and agent modes from Settings", async () => {
    await render(<ControlsHarness />);
    push("off");
    await page.getByRole("radio", { name: "On", exact: true }).click();
    await expect.element(page.getByRole("radio", { name: "On", exact: true })).toBeChecked();
    await page.getByRole("radio", { name: "Agent", exact: true }).click();
    await expect.element(page.getByRole("radio", { name: "Agent", exact: true })).toBeChecked();
  });

  describe("remote-access keep awake under General › Power", () => {
    beforeEach(() => {
      desktopKeepAwake.state = { enabled: false, active: false, onBattery: false };
      desktopKeepAwake.setEnabled.mockClear();
      (window as { desktopBridge?: unknown }).desktopBridge = { keepAwake: desktopKeepAwake };
    });
    afterEach(() => {
      delete (window as { desktopBridge?: unknown }).desktopBridge;
    });

    it("sits in the same Power card as the agent keep awake", async () => {
      await render(<PowerHarness />);
      push("off");
      await expect.element(page.getByText("Power", { exact: true })).toBeVisible();
      await expect.element(page.getByRole("radio", { name: "Agent", exact: true })).toBeVisible();
      await expect
        .element(page.getByRole("switch", { name: "Stay awake for remote access" }))
        .toBeVisible();
    });

    it("persists through the desktop bridge", async () => {
      await render(<PowerHarness />);
      const toggle = page.getByRole("switch", { name: "Stay awake for remote access" });
      await expect.element(toggle).not.toBeChecked();
      await toggle.click();
      await vi.waitFor(() => expect(desktopKeepAwake.setEnabled).toHaveBeenCalledWith(true));
      await expect.element(toggle).toBeChecked();
    });

    it("keeps the Power card when only the desktop keep awake exists", async () => {
      await render(<PowerHarness />);
      push("off", false, false);
      await expect
        .element(page.getByRole("switch", { name: "Stay awake for remote access" }))
        .toBeVisible();
      expect(page.getByRole("radio", { name: "Agent", exact: true }).elements()).toHaveLength(0);
    });

    it("hides the row without a desktop bridge", async () => {
      delete (window as { desktopBridge?: unknown }).desktopBridge;
      await render(<PowerHarness />);
      push("off");
      await expect.element(page.getByRole("radio", { name: "Agent", exact: true })).toBeVisible();
      expect(page.getByRole("switch", { name: /remote access/ }).elements()).toHaveLength(0);
    });
  });
});
