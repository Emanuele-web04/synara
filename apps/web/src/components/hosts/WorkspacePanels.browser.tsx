// FILE: WorkspacePanels.browser.tsx
// Purpose: Verifies remote frame recovery from unchanged controller snapshots.
// Layer: Browser integration test

import type {
  AccountStatus,
  ExecutionEnvironmentDescriptor,
  HostConnection,
} from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { accountQueryKeys } from "../../lib/accountReactQuery";
import { adoptControlAccountScope } from "../../lib/hosts/controlQueryScope";
import { initializeExecutionContext } from "../../lib/hosts/executionContext";
import { remoteHostQueryKeys } from "../../lib/hosts/queries";
import type { WorkspaceFrameElement } from "../../lib/hosts/workspaceFrame";
import { removeWorkspaceSession } from "../../lib/hosts/workspaceSessions";
import { serverQueryKeys } from "../../lib/serverReactQuery";
import { SidebarProvider } from "../ui/sidebar";
import { WorkspacePanels } from "./WorkspacePanels";

vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  useLocation: () => "/",
}));
vi.mock("../../hooks/useHandleNewChat", () => ({
  useHandleNewChat: () => ({ handleNewChat: vi.fn() }),
}));

it("remounts a failed remote frame after an unchanged controller response", async () => {
  const account = {
    state: "signed-in",
    accountAuthority: "https://account.test",
    me: { id: "owner", organization: { id: "personal" } },
  } as AccountStatus;
  const local = {
    environmentId: "local",
    capabilities: { remoteConnections: true },
  } as ExecutionEnvironmentDescriptor;
  const host = {
    hostId: "mini-host",
    hostName: "Mini",
    wsPath: "/ws/remote/mini-host",
    executionScope: {
      environmentId: "mini",
      accountAuthority: "https://account.test",
      userId: "owner",
      organizationId: "personal",
      channel: "beta",
    },
    state: "connected",
    transport: "cloudflare",
    startedAt: "2026-11-14T17:00:00Z",
    credentialExpiresAt: "2026-11-14T17:10:00Z",
  } satisfies HostConnection;
  const response = {
    pairedHosts: [{ hostId: host.hostId, environmentId: host.executionScope.environmentId }],
    connections: [host],
  };
  initializeExecutionContext({ controller: local, execution: local, remote: null });
  adoptControlAccountScope(account);

  const queryClient = new QueryClient();
  queryClient.setQueryData(accountQueryKeys.status(), account);
  queryClient.setQueryData(serverQueryKeys.config(), { keybindings: [] });
  // Fake only the clock so React Query can deliver each real cache update.
  vi.useFakeTimers({ toFake: ["Date"] });
  // Avoid navigating into a second application during the controller test.
  const navigateFrame = vi
    .spyOn(HTMLIFrameElement.prototype, "src", "set")
    .mockImplementation(() => {});
  const screen = await render(
    <QueryClientProvider client={queryClient}>
      <SidebarProvider>
        <WorkspacePanels />
      </SidebarProvider>
    </QueryClientProvider>,
  );
  const key = remoteHostQueryKeys.connections();
  const publishControllerResponse = (time: number) => {
    vi.setSystemTime(time);
    queryClient.setQueryData(key, structuredClone(response));
  };
  const frame = () =>
    screen.container.querySelector<WorkspaceFrameElement>(
      'iframe[title="Synara workspace on Mini"]',
    );
  try {
    const initialTime = Date.now();
    publishControllerResponse(initialTime);
    await expect.poll(() => frame()?.synaraWorkspace).toBeDefined();

    const original = frame()!;
    const firstSnapshot = queryClient.getQueryData(key);
    original.synaraWorkspace!.fail("Bootstrap failed");
    publishControllerResponse(initialTime + 5_000);
    expect(queryClient.getQueryData(key)).toBe(firstSnapshot);
    await expect.poll(() => Boolean(frame()?.synaraWorkspace) && frame() !== original).toBe(true);

    const remounted = frame()!;
    remounted.synaraWorkspace!.fail("Retry failed");
    publishControllerResponse(initialTime + 10_000);
    await expect.poll(() => Boolean(frame()?.synaraWorkspace) && frame() !== remounted).toBe(true);
  } finally {
    await screen.unmount();
    removeWorkspaceSession(host.hostId);
    queryClient.clear();
    navigateFrame.mockRestore();
    vi.useRealTimers();
  }
});
