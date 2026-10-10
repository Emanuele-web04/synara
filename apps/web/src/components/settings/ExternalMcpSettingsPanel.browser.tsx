import "../../index.css";

import type { ExternalMcpIntegration, ExternalMcpUpdateIntegrationInput } from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page } from "vitest/browser";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const api = vi.hoisted(() => ({
  server: {
    listExternalMcpIntegrations: vi.fn(),
    createExternalMcpIntegration: vi.fn(),
    updateExternalMcpIntegration: vi.fn(),
  },
  orchestration: { getShellSnapshot: vi.fn() },
}));
vi.mock("~/nativeApi", () => ({ ensureNativeApi: () => api }));
vi.mock("~/components/ui/toast", () => ({ toastManager: { add: vi.fn() } }));

import { ExternalMcpSettingsPanel } from "./ExternalMcpSettingsPanel";

const integration: ExternalMcpIntegration = {
  integrationId: "factory",
  name: "Factory",
  audience: "synara.external-mcp",
  clientKind: "other",
  capabilities: ["projects:read", "tasks:create", "tasks:wait", "tasks:read"],
  projectScope: "all",
  allowedProjects: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  expiresAt: "2099-01-01T00:00:00.000Z",
  pairedAt: "2026-01-01T00:00:00.000Z",
  lastUsedAt: null,
  revokedAt: null,
  rateLimitPerMinute: 60,
  concurrencyLimit: 2,
  stdio: { command: "synara", args: ["mcp", "serve"] },
};

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ExternalMcpSettingsPanel active />
    </QueryClientProvider>,
  );
}

describe("ExternalMcpSettingsPanel concurrency limits", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    api.server.listExternalMcpIntegrations.mockResolvedValue([integration]);
    api.orchestration.getShellSnapshot.mockResolvedValue({ projects: [] });
    api.server.createExternalMcpIntegration.mockResolvedValue({
      integration: { ...integration, integrationId: "new", concurrencyLimit: null },
      pairingCode: "test-pairing",
      pairingExpiresAt: "2099-01-01T00:00:00.000Z",
      setupCommand: "synara mcp pair",
      stdio: integration.stdio,
    });
  });

  it("creates an unlimited connection by default", async () => {
    const screen = await renderPanel();
    try {
      await expect
        .element(page.getByRole("spinbutton", { name: "Concurrent task limit", exact: true }))
        .toHaveValue(null);
      await page.getByRole("button", { name: "Create connection", exact: true }).click();
      await expect
        .poll(() => api.server.createExternalMcpIntegration.mock.calls[0]?.[0])
        .toMatchObject({
          concurrencyLimit: null,
        });
    } finally {
      await screen.unmount();
    }
  });

  it("saves and removes a cap, rejecting invalid values and preserving a failed draft", async () => {
    let saved = integration;
    api.server.listExternalMcpIntegrations.mockImplementation(async () => [saved]);
    api.server.updateExternalMcpIntegration.mockImplementation(
      async (input: ExternalMcpUpdateIntegrationInput) => {
        saved = { ...saved, concurrencyLimit: input.concurrencyLimit };
        return saved;
      },
    );
    const screen = await renderPanel();
    try {
      await page.getByRole("button", { name: "Edit task limit for Factory" }).click();
      const limit = page.getByRole("spinbutton", { name: "Factory concurrent task limit" });
      await expect.element(limit).toHaveValue(2);
      await limit.fill("0");
      await expect.element(page.getByRole("button", { name: "Save limit" })).toBeDisabled();
      await limit.fill("8");
      api.server.updateExternalMcpIntegration.mockRejectedValueOnce(new Error("Connection lost"));
      await page.getByRole("button", { name: "Save limit" }).click();
      await expect.element(page.getByRole("button", { name: "Save limit" })).toBeEnabled();
      await expect.element(limit).toHaveValue(8);
      await page.getByRole("button", { name: "Save limit" }).click();
      await expect.element(page.getByText("Concurrent tasks: 8", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Edit task limit for Factory" }).click();
      await limit.fill("");
      await page.getByRole("button", { name: "Save limit" }).click();
      await expect
        .element(page.getByText("Concurrent tasks: No limit", { exact: true }))
        .toBeVisible();
      expect(api.server.updateExternalMcpIntegration).toHaveBeenLastCalledWith({
        integrationId: "factory",
        concurrencyLimit: null,
      });
    } finally {
      await screen.unmount();
    }
  });
});
