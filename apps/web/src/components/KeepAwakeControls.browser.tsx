import "../index.css";

import type { KeepAwakeMode, ServerKeepAwakeUpdatedPayload } from "@synara/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "vitest-browser-react";
import { page, userEvent } from "vitest/browser";
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

import { useKeepAwakeState } from "../hooks/useKeepAwakeState";
import { KeepAwakeSettingsSection, SidebarKeepAwakeMenu } from "./KeepAwakeControls";

function ControlsHarness() {
  const state = useKeepAwakeState();
  const [mode, setMode] = useState<KeepAwakeMode>("off");
  return (
    <>
      <SidebarKeepAwakeMenu state={state} onSelectMode={setMode} />
      <KeepAwakeSettingsSection
        state={state}
        mode={mode}
        defaultMode="off"
        onSelectMode={setMode}
      />
    </>
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
    await expect.element(page.getByTestId("sidebar-keep-awake-button")).toBeVisible();
    push("always", false, false);
    await expect.element(page.getByTestId("sidebar-keep-awake-button")).not.toBeInTheDocument();
  });

  it("tracks idle, active and error state from server pushes", async () => {
    await render(<ControlsHarness />);
    push("agent");
    const button = page.getByTestId("sidebar-keep-awake-button");
    await expect.element(button).toBeVisible();
    await expect.element(page.getByText("Agent · Idle", { exact: true })).toBeVisible();
    push("agent", true);
    await expect.poll(() => button.element().querySelector(".text-primary") !== null).toBe(true);
    await expect.element(page.getByText("Agent · Active", { exact: true })).toBeVisible();
    push("agent", false, true, "caffeinate could not start");
    await expect
      .poll(() => button.element().querySelector(".text-destructive") !== null)
      .toBe(true);
    await button.click();
    await expect
      .element(page.getByText("caffeinate could not start", { exact: true }))
      .toBeVisible();
  });

  it("selects a mode from the rail menu and resets it in Settings", async () => {
    await render(<ControlsHarness />);
    push("off");
    await page.getByTestId("sidebar-keep-awake-button").click();
    await page.getByRole("menuitemradio", { name: /Agent/ }).click();
    await expect.element(page.getByRole("radio", { name: "Agent", exact: true })).toBeChecked();
    await userEvent.keyboard("{Escape}");
    await expect.element(page.getByRole("menu")).not.toBeInTheDocument();
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
});
