// Reconnect must expose the current callback URL without requiring saved credentials again.
import "../../index.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";
import type { McpConnectorProposal } from "@synara/contracts";
import { McpConnectorsSettingsPanel } from "./McpConnectorsSettingsPanel";

const api = vi.hoisted(() => ({
  listMcpConnectors: vi.fn(),
  getMcpConnectorSetup: vi.fn(),
  connectMcpConnector: vi.fn(),
  openExternal: vi.fn(),
  listMcpConnectorProposals: vi.fn().mockResolvedValue([]),
  resolveMcpConnectorProposal: vi.fn(),
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

it("shows an exact stdio approval card and applies it only after the user approves", async () => {
  await page.viewport(1100, 900);
  const proposal: McpConnectorProposal = {
    proposalId: "paper-proposal",
    threadId: "thread",
    action: "add",
    state: "pending",
    connector: {
      connectorId: "pending-paper",
      presetId: null,
      name: "Paper",
      transport: "stdio",
      command: "/Users/example/.paper/bin/paper",
      args: ["mcp", "--profile", "My workspace"],
      cwd: "/Users/example/project",
      envKeys: ["PAPER_TOKEN"],
      serverName: "paper_connector",
      authKind: "none",
      status: "unreachable",
      createdAt: "2026-11-02T10:00:00Z",
      updatedAt: "2026-11-02T10:00:00Z",
    },
  };
  api.listMcpConnectors.mockResolvedValue([]);
  api.listMcpConnectorProposals.mockResolvedValue([proposal]);
  api.resolveMcpConnectorProposal.mockImplementation(async () => {
    api.listMcpConnectorProposals.mockResolvedValue([{ ...proposal, state: "accepted" }]);
    api.listMcpConnectors.mockResolvedValue([
      { ...proposal.connector, connectorId: "paper", status: "unreachable" },
    ]);
    return { proposal: { ...proposal, state: "accepted" }, authorizationUrl: null };
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const screen = await render(
    <QueryClientProvider client={client}>
      <McpConnectorsSettingsPanel active />
    </QueryClientProvider>,
  );
  try {
    const review = screen.getByRole("button", { name: "Review connection", exact: true });
    await expect.element(review).toBeVisible();
    await expect
      .element(screen.getByRole("button", { name: "Approve connector", exact: true }))
      .not.toBeInTheDocument();
    await expect.element(screen.getByText("Custom", { exact: true })).toBeVisible();
    const card = screen.getByRole("region", { name: "Paper connector proposal", exact: true });
    await expect
      .poll(() => {
        const image = card.element().querySelector("img");
        return image?.complete && image.naturalWidth > 0;
      })
      .toBe(true);
    await review.element().scrollIntoView();
    await card.screenshot({
      path: "__screenshots__/mcp-connectors-proposal.png",
    });
    await review.click();
    await expect
      .element(screen.getByText("/Users/example/.paper/bin/paper", { exact: true }))
      .toBeVisible();
    await expect
      .element(screen.getByText('["mcp","--profile","My workspace"]', { exact: true }))
      .toBeVisible();
    await expect.element(screen.getByText("/Users/example/project", { exact: true })).toBeVisible();
    await expect.element(screen.getByText("PAPER_TOKEN", { exact: true })).toBeVisible();
    expect(api.resolveMcpConnectorProposal).not.toHaveBeenCalled();
    expect(api.connectMcpConnector).not.toHaveBeenCalled();
    // Closing review must also remove the action that can execute the command.
    await screen.getByRole("button", { name: "Connection details", exact: true }).click();
    await expect
      .element(screen.getByRole("button", { name: "Approve connector", exact: true }))
      .not.toBeInTheDocument();
    expect(api.resolveMcpConnectorProposal).not.toHaveBeenCalled();
    await review.click();
    await Promise.all(
      card
        .element()
        .getAnimations({ subtree: true })
        .map((animation) => animation.finished),
    );
    await screen
      .getByRole("button", { name: "Approve connector", exact: true })
      .element()
      .scrollIntoView();
    await card.screenshot({
      path: "__screenshots__/mcp-connectors-approval.png",
    });
    await screen.getByRole("button", { name: "Approve connector", exact: true }).click();
    await expect
      .poll(() => api.resolveMcpConnectorProposal.mock.calls.at(-1)?.[0])
      .toEqual({ proposalId: "paper-proposal", resolution: "accepted" });
    await expect.element(screen.getByText("Not running", { exact: true })).toBeVisible();
    const details = screen.getByRole("button", { name: "Connection details", exact: true });
    await expect.element(details).toHaveAttribute("aria-expanded", "false");
    screen
      .getByRole("button", { name: "Add local server", exact: true })
      .element()
      .scrollIntoView();
    await page.screenshot({
      path: "__screenshots__/mcp-connectors-local-saved.png",
    });
    await screen
      .getByRole("region", { name: "Paper connector", exact: true })
      .screenshot({ path: "__screenshots__/mcp-connectors-card.png" });
    await details.click();
    await expect.element(details).toHaveAttribute("aria-expanded", "true");
    await expect
      .element(screen.getByText("/Users/example/.paper/bin/paper", { exact: true }))
      .toBeVisible();
    await expect
      .element(
        screen.getByText("Used by Claude, Codex, OpenCode, Cursor, Grok, Droid and Oh My Pi"),
      )
      .toBeVisible();
    await details.click();
    await Promise.all(
      screen
        .getByRole("region", { name: "Paper connector", exact: true })
        .element()
        .getAnimations({ subtree: true })
        .map((animation) => animation.finished),
    );
    document.documentElement.classList.add("dark");
    await page.viewport(390, 844);
    await page.screenshot({
      path: "__screenshots__/mcp-connectors-local-dark-mobile.png",
    });
    const savedCard = screen
      .getByRole("region", { name: "Paper connector", exact: true })
      .element();
    expect(savedCard.scrollWidth).toBeLessThanOrEqual(savedCard.clientWidth);
  } finally {
    document.documentElement.classList.remove("dark");
    await screen.unmount();
    client.clear();
    api.listMcpConnectorProposals.mockResolvedValue([]);
    vi.clearAllMocks();
  }
});

it("adds a local command through the explicit run action", async () => {
  await page.viewport(1100, 900);
  api.listMcpConnectors.mockResolvedValue([]);
  api.listMcpConnectorProposals.mockResolvedValue([]);
  api.connectMcpConnector.mockResolvedValue({ connector: null, authorizationUrl: null });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const screen = await render(
    <QueryClientProvider client={client}>
      <McpConnectorsSettingsPanel active />
    </QueryClientProvider>,
  );
  try {
    await screen.getByRole("button", { name: "Add local server", exact: true }).click();
    await screen.getByLabelText("Local server transport").selectOptions("stdio");
    await screen.getByLabelText("Name", { exact: true }).fill("Paper");
    await screen.getByLabelText("Command", { exact: true }).fill("~/.paper/bin/paper");
    await screen.getByLabelText("Arguments (JSON array)").fill('["mcp"]');
    await screen.getByLabelText("Working directory").fill("~/project");
    expect(api.connectMcpConnector).not.toHaveBeenCalled();
    await expect
      .poll(() => getComputedStyle(document.querySelector('[data-slot="dialog-popup"]')!).opacity)
      .toBe("1");
    await page.screenshot({ path: "__screenshots__/mcp-connectors-add-local.png" });
    await screen.getByRole("button", { name: "Add and run server" }).click();
    await expect
      .poll(() => api.connectMcpConnector.mock.calls.at(-1)?.[0])
      .toEqual({
        name: "Paper",
        command: "~/.paper/bin/paper",
        args: ["mcp"],
        cwd: "~/project",
        env: {},
      });
  } finally {
    await screen.unmount();
    client.clear();
    vi.clearAllMocks();
  }
});
