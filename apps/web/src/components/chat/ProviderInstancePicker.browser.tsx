import type { ServerProviderStatus } from "@synara/contracts";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { ProviderInstancePicker } from "./ProviderInstancePicker";
import type { ProviderModelPickerInstance } from "./ProviderModelPicker";

const INSTANCES: ReadonlyArray<ProviderModelPickerInstance> = [
  {
    instanceId: "codex",
    provider: "codex",
    label: "Personal",
    enabled: true,
    isDefault: true,
  },
  {
    instanceId: "codex_work",
    provider: "codex",
    label: "Work",
    enabled: true,
    isDefault: false,
  },
];

const PROVIDERS: ReadonlyArray<ServerProviderStatus> = INSTANCES.map((instance) => ({
  provider: "codex",
  instanceId: instance.instanceId,
  driver: "codex",
  displayName: instance.label,
  status: "ready",
  available: true,
  authStatus: "authenticated",
  checkedAt: "2026-07-08T12:00:00.000Z",
}));

describe("ProviderInstancePicker", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("shows account selection separately from models", async () => {
    const onProviderInstanceChange = vi.fn();
    const onManageAccounts = vi.fn();
    const screen = await render(
      <ProviderInstancePicker
        provider="codex"
        providerInstances={INSTANCES}
        providers={PROVIDERS}
        selectedProviderInstanceId="codex"
        onProviderInstanceChange={onProviderInstanceChange}
        onManageAccounts={onManageAccounts}
      />,
    );

    try {
      await page.getByRole("button", { name: /Account: Personal/ }).click();
      await expect.element(page.getByText("Accounts", { exact: true })).toBeInTheDocument();
      await page.getByRole("menuitemradio", { name: "Work" }).click();

      expect(onProviderInstanceChange).toHaveBeenCalledWith("codex_work");
    } finally {
      await screen.unmount();
    }
  });

  it("keeps account management visible when only the default account exists", async () => {
    const onManageAccounts = vi.fn();
    const screen = await render(
      <ProviderInstancePicker
        provider="codex"
        providerInstances={[INSTANCES[0]!]}
        providers={[PROVIDERS[0]!]}
        selectedProviderInstanceId="codex"
        onProviderInstanceChange={vi.fn()}
        onManageAccounts={onManageAccounts}
      />,
    );

    try {
      await page.getByRole("button", { name: /Account: Personal/ }).click();
      await page.getByRole("menuitem", { name: "Manage accounts…" }).click();

      expect(onManageAccounts).toHaveBeenCalledOnce();
    } finally {
      await screen.unmount();
    }
  });

  it("does not allow a started thread to switch to a sibling account", async () => {
    const onProviderInstanceChange = vi.fn();
    const screen = await render(
      <ProviderInstancePicker
        provider="codex"
        providerInstances={INSTANCES}
        providers={PROVIDERS}
        selectedProviderInstanceId="codex"
        selectionLocked
        onProviderInstanceChange={onProviderInstanceChange}
        onManageAccounts={vi.fn()}
      />,
    );

    try {
      await page.getByRole("button", { name: /Account: Personal/ }).click();
      const workAccount = page.getByRole("menuitemradio", { name: /Work/ });
      await expect.element(workAccount).toBeDisabled();
      await expect.element(page.getByText("New thread")).toBeInTheDocument();
      expect(onProviderInstanceChange).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });
});
