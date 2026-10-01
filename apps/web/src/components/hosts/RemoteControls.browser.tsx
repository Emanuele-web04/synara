import "../../index.css";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { beforeEach, afterEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  back: vi.fn(),
  navigate: vi.fn(),
  approved: false,
  request: vi.fn(async (request: { operation: string }) => {
    if (request.operation === "device-info")
      return {
        kind: "device-info",
        label: "MacBook",
        deviceJkt: "Controller-fingerprint-confirm-on-host-123456789",
      };
    if (request.operation === "approve") {
      fixture.approved = true;
      return { kind: "done" };
    }
    return {
      kind: "host-state",
      rootNeedsRepair: false,
      rootExpiresAt: "2036-09-01T12:00:00Z",
      devices: [],
      invitations: fixture.approved
        ? []
        : [
            {
              inviteId: "pending-fixture",
              expiresAt: new Date(Date.now() + 600000).toISOString(),
              approved: false,
              revoked: false,
              pendingDevice: {
                label: "Emanuele’s MacBook",
                deviceJkt: "Exact-requesting-device-fingerprint-123456789",
                publicKey: {},
              },
            },
          ],
    };
  }),
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => fixture.navigate,
}));
vi.mock("~/lib/hosts/activeHost", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/hosts/activeHost")>()),
  deactivateHost: fixture.back,
}));
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
    execution: { label: "Mac mini", environmentId: "remote" },
    remote: { channel: "beta" },
  }),
}));
import { emitWsTransportState } from "~/wsTransportEvents";
import { HostConnectionControl } from "./HostConnectionControl";
import { RemotePairingPanel } from "../settings/RemotePairingPanel";

beforeEach(() => {
  fixture.approved = false;
  fixture.back.mockClear();
  fixture.request.mockClear();
});
afterEach(() => document.documentElement.classList.remove("dark"));
it.each(["light", "dark"])(
  "keeps a local escape visible with the remote host offline (%s)",
  async (theme) => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    await page.viewport(900, 650);
    emitWsTransportState("closed");
    await render(
      <div className="w-72 bg-background p-3 text-foreground">
        <HostConnectionControl />
      </div>,
    );
    await page.getByRole("button", { name: /Mac mini.*Synara Beta/ }).click();
    await expect
      .element(page.getByRole("menuitem", { name: "Back to this computer" }))
      .toBeVisible();
    await page.screenshot({ path: `./__screenshots__/host-control-${theme}.png` });
    await page.getByRole("menuitem", { name: "Back to this computer" }).click();
    expect(fixture.back).toHaveBeenCalledOnce();
    expect(fixture.request).not.toHaveBeenCalled();
  },
);
it("sends the exact displayed device fingerprint for owner approval", async () => {
  await page.viewport(1100, 1000);
  await render(
    <div className="mx-auto max-w-3xl space-y-6 bg-background p-6 text-foreground">
      <RemotePairingPanel />
    </div>,
  );
  await expect
    .element(page.getByText("Exact-requesting-device-fingerprint-123456789", { exact: true }))
    .toBeVisible();
  await page.screenshot({ path: "./__screenshots__/remote-pairing.png" });
  await page.getByRole("button", { name: "Approve this device", exact: true }).click();
  await vi.waitFor(() =>
    expect(fixture.request).toHaveBeenCalledWith({
      operation: "approve",
      inviteId: "pending-fixture",
      deviceJkt: "Exact-requesting-device-fingerprint-123456789",
    }),
  );
});
