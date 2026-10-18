import { once } from "node:events";
import WebSocket, { WebSocketServer } from "ws";
import { HostDialError } from "../hostConnections/dialer";
import { classifyConnectionFailure } from "../hostConnections/failure";
import { HOST_SESSION_CLOSE_REVOKED } from "@synara/contracts";
import type { HostAuthorizationSnapshot } from "@synara/contracts";
import { describe, expect, it, vi } from "vitest";

import { RemoteSessionRegistry } from "./sessionRegistry";

const authorization = (overrides: Partial<HostAuthorizationSnapshot> = {}) => ({
  discoverable: true,
  ownerUserId: "owner",
  orgId: "org",
  revokedDeviceJkts: [],
  ownerInOrg: true,
  ...overrides,
});

describe("RemoteSessionRegistry", () => {
  it("kills revoked devices and non-owner sessions while owner sessions survive discoverability-off", async () => {
    const registry = new RemoteSessionRegistry();
    const ownerClose = vi.fn();
    const memberClose = vi.fn();
    const otherMemberClose = vi.fn();
    registry.add({
      id: "owner-session",
      userId: "owner",
      deviceJkt: "owner-key",
      startedAt: "2026-08-14T10:00:00.000Z",
      expiresAtSeconds: 2_000_000_000,
      via: "direct",
      close: ownerClose,
    });
    registry.add({
      id: "member-session",
      userId: "member",
      deviceJkt: "revoked-key",
      startedAt: "2026-08-14T10:01:00.000Z",
      expiresAtSeconds: 2_000_000_000,
      via: "relay",
      close: memberClose,
    });
    registry.add({
      id: "other-member-session",
      userId: "other-member",
      deviceJkt: "other-key",
      startedAt: "2026-08-14T10:02:00.000Z",
      expiresAtSeconds: 2_000_000_000,
      via: "ssh-forward",
      close: otherMemberClose,
    });

    await registry.reverify(authorization({ revokedDeviceJkts: ["revoked-key"] }));
    expect(memberClose).toHaveBeenCalledOnce();
    expect(ownerClose).not.toHaveBeenCalled();

    await registry.reverify(authorization({ discoverable: false }));
    expect(otherMemberClose).toHaveBeenCalledOnce();
    expect(ownerClose).not.toHaveBeenCalled();
    expect(registry.size).toBe(1);
  });

  it("drops a revoked device's session from the current account snapshot", async () => {
    const registry = new RemoteSessionRegistry();
    const close = vi.fn();
    registry.add({
      id: "s1",
      userId: "owner_1",
      deviceJkt: "stolen-device",
      startedAt: "2026-08-14T10:00:00.000Z",
      expiresAtSeconds: Math.floor(Date.now() / 1_000) + 3_600,
      via: "relay",
      close,
    });
    await registry.reverify({
      discoverable: true,
      ownerUserId: "owner_1",
      orgId: "org_1",
      ownerInOrg: true,
      revokedDeviceJkts: ["stolen-device"],
    });
    expect(close).toHaveBeenCalledWith(HOST_SESSION_CLOSE_REVOKED, "device revoked");
    expect(registry.size).toBe(0);
  });

  it.each([
    "restart",
    "authorization-unavailable",
    "credential-expired",
    "access-disabled",
  ] as const)(
    "distinguishes %s from device revocation at the actual socket boundary",
    async (lifecycle) => {
      const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("No socket address");
      const accepted = once(server, "connection");
      const client = new WebSocket(`ws://127.0.0.1:${address.port}`);
      try {
        await once(client, "open");
        const [peer] = (await accepted) as [WebSocket];
        const registry = new RemoteSessionRegistry();
        const now = Math.floor(Date.now() / 1_000);
        registry.add({
          id: "retryable-session",
          userId: "owner",
          deviceJkt: "approved-device",
          startedAt: new Date().toISOString(),
          expiresAtSeconds: now,
          via: "cloudflare",
          close: (code, reason) => peer.close(code, reason),
        });
        const closed = once(client, "close");
        if (lifecycle === "access-disabled")
          registry.closeAll("remote access disabled", HOST_SESSION_CLOSE_REVOKED);
        else if (lifecycle === "credential-expired") registry.dropExpired(now);
        else if (lifecycle === "authorization-unavailable")
          registry.closeAll("Remote authorization unavailable");
        else registry.closeAll();
        const [code] = (await closed) as [number];
        expect(code).toBe(lifecycle === "access-disabled" ? HOST_SESSION_CLOSE_REVOKED : 1012);
        expect(
          classifyConnectionFailure(
            new HostDialError("Peer closed during handshake", {
              stage: "handshake",
              closeCode: code,
            }),
          ),
        ).toBe(lifecycle === "access-disabled" ? "revoked" : "reconnecting");
        expect(registry.size).toBe(0);
      } finally {
        client.terminate();
        for (const socket of server.clients) socket.terminate();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );

  it("projects live session identity, transport, and start time without exposing close handles", () => {
    const registry = new RemoteSessionRegistry();
    registry.add({
      id: "session-1",
      userId: "user-1",
      deviceJkt: "device-thumbprint",
      startedAt: "2026-08-14T10:00:00.000Z",
      expiresAtSeconds: 2_000_000_000,
      via: "ssh-forward",
      close: vi.fn(),
    });

    expect(registry.list()).toEqual([
      {
        id: "session-1",
        userId: "user-1",
        deviceJkt: "device-thumbprint",
        transport: "ssh-forward",
        startedAt: "2026-08-14T10:00:00.000Z",
      },
    ]);
    expect(registry.list()[0]).not.toHaveProperty("close");
  });

  it("lets the owner end one live session through the same close path revocation uses", () => {
    const registry = new RemoteSessionRegistry();
    const firstClose = vi.fn();
    const secondClose = vi.fn();
    for (const [id, close] of [
      ["session-1", firstClose],
      ["session-2", secondClose],
    ] as const) {
      registry.add({
        id,
        userId: "user-1",
        deviceJkt: `${id}-device`,
        startedAt: "2026-08-14T10:00:00.000Z",
        expiresAtSeconds: 2_000_000_000,
        via: "relay",
        close,
      });
    }

    expect(registry.end("session-1")).toBe(true);
    expect(firstClose).toHaveBeenCalledWith(HOST_SESSION_CLOSE_REVOKED, "ended by host owner");
    expect(secondClose).not.toHaveBeenCalled();
    expect(registry.list()).toHaveLength(1);
    expect(registry.end("missing-session")).toBe(false);
  });
});
