import { describe, expect, it, vi } from "vitest";

import {
  DesktopRemoteAccessControlPlane,
  testRemoteCompanionConnection,
} from "./remoteAccessControlPlane";

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("desktop remote access control plane", () => {
  it("keeps owner auth in main-process memory and creates a fragment pairing link", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          authenticated: true,
          role: "owner",
          sessionToken: "owner-bearer",
          expiresAt: "2026-08-18T00:00:00.000Z",
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          id: "pair-1",
          credential: "ABC123DEF456",
          expiresAt: "2026-07-18T00:05:00.000Z",
        }),
      );
    const controlPlane = new DesktopRemoteAccessControlPlane(fetchImpl);
    controlPlane.configure({
      backendHttpUrl: "http://127.0.0.1:3773",
      bootstrapCredential: "desktop-bootstrap-secret",
    });

    await expect(controlPlane.initializeOwnerSession()).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    await expect(
      controlPlane.createPairingLink({
        trustedOrigin: "https://desktop.tail123.ts.net",
        privateRouteVerified: true,
        label: "Khush's iPhone",
      }),
    ).resolves.toEqual({
      id: "pair-1",
      credential: "ABC123DEF456",
      expiresAt: "2026-07-18T00:05:00.000Z",
      pairingUrl: "https://desktop.tail123.ts.net/mobile/pair#token=ABC123DEF456",
    });

    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      "http://127.0.0.1:3773/api/auth/bootstrap/bearer",
    );
    expect(fetchImpl.mock.calls[1]?.[1]?.headers).toMatchObject({
      Authorization: "Bearer owner-bearer",
    });
    expect(JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body))).toEqual({
      accessProfile: "companion",
      label: "Khush's iPhone",
    });
    expect(String(fetchImpl.mock.calls[1]?.[0])).not.toContain("ABC123DEF456");
  });

  it("retries lazily after an eager owner-session exchange fails", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ error: "not ready" }, 503))
      .mockResolvedValueOnce(jsonResponse({ sessionToken: "owner-after-retry" }))
      .mockResolvedValueOnce(jsonResponse([]));
    const controlPlane = new DesktopRemoteAccessControlPlane(fetchImpl);
    controlPlane.configure({
      backendHttpUrl: "http://127.0.0.1:3773",
      bootstrapCredential: "desktop-bootstrap-secret",
    });

    await expect(controlPlane.initializeOwnerSession()).rejects.toThrow(/not ready/);
    await expect(controlPlane.listDevices()).resolves.toEqual([]);

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fetchImpl.mock.calls[2]?.[1]?.headers).toMatchObject({
      Authorization: "Bearer owner-after-retry",
    });
  });

  it("re-exchanges owner auth after a backend restart invalidates memory state", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ sessionToken: "owner-before-restart" }))
      .mockResolvedValueOnce(jsonResponse({ sessionToken: "owner-after-restart" }))
      .mockResolvedValueOnce(jsonResponse([]));
    const controlPlane = new DesktopRemoteAccessControlPlane(fetchImpl);
    controlPlane.configure({
      backendHttpUrl: "http://127.0.0.1:3773",
      bootstrapCredential: "desktop-bootstrap-secret",
    });

    await controlPlane.initializeOwnerSession();
    controlPlane.resetOwnerSession();
    await controlPlane.initializeOwnerSession();
    await expect(controlPlane.listDevices()).resolves.toEqual([]);

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fetchImpl.mock.calls[2]?.[1]?.headers).toMatchObject({
      Authorization: "Bearer owner-after-restart",
    });
  });

  it("refuses to issue a pairing credential until the private route is verified", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const controlPlane = new DesktopRemoteAccessControlPlane(fetchImpl);
    controlPlane.configure({
      backendHttpUrl: "http://127.0.0.1:3773",
      bootstrapCredential: "bootstrap",
    });

    await expect(
      controlPlane.createPairingLink({
        trustedOrigin: "https://desktop.tail123.ts.net",
        privateRouteVerified: false,
      }),
    ).rejects.toThrow(/private Tailscale Serve route/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("normalizes the owner-only device list and revokes by session id", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ sessionToken: "owner" }))
      .mockResolvedValueOnce(
        jsonResponse([
          {
            sessionId: "session-1",
            subject: "one-time-token",
            role: "client",
            accessProfile: "companion",
            client: { label: "Phone", deviceType: "mobile", os: "iOS" },
            issuedAt: "2026-07-18T00:00:00.000Z",
            expiresAt: "2026-08-18T00:00:00.000Z",
            lastConnectedAt: null,
            connected: true,
          },
        ]),
      )
      .mockResolvedValueOnce(jsonResponse({ revoked: true }));
    const controlPlane = new DesktopRemoteAccessControlPlane(fetchImpl);
    controlPlane.configure({
      backendHttpUrl: "http://127.0.0.1:3773",
      bootstrapCredential: "bootstrap",
    });

    await expect(controlPlane.listDevices()).resolves.toEqual([
      expect.objectContaining({
        sessionId: "session-1",
        label: "Phone",
        accessProfile: "companion",
        connected: true,
      }),
    ]);
    await expect(controlPlane.revokeDevice("session-1")).resolves.toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("uses the Companion-only bulk revocation endpoint", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ sessionToken: "owner" }))
      .mockResolvedValueOnce(jsonResponse({ revokedCount: 2 }));
    const controlPlane = new DesktopRemoteAccessControlPlane(fetchImpl);
    controlPlane.configure({
      backendHttpUrl: "http://127.0.0.1:3773",
      bootstrapCredential: "bootstrap",
    });

    await expect(controlPlane.revokeAllDevices()).resolves.toBe(2);
    expect(fetchImpl.mock.calls[1]?.[0]).toBe(
      "http://127.0.0.1:3773/api/auth/clients/revoke-companion",
    );
  });

  it("verifies the configured HTTPS endpoint is an enabled Synara Companion", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({ enabled: true, protocolVersion: 1, serverVersion: "0.5.5" }),
    );
    await expect(
      testRemoteCompanionConnection("https://desktop.tail123.ts.net", fetchImpl),
    ).resolves.toMatchObject({ reachable: true, status: 200 });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://desktop.tail123.ts.net/api/companion/v1/info",
      expect.objectContaining({ method: "GET", redirect: "manual" }),
    );
  });

  it("rejects an unrelated service that happens to return HTTP 200", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ ok: true }));
    await expect(
      testRemoteCompanionConnection("https://desktop.tail123.ts.net", fetchImpl),
    ).resolves.toMatchObject({ reachable: false, status: 200 });
  });
});
