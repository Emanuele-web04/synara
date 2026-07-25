// FILE: AccountsSettingsPanel.browser.tsx
// Purpose: Browser end-to-end test for Settings → Accounts: renders the real
//          panel against a fake providerAccounts native API (no network, no
//          server), verifies account-zero and managed rows, and drives the
//          connect dialog through the API-key flow.
// Layer: Browser UI test

import "../../index.css";

import type { ProviderAccountsConnectStatus, ProviderAccountsSnapshot } from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const harness = vi.hoisted(() => {
  const snapshot = {
    providers: [
      {
        provider: "codex",
        activeOrdinal: 1,
        accounts: [
          { provider: "codex", ordinal: 0, createdAt: "2026-01-01T00:00:00.000Z" },
          {
            provider: "codex",
            ordinal: 1,
            createdAt: "2026-01-02T00:00:00.000Z",
            identity: { hint: "API key ending e2e1" },
            agent: { generation: 1, state: "connected", authMethod: "apiKey" },
          },
        ],
        capabilities: {
          agent: { oauth: "supported", apiKey: "supported" },
          app: { oauth: "unsupported", supportLevel: "unsupported" },
        },
      },
    ],
  };
  return {
    snapshot,
    beginConnect: vi.fn(async () => ({ operationId: "op-e2e-1" })),
    connectStatus: {
      operationId: "op-e2e-1",
      state: "succeeded",
      provider: "codex",
      surface: "agent",
      ordinal: 2,
    },
  };
});

vi.mock("~/nativeApi", () => ({
  ensureNativeApi: () => ({
    providerAccounts: {
      getSnapshot: async () => harness.snapshot as unknown as ProviderAccountsSnapshot,
      getIntegrationStatus: async () => ({
        cliIntegrationEnabled: false,
        launcherInstalled: false,
        shimDir: "/tmp/synara-e2e/bin",
        shimDirOnPath: false,
        launcherEntryExists: true,
        platformSupported: true,
      }),
      beginConnect: harness.beginConnect,
      getConnectStatus: async () =>
        harness.connectStatus as unknown as ProviderAccountsConnectStatus,
      cancelConnect: async () => harness.connectStatus,
    },
  }),
}));

import { AccountsSettingsPanel } from "./AccountsSettingsPanel";

const renderPanel = () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <AccountsSettingsPanel active />
    </QueryClientProvider>,
  );
};

describe("AccountsSettingsPanel", () => {
  afterEach(() => {
    harness.beginConnect.mockClear();
    document.body.innerHTML = "";
  });

  it("lists account-zero and managed rows and drives the connect dialog", async () => {
    await renderPanel();

    // Account zero (native) row and the managed active account row.
    await vi.waitFor(() => expect(document.body.textContent).toContain("Codex 0 (native)"));
    expect(document.body.textContent).toContain("Your own Codex login, unmanaged.");
    expect(document.body.textContent).toContain("Codex 1");
    expect(document.body.textContent).toContain("Active");
    expect(document.body.textContent).toContain("API key ending e2e1");
    expect(document.body.textContent).toContain("Agent: Connected");
    // CLI integration section renders with the install action.
    expect(document.body.textContent).toContain("Terminal launcher");
    await expect.element(page.getByRole("button", { name: "Install" })).toBeVisible();

    // Open the connect dialog from the add-account row.
    expect(document.body.textContent).toContain("Add Codex account");
    await page.getByRole("button", { name: "Connect", exact: true }).click();

    const dialog = page.getByRole("dialog");
    await expect.element(dialog.getByText("Connect Codex account")).toBeVisible();
    // Both supported auth methods are offered; OAuth is the default surface.
    await expect.element(dialog.getByRole("button", { name: "Browser sign-in" })).toBeVisible();
    await expect.element(dialog.getByRole("button", { name: "API key" })).toBeVisible();
    expect(dialog.element().textContent).toContain(
      "Sign in with your browser to add a managed Codex account.",
    );

    // Switch to the API-key method and submit a key.
    await dialog.getByRole("button", { name: "API key" }).click();
    expect(dialog.element().textContent).toContain("Store an API key for a managed Codex account.");
    await dialog.getByPlaceholder("Codex API key").fill("sk-browser-e2e");
    await dialog.getByRole("button", { name: "Connect", exact: true }).click();

    await vi.waitFor(() =>
      expect(harness.beginConnect).toHaveBeenCalledWith({
        kind: "agent-api-key",
        provider: "codex",
        apiKey: "sk-browser-e2e",
      }),
    );
    await expect.element(dialog.getByText("Connected as Codex 2.")).toBeVisible();
    await dialog.getByRole("button", { name: "Done" }).click();
    await vi.waitFor(() => expect(page.getByRole("dialog").query()).toBeNull());
  });
});
