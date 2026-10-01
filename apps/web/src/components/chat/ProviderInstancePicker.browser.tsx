import type { ServerProviderStatus } from "@synara/contracts";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { ProviderInstancePicker } from "./ProviderInstancePicker";
import type { ProviderModelPickerInstance } from "./ProviderModelPicker";

// Accounts are picked in the model picker. This menu only appears when the composer's
// account no longer exists, so every case starts from a selection that is gone.
const REMOVED_ACCOUNT_ID = "codex_removed";

const INSTANCES: ReadonlyArray<ProviderModelPickerInstance> = [
  { instanceId: "codex", provider: "codex", label: "Codex", enabled: true, isDefault: true },
  { instanceId: "codex_work", provider: "codex", label: "Work", enabled: true, isDefault: false },
];

function accountStatus(
  instance: ProviderModelPickerInstance,
  overrides: Partial<ServerProviderStatus> = {},
): ServerProviderStatus {
  return {
    provider: instance.provider,
    instanceId: instance.instanceId,
    driver: instance.provider,
    displayName: instance.label,
    status: "ready",
    available: true,
    authStatus: "authenticated",
    checkedAt: "2026-07-08T12:00:00.000Z",
    ...overrides,
  };
}

const PROVIDERS = INSTANCES.map((instance) => accountStatus(instance));

describe("ProviderInstancePicker", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("names the missing account and offers every configured account as a replacement", async () => {
    const onProviderInstanceChange = vi.fn();
    const screen = await render(
      <ProviderInstancePicker
        provider="codex"
        providerInstances={INSTANCES}
        providers={PROVIDERS}
        selectedProviderInstanceId={REMOVED_ACCOUNT_ID}
        onProviderInstanceChange={onProviderInstanceChange}
        onManageAccounts={vi.fn()}
      />,
    );

    try {
      await page.getByRole("button", { name: /Account: Missing account/ }).click();
      await expect.element(page.getByText("Accounts", { exact: true })).toBeInTheDocument();
      await expect
        .element(page.getByRole("menuitemradio", { name: /Missing account/ }))
        .toBeDisabled();
      await expect.element(page.getByRole("menuitemradio", { name: "Codex" })).toBeEnabled();
      await page.getByRole("menuitemradio", { name: "Work" }).click();

      expect(onProviderInstanceChange).toHaveBeenCalledWith("codex_work");
    } finally {
      await screen.unmount();
    }
  });

  it("does not offer an account that is turned off or not signed in", async () => {
    const onProviderInstanceChange = vi.fn();
    const signedOut: ProviderModelPickerInstance = {
      instanceId: "codex_side",
      provider: "codex",
      label: "Side",
      enabled: true,
      isDefault: false,
    };
    const screen = await render(
      <ProviderInstancePicker
        provider="codex"
        providerInstances={[INSTANCES[0]!, { ...INSTANCES[1]!, enabled: false }, signedOut]}
        providers={[
          PROVIDERS[0]!,
          PROVIDERS[1]!,
          accountStatus(signedOut, { authStatus: "unauthenticated" }),
        ]}
        selectedProviderInstanceId={REMOVED_ACCOUNT_ID}
        onProviderInstanceChange={onProviderInstanceChange}
        onManageAccounts={vi.fn()}
      />,
    );

    try {
      await page.getByRole("button", { name: /Account: Missing account/ }).click();
      const work = page.getByRole("menuitemradio", { name: /Work/ });
      await expect.element(work).toBeDisabled();
      expect(work.element().textContent).toContain("Disabled");
      const side = page.getByRole("menuitemradio", { name: /Side/ });
      await expect.element(side).toBeDisabled();
      expect(side.element().textContent).toContain("Sign in");
      await expect.element(page.getByRole("menuitemradio", { name: "Codex" })).toBeEnabled();
      expect(onProviderInstanceChange).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("keeps a started thread on its missing account", async () => {
    const onProviderInstanceChange = vi.fn();
    const screen = await render(
      <ProviderInstancePicker
        provider="codex"
        providerInstances={INSTANCES}
        providers={PROVIDERS}
        selectedProviderInstanceId={REMOVED_ACCOUNT_ID}
        selectionLocked
        onProviderInstanceChange={onProviderInstanceChange}
        onManageAccounts={vi.fn()}
      />,
    );

    try {
      await page.getByRole("button", { name: /Account: Missing account/ }).click();
      await expect
        .element(page.getByRole("menuitemradio", { name: /Missing account/ }))
        .toBeDisabled();
      for (const name of [/Codex/, /Work/]) {
        const replacement = page.getByRole("menuitemradio", { name });
        await expect.element(replacement).toBeDisabled();
        expect(replacement.element().textContent).toContain("New thread");
      }
      expect(onProviderInstanceChange).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("links to account settings, where the missing account can be added back", async () => {
    const onManageAccounts = vi.fn();
    const screen = await render(
      <ProviderInstancePicker
        provider="codex"
        providerInstances={[INSTANCES[0]!]}
        providers={[PROVIDERS[0]!]}
        selectedProviderInstanceId={REMOVED_ACCOUNT_ID}
        onProviderInstanceChange={vi.fn()}
        onManageAccounts={onManageAccounts}
      />,
    );

    try {
      await page.getByRole("button", { name: /Account: Missing account/ }).click();
      await page.getByRole("menuitem", { name: "Manage accounts…" }).click();

      expect(onManageAccounts).toHaveBeenCalledOnce();
    } finally {
      await screen.unmount();
    }
  });
});
