// FILE: ConnectionsSettingsPanel.browser.tsx
// Purpose: Browser coverage for the Connections pane — tabs, the allow switch,
//          revoking a device, the Add dialog (QR, code, manual approval), and
//          keep-awake.
// Layer: Browser UI test

import "../../index.css";

import type { DesktopKeepAwakeState } from "@synara/contracts";
import { StrictMode, type CSSProperties } from "react";
import { page } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const fixture = vi.hoisted(() => {
  const state = {
    allowConnections: true as boolean | undefined,
    approved: false,
    codeFailuresRemaining: 0,
    revoked: [] as string[],
    connected: false,
  };
  const hostState = () => ({
    kind: "host-state" as const,
    rootFingerprint: "a".repeat(64),
    rootNeedsRepair: false,
    rootExpiresAt: "2036-09-01T12:00:00Z",
    ...(state.allowConnections === undefined ? {} : { allowConnections: state.allowConnections }),
    devices: [
      {
        deviceJkt: "iphone-jkt",
        label: "iOS 27.0.1 iPhone",
        publicKey: {},
        generation: 1,
        approvedAt: "2026-09-01T10:00:00.000Z",
        revokedAt: null,
        enrolledVia: "qr" as const,
        lastConnectedAt: new Date(Date.now() - 19 * 3_600_000).toISOString(),
      },
      {
        deviceJkt: "ipad-jkt",
        label: "Ada's iPad",
        publicKey: {},
        generation: 1,
        approvedAt: "2026-09-02T10:00:00.000Z",
        revokedAt: null,
        lastConnectedAt: null,
      },
    ].filter((device) => !state.revoked.includes(device.deviceJkt)),
    invitations: state.approved
      ? []
      : [
          {
            inviteId: "pending-fixture",
            expiresAt: new Date(Date.now() + 600_000).toISOString(),
            approved: false,
            revoked: false,
            pendingDevice: {
              label: "Emanuele’s MacBook",
              deviceJkt: "Exact-requesting-device-fingerprint-123456789",
              publicKey: {},
            },
          },
        ],
  });
  return {
    state,
    navigate: vi.fn(),
    confirm: vi.fn(async () => true),
    disconnect: vi.fn(async () => {}),
    recover: vi.fn(),
    toast: vi.fn(),
    request: vi.fn(async (request: { operation: string; [key: string]: unknown }) => {
      switch (request.operation) {
        case "create-code":
          if (state.codeFailuresRemaining > 0) {
            state.codeFailuresRemaining -= 1;
            throw new Error("Could not create a pairing code.");
          }
          return {
            kind: "pairing-code",
            code: "ABCD-2345",
            inviteId: "qr-fixture",
            rootFingerprint: "a".repeat(64),
            expiresAt: new Date(Date.now() + 600_000).toISOString(),
          };
        case "set-allow-connections":
          state.allowConnections = request.enabled as boolean;
          return { kind: "done" };
        case "revoke-device":
          state.revoked.push(request.deviceJkt as string);
          return { kind: "done" };
        case "approve":
          state.approved = true;
          return { kind: "done" };
        case "list":
          return hostState();
        default:
          return { kind: "done" };
      }
    }),
  };
});

vi.mock("~/hooks/useAccount", () => ({
  useAccount: () => ({
    me: { id: "user-1", name: "Ada Lovelace" },
    status: { state: "signed-in", accountAuthority: "https://account.example.test/api/v1" },
  }),
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => fixture.navigate,
}));
vi.mock("~/nativeApi", async (importOriginal) => {
  const api = { dialogs: { confirm: fixture.confirm } };
  return {
    ...(await importOriginal<typeof import("~/nativeApi")>()),
    readNativeApi: () => api,
    ensureNativeApi: () => api,
  };
});
vi.mock("~/components/ui/toast", () => ({ toastManager: { add: fixture.toast } }));
vi.mock("~/lib/hosts/api", async (original) => ({
  ...(await original<typeof import("~/lib/hosts/api")>()),
  readHostsApi: () => ({ remoteAccess: fixture.request }),
}));
vi.mock("~/lib/hosts/executionContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/hosts/executionContext")>()),
  readExecutionContext: () => ({
    controller: {
      channel: "beta",
      environmentId: "controller",
      capabilities: { remoteConnections: true },
    },
    execution: { label: "This computer", environmentId: "controller" },
  }),
}));
vi.mock("~/hooks/useHosts", () => {
  const idle = { isPending: false, mutateAsync: vi.fn(async () => {}) };
  const query = { isPending: false, error: null, refetch: vi.fn(async () => {}) };
  return {
    useHosts: () => ({
      hostsQuery: query,
      enrollmentQuery: query,
      hosts: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          environmentId: "env_studio",
          name: "Studio Mac mini",
          platform: "darwin",
          kind: "local",
          endpoints: [],
          ownerUserId: "user-1",
          discoverable: true,
          linked: true,
          keyGeneration: 1,
          mine: true,
          createdAt: "2026-08-13T10:00:00.000Z",
          lastSeenAt: "2026-08-13T10:00:00.000Z",
        },
      ].flatMap((host) => [
        host,
        { ...host, id: "old-mini", environmentId: "old-mini" },
        { ...host, id: "old-macbook", environmentId: "old-macbook", name: "MacBook" },
        { ...host, id: "this-macbook", environmentId: "controller", name: "This MacBook" },
      ]),
      enrollment: null,
      canManageHost: () => true,
      setDiscoverable: idle,
      unlinkLocalHost: idle,
    }),
    useDevices: () => ({ devicesQuery: query, devices: [], revokeDevice: idle }),
    useHostSessions: () => ({ sessionsQuery: query, sessions: [], endSession: idle }),
    useHostConnections: () => ({
      connectionsQuery: query,
      connections: fixture.state.connected
        ? [{ hostId: "11111111-1111-4111-8111-111111111111", transport: "cloudflare" }]
        : [],
      pairedHosts: [
        {
          hostId: "11111111-1111-4111-8111-111111111111",
          environmentId: "env_studio",
          label: "Studio Mac mini",
          channel: "dev",
        },
      ],
      connect: idle,
      disconnect: { isPending: false, mutateAsync: fixture.disconnect },
    }),
  };
});

import { ConnectionsSettingsPanel } from "./ConnectionsSettingsPanel";
import {
  addWorkspaceSession,
  readWorkspaceSessions,
  removeWorkspaceSession,
  updateWorkspaceSession,
} from "~/lib/hosts/workspaceSessions";

const keepAwake = {
  state: { enabled: false, active: false, onBattery: false } as DesktopKeepAwakeState,
  getState: vi.fn(async () => keepAwake.state),
  setEnabled: vi.fn(async (enabled: boolean) => {
    keepAwake.state = { ...keepAwake.state, enabled, active: enabled };
    return keepAwake.state;
  }),
  setRemoteAccessAllowed: vi.fn(async () => keepAwake.state),
};

async function renderPanel(strictMode = false) {
  await page.viewport(900, 1100);
  const panel = (
    <div
      className="mx-auto max-w-2xl bg-background px-6 py-8 text-foreground"
      // The app theme sets the accent at runtime; pin one so screenshots show switch state.
      style={{ "--color-text-accent": "#0169cc" } as CSSProperties}
    >
      <h1 className="mb-8 text-xl font-medium tracking-tight">Connections</h1>
      <ConnectionsSettingsPanel active />
    </div>
  );
  return render(strictMode ? <StrictMode>{panel}</StrictMode> : panel);
}

beforeEach(() => {
  fixture.state.allowConnections = true;
  fixture.state.approved = false;
  fixture.state.codeFailuresRemaining = 0;
  fixture.state.revoked = [];
  fixture.state.connected = false;
  fixture.request.mockClear();
  fixture.confirm.mockClear();
  fixture.disconnect.mockClear();
  fixture.recover.mockReset();
  fixture.toast.mockClear();
  keepAwake.state = { enabled: false, active: false, onBattery: false };
  keepAwake.setEnabled.mockClear();
  keepAwake.setRemoteAccessAllowed.mockClear();
  (window as { desktopBridge?: unknown }).desktopBridge = { keepAwake };
});
afterEach(() => {
  vi.restoreAllMocks();
  fixture.recover.mockReset();
  for (const session of readWorkspaceSessions()) removeWorkspaceSession(session.host.hostId);
  delete (window as { desktopBridge?: unknown }).desktopBridge;
  document.documentElement.classList.remove("dark");
});

describe("Connections settings", () => {
  function registerConnectedWorkspace() {
    fixture.state.connected = true;
    const session = addWorkspaceSession({
      hostId: "11111111-1111-4111-8111-111111111111",
      hostName: "Studio Mac mini",
      wsPath: "/ws/remote/11111111-1111-4111-8111-111111111111",
      executionScope: {
        environmentId: "env_studio",
        accountAuthority: "https://account.example.test/api/v1",
        userId: "user-1",
        organizationId: "org-1",
        channel: "dev",
      },
    });
    updateWorkspaceSession(session.host.executionScope.environmentId, {
      navigation: {
        browseFolders: vi.fn(),
        createProject: vi.fn(),
        newChat: vi.fn(),
        createChat: vi.fn(),
        openTerminal: vi.fn(),
        openProject: vi.fn(),
        navigate: vi.fn(),
        recover: fixture.recover,
      },
    });
  }

  async function chooseHostAction(action: "Disconnect" | "Forget pairing") {
    await renderPanel();
    await page.getByRole("radio", { name: "Control other devices" }).click();
    await page.getByRole("button", { name: "More actions for Studio Mac mini" }).click();
    await page.getByRole("menuitem", { name: action, exact: true }).click();
  }

  it.each(["Disconnect", "Forget pairing"] as const)(
    "keeps backend access available when draft recovery fails before %s",
    async (action) => {
      registerConnectedWorkspace();
      fixture.recover.mockImplementation(() => {
        throw new Error("Recovery storage is full.");
      });
      await chooseHostAction(action);
      await vi.waitFor(() =>
        expect(fixture.toast).toHaveBeenCalledWith({
          type: "error",
          title: "Could not preserve editor drafts",
          description: "Copy or export unsaved text before disconnecting this computer.",
        }),
      );
      expect(fixture.disconnect).not.toHaveBeenCalled();
      expect(fixture.request).not.toHaveBeenCalledWith({
        operation: "forget-host",
        environmentId: "env_studio",
      });
      expect(readWorkspaceSessions()).toHaveLength(1);
    },
  );

  it.each(["Disconnect", "Forget pairing"] as const)(
    "removes the workspace after %s even when its saved list cannot be written",
    async (action) => {
      registerConnectedWorkspace();
      const recovery = fixture.recover;
      vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
        throw new Error("Session storage is full.");
      });
      await chooseHostAction(action);
      await vi.waitFor(() => expect(readWorkspaceSessions()).toHaveLength(0));
      expect(recovery).toHaveBeenCalledOnce();
      const backendOrder =
        action === "Disconnect"
          ? fixture.disconnect.mock.invocationCallOrder[0]
          : fixture.request.mock.invocationCallOrder[
              fixture.request.mock.calls.findIndex(
                ([request]) => request.operation === "forget-host",
              )
            ];
      expect(recovery.mock.invocationCallOrder[0]).toBeLessThan(backendOrder!);
      expect(fixture.toast).toHaveBeenCalledWith({
        type: "warning",
        title: "Connection closed",
        description: "This window could not update its saved computer list.",
      });
      expect(sessionStorage.getItem("synara:workspace-connections:v1:controller")).toBeNull();
    },
  );

  it("lists trusted devices with their last connection and switches tabs", async () => {
    await renderPanel();
    await expect.element(page.getByText("iOS 27.0.1 iPhone")).toBeVisible();
    await expect.element(page.getByText("Last connected 19h ago")).toBeVisible();
    await expect.element(page.getByText("Never connected")).toBeVisible();
    await expect
      .element(page.getByText("Emanuele’s MacBook is waiting for approval"))
      .toBeVisible();
    await page.screenshot({
      path: "./__screenshots__/connections.png",
    });

    await page.getByRole("radio", { name: "Control other devices" }).click();
    await expect.element(page.getByText("Studio Mac mini", { exact: true })).toBeVisible();
    await expect.element(page.getByText("MacBook", { exact: true })).not.toBeInTheDocument();
    await expect.element(page.getByText("This MacBook", { exact: true })).not.toBeInTheDocument();
    expect(page.getByRole("button", { name: "Connect", exact: true }).elements()).toHaveLength(1);
    await expect.element(page.getByRole("button", { name: "Connect", exact: true })).toBeVisible();
    await page.screenshot({ path: "./__screenshots__/connections-others.png" });

    await page.getByRole("radio", { name: "SSH" }).click();
    await expect.element(page.getByText("Port forwarding")).toBeVisible();
    await page.getByRole("button", { name: "Enter a code" }).click();
    expect(fixture.navigate).toHaveBeenCalledWith({ to: "/link" });
  });

  it("turns connections off through the owner switch and tells the desktop", async () => {
    await renderPanel();
    const allow = page.getByRole("switch", { name: "Allow connections" });
    await expect.element(allow).toBeChecked();
    await vi.waitFor(() => expect(keepAwake.setRemoteAccessAllowed).toHaveBeenCalledWith(true));
    await allow.click();
    await vi.waitFor(() =>
      expect(fixture.request).toHaveBeenCalledWith({
        operation: "set-allow-connections",
        enabled: false,
      }),
    );
    await expect.element(allow).not.toBeChecked();
    await vi.waitFor(() => expect(keepAwake.setRemoteAccessAllowed).toHaveBeenCalledWith(false));
  });

  it("treats a host without the allow flag as allowing connections", async () => {
    fixture.state.allowConnections = undefined;
    await renderPanel();
    await expect.element(page.getByRole("switch", { name: "Allow connections" })).toBeChecked();
  });

  it("revokes a trusted device after confirmation", async () => {
    await renderPanel();
    await expect.element(page.getByText("Ada's iPad")).toBeVisible();
    await page.getByRole("button", { name: "Revoke access" }).nth(1).click();
    await vi.waitFor(() =>
      expect(fixture.request).toHaveBeenCalledWith({
        operation: "revoke-device",
        deviceJkt: "ipad-jkt",
      }),
    );
    expect(fixture.confirm).toHaveBeenCalledOnce();
    await expect.element(page.getByText("Ada's iPad")).not.toBeInTheDocument();
  });

  it("mints one code per opening under StrictMode and approves a pending device", async () => {
    await renderPanel(true);
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await expect
      .element(page.getByRole("img", { name: "Scan to connect to this computer" }))
      .toBeVisible();
    await expect.element(page.getByText("ABCD-2345", { exact: true })).toBeVisible();
    expect(
      fixture.request.mock.calls.filter(([request]) => request.operation === "create-code"),
    ).toHaveLength(1);
    await expect.element(page.getByText(/Expires in \d+:\d\d/)).toBeVisible();
    // Let the dialog's open transition settle so the screenshot is legible.
    await new Promise((resolve) => setTimeout(resolve, 400));
    await page.screenshot({
      path: "./__screenshots__/connections-add.png",
    });
    await page.getByRole("button", { name: "Approve", exact: true }).click();
    await vi.waitFor(() =>
      expect(fixture.request).toHaveBeenCalledWith({
        operation: "approve",
        inviteId: "pending-fixture",
        deviceJkt: "Exact-requesting-device-fingerprint-123456789",
      }),
    );
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await vi.waitFor(() =>
      expect(fixture.request).toHaveBeenCalledWith({
        operation: "cancel-invitation",
        inviteId: "qr-fixture",
      }),
    );
    await expect
      .element(page.getByRole("heading", { name: "Add a device" }))
      .not.toBeInTheDocument();
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await expect.element(page.getByText("ABCD-2345", { exact: true })).toBeVisible();
    expect(
      fixture.request.mock.calls.filter(([request]) => request.operation === "create-code"),
    ).toHaveLength(2);
  });

  it("can retry failed code creation without closing the dialog", async () => {
    fixture.state.codeFailuresRemaining = 1;
    await renderPanel(true);
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await expect.element(page.getByRole("alert")).toBeVisible();
    expect(page.getByRole("button", { name: "Try again", exact: true }).elements()).toHaveLength(1);
    await page.getByRole("button", { name: "Try again", exact: true }).click();
    await expect.element(page.getByText("ABCD-2345", { exact: true })).toBeVisible();
    await expect
      .element(page.getByRole("img", { name: "Scan to connect to this computer" }))
      .toBeVisible();
    await expect.element(page.getByRole("alert")).not.toBeInTheDocument();
    expect(
      fixture.request.mock.calls.filter(([request]) => request.operation === "create-code"),
    ).toHaveLength(2);
  });

  it("persists keep awake through the desktop bridge", async () => {
    await renderPanel();
    const toggle = page.getByRole("switch", { name: /Keep this (Mac|computer) awake/ });
    await expect.element(toggle).not.toBeChecked();
    await toggle.click();
    await vi.waitFor(() => expect(keepAwake.setEnabled).toHaveBeenCalledWith(true));
    await expect.element(toggle).toBeChecked();
  });

  it("hides keep awake without a desktop bridge", async () => {
    delete (window as { desktopBridge?: unknown }).desktopBridge;
    await renderPanel();
    await expect.element(page.getByText("iOS 27.0.1 iPhone")).toBeVisible();
    await expect.element(page.getByText("Other settings")).not.toBeInTheDocument();
  });
});
