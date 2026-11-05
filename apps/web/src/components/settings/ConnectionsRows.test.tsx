// FILE: ConnectionsRows.test.tsx
// Purpose: The Connections rows render the states that matter — trusted device
//          activity, host status and connect actions, account devices, sessions.
// Layer: Component rendering tests
// Depends on: the row components and React server rendering.

import type {
  AccountDevice,
  AccountHost,
  EnvironmentId,
  RemoteTrustedDevice,
} from "@synara/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { HostReachability } from "~/lib/hosts/reachability";
import {
  DeviceRow,
  HostRow,
  type HostRowConnection,
  SessionRow,
  TrustedDeviceRow,
} from "./ConnectionsRows";

function makeHost(overrides: Partial<AccountHost> = {}): AccountHost {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    environmentId: "env_1" as EnvironmentId,
    name: "Ada's MacBook",
    platform: "darwin",
    kind: "local",
    endpoints: [],
    ownerUserId: "user_1",
    discoverable: true,
    linked: true,
    keyGeneration: 1,
    mine: true,
    createdAt: "2026-08-13T10:00:00.000Z",
    lastSeenAt: "2026-08-13T10:00:00.000Z",
    ...overrides,
  };
}

function makeDevice(overrides: Partial<AccountDevice> = {}): AccountDevice {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    publicKeyJwk: { kty: "EC", crv: "P-256", x: "x", y: "y" },
    jkt: "thumbprint",
    displayName: "Ada's iPhone",
    platform: "ios",
    createdAt: "2026-08-01T10:00:00.000Z",
    lastUsedAt: "2026-08-13T09:00:00.000Z",
    revokedAt: null,
    ...overrides,
  };
}

function makeTrusted(overrides: Partial<RemoteTrustedDevice> = {}): RemoteTrustedDevice {
  return {
    deviceJkt: "jkt",
    label: "iOS 27.0.1 iPhone",
    publicKey: { kty: "EC", crv: "P-256", x: "x", y: "y" },
    generation: 1,
    approvedAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
    revokedAt: null,
    ...overrides,
  } as RemoteTrustedDevice;
}

function renderHostRow(input: {
  host: AccountHost;
  reachability?: HostReachability;
  connection?: HostRowConnection;
}): string {
  return renderToStaticMarkup(
    <HostRow
      host={input.host}
      reachability={input.reachability ?? { state: "unknown" }}
      busy={false}
      {...(input.connection ? { connection: input.connection } : {})}
      onProbe={vi.fn()}
      onToggleDiscoverable={vi.fn()}
      onConnect={vi.fn()}
      onDisconnect={vi.fn()}
      onActivate={vi.fn()}
      onDeactivate={vi.fn()}
    />,
  );
}

describe("TrustedDeviceRow", () => {
  const render = (device: RemoteTrustedDevice) =>
    renderToStaticMarkup(<TrustedDeviceRow device={device} busy={false} onRevoke={vi.fn()} />);

  it("shows when the device last connected and offers to revoke access", () => {
    const html = render(
      makeTrusted({ lastConnectedAt: new Date(Date.now() - 19 * 3_600_000).toISOString() }),
    );
    expect(html).toContain("iOS 27.0.1 iPhone");
    expect(html).toContain("Last connected 19h ago");
    expect(html).toContain("Revoke access");
  });

  it("distinguishes a device that never connected from an older host", () => {
    expect(render(makeTrusted({ lastConnectedAt: null }))).toContain("Never connected");
    expect(render(makeTrusted())).toContain("Added 2d ago");
  });
});

describe("HostRow", () => {
  it("renders the host name and platform", () => {
    const html = renderHostRow({ host: makeHost() });
    expect(html).toContain("Ada&#x27;s MacBook");
    expect(html).toContain("macOS");
  });

  it("labels a workspace host and keeps an owned host quiet", () => {
    expect(renderHostRow({ host: makeHost({ mine: false }) })).toContain(
      "Shared by your workspace",
    );
    expect(renderHostRow({ host: makeHost({ mine: true }) })).not.toContain("workspace");
  });

  // An absent `mine` means the server did not say; claiming ownership would
  // offer controls the API then refuses.
  it("treats an unset owner flag as not mine", () => {
    const { mine: _mine, ...withoutMine } = makeHost();
    expect(renderHostRow({ host: withoutMine as AccountHost })).toContain(
      "Shared by your workspace",
    );
  });

  it("names the winning transport once a probe succeeded", () => {
    const html = renderHostRow({
      host: makeHost(),
      reachability: { state: "reachable", transport: "tailscale", at: 1 },
    });
    expect(html).toContain("Reachable over Tailscale");
  });

  it("keeps a network failure distinguishable from a refusal", () => {
    expect(
      renderHostRow({ host: makeHost(), reachability: { state: "unreachable", at: 1 } }),
    ).toContain("Did not answer");
    expect(
      renderHostRow({ host: makeHost(), reachability: { state: "no-answer", at: 1 } }),
    ).toContain("No response");
  });

  // ADR 0010 + the palette: no success/warning token exists, and there is no
  // live presence to justify a light anyway.
  it("renders reachability without a status dot or status color", () => {
    for (const reachability of [
      { state: "reachable", transport: "lan", at: 1 },
      { state: "unreachable", at: 1 },
      { state: "no-answer", at: 1 },
    ] satisfies HostReachability[]) {
      const html = renderHostRow({ host: makeHost(), reachability });
      expect(html).not.toMatch(/bg-success|bg-destructive|text-success|text-warning/);
      expect(html).not.toMatch(/rounded-full[^"]*bg-(green|red|emerald|amber)/);
    }
  });

  it("disables Connect until the host has finished its key exchange", () => {
    const html = renderHostRow({ host: makeHost({ linked: false }) });
    expect(html).toContain("Not linked yet");
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Connect</);
  });

  it("offers Open on a connected host, naming the transport", () => {
    const html = renderHostRow({
      host: makeHost(),
      connection: { kind: "connected", transport: "relay", active: false, busy: false },
    });
    expect(html).toContain(">Open<");
    expect(html).toContain("Connected over relay");
    expect(html).not.toContain(">Connect<");
  });

  it("offers the way back when this window is working on the host", () => {
    const html = renderHostRow({
      host: makeHost(),
      connection: { kind: "connected", transport: "lan", active: true, busy: false },
    });
    expect(html).toContain("Back to this computer");
    expect(html).toContain("Working on it over local network");
  });

  it("keeps secondary actions in an overflow menu", () => {
    expect(renderHostRow({ host: makeHost() })).toContain(
      'aria-label="More actions for Ada&#x27;s MacBook"',
    );
  });
});

describe("DeviceRow", () => {
  const render = (device: AccountDevice, busy = false) =>
    renderToStaticMarkup(<DeviceRow device={device} busy={busy} onRevoke={vi.fn()} />);

  it("renders the device name and when it was last used", () => {
    const html = render(
      makeDevice({ lastUsedAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString() }),
    );
    expect(html).toContain("Ada&#x27;s iPhone");
    expect(html).toContain("Used 3h ago");
  });

  it("says so when a device has never been used", () => {
    expect(render(makeDevice({ lastUsedAt: null }))).toContain("Never used");
  });

  // --color-destructive is reserved for revoke/delete/unlink.
  it("offers key revocation as a destructive action, disabled while one runs", () => {
    const html = render(makeDevice());
    expect(html).toContain("Revoke key");
    expect(html).toContain("destructive");
    expect(render(makeDevice(), true)).toContain("disabled");
  });

  it("does not offer to revoke an already-revoked device", () => {
    const html = render(makeDevice({ revokedAt: "2026-08-12T10:00:00.000Z" }));
    expect(html).toContain("Device key revoked");
    expect(html).not.toContain("Revoke key");
  });
});

describe("SessionRow", () => {
  it("shows the user, device, transport, start time, and an end action", () => {
    const html = renderToStaticMarkup(
      <SessionRow
        session={{
          id: "session-1",
          userId: "user-1",
          deviceJkt: "device-thumbprint",
          transport: "relay",
          startedAt: "2026-08-14T10:00:00.000Z",
        }}
        userLabel="Ada Lovelace"
        deviceLabel="Ada's MacBook"
        busy={false}
        onEnd={vi.fn()}
      />,
    );
    expect(html).toContain("Ada Lovelace");
    expect(html).toContain("Ada&#x27;s MacBook");
    expect(html).toContain("Relay");
    expect(html).toContain("Started");
    expect(html).toContain("End session");
    expect(html).toContain("destructive");
  });
});
