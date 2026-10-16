// Reconnect must expose the current callback URL without requiring saved credentials again.
import "../../index.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { McpConnectorsSettingsPanel } from "./McpConnectorsSettingsPanel";

const api = vi.hoisted(() => ({
  listMcpConnectors: vi.fn(),
  getMcpConnectorSetup: vi.fn(),
  connectMcpConnector: vi.fn(),
  openExternal: vi.fn(),
}));
vi.mock("~/nativeApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../nativeApi")>()),
  ensureNativeApi: () => ({ server: api, shell: { openExternal: api.openExternal } }),
}));

it.each(["slack", null])(
  "shows the changed redirect when reconnecting an own-app connector (%s)",
  async (presetId) => {
    const name = presetId ? "Slack" : "Custom app";
    api.listMcpConnectors.mockResolvedValue([
      {
        connectorId: "own-app",
        presetId,
        name,
        url: "https://example.com/mcp",
        serverName: "own_app_connector",
        authKind: "oauth",
        usesOwnOAuthApp: true,
        status: "needs-auth",
        createdAt: "2026-10-14T10:00:00Z",
        updatedAt: "2026-10-14T10:00:00Z",
      },
    ]);
    const redirectUrl = "http://127.0.0.1:5999/oauth/mcp/callback";
    api.getMcpConnectorSetup.mockResolvedValue({ redirectUrl });
    api.connectMcpConnector.mockResolvedValue({
      authorizationUrl: "https://example.com/authorize",
      connector: null,
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const screen = await render(
      <QueryClientProvider client={queryClient}>
        <McpConnectorsSettingsPanel active />
      </QueryClientProvider>,
    );
    try {
      await screen.getByRole("button", { name: "Reconnect", exact: true }).click();
      await expect
        .element(screen.getByRole("textbox", { name: "Redirect URL" }), { timeout: 3_000 })
        .toHaveValue(redirectUrl);
      const connect = screen.getByRole("button", { name: `Continue to ${name}` });
      await expect.element(connect).toBeEnabled();
      await connect.click();
      await expect
        .poll(() => api.connectMcpConnector.mock.calls.at(-1)?.[0])
        .toEqual(presetId ? { presetId } : { url: "https://example.com/mcp", name });
    } finally {
      await screen.unmount();
      queryClient.clear();
      vi.clearAllMocks();
    }
  },
);
