import http from "node:http";
import path from "node:path";
import { once } from "node:events";
import { EnvironmentId } from "@synara/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initializeRemoteTlsIdentity, remoteTlsAnchor } from "../remoteTransport/certificates";
import { createRemoteDialFixture } from "../__fixtures__/remoteDial";
import { controllerProtocol, dialHost } from "./dialer";
const environmentId = EnvironmentId.makeUnsafe("test-environment");
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const fixture = (approved = true) => createRemoteDialFixture(cleanups, approved);

describe("remote dialer through native TLS and the host gateway", () => {
  it("refuses no-route without fetching a grant", async () => {
    const input = await fixture();
    await expect(
      dialHost({ ...input, host: { ...input.host, endpoints: [] } }),
    ).rejects.toMatchObject({ detail: { stage: "no-route" } });
    expect(input.requestGrant).not.toHaveBeenCalled();
  });

  it("mints and authorizes under the paired root before carrying application frames", async () => {
    const input = await fixture();
    const session = await dialHost(input);
    expect(session.transport).toBe("tailscale");
    expect(session.credentialExpiresAtSeconds).toBeGreaterThan(Date.now() / 1000);
    expect(input.sessions.size).toBe(1);
    const received = once(session.socket, "message");
    session.socket.send("first-application-frame");
    const [data, binary] = await received;
    expect(data.toString()).toBe("first-application-frame");
    expect(binary).toBe(false);
    session.socket.terminate();
  });

  it("negotiates the real renderer version on the host before opening its RPC bridge", async () => {
    const input = await fixture();
    await expect(
      dialHost({
        ...input,
        client: { ...controllerProtocol, protocolEpoch: controllerProtocol.protocolEpoch + 1 },
      }),
    ).rejects.toMatchObject({ code: "WS_PROTOCOL_INCOMPATIBLE", action: "update-server" });
    await vi.waitFor(() => expect(input.sessions.size).toBe(0));
    const session = await dialHost(input);
    expect(session.environmentId).toBe(environmentId);
    expect(session.compatibility).toMatchObject({
      protocolEpoch: controllerProtocol.protocolEpoch,
      negotiatedRevision: controllerProtocol.maxRevision,
    });
    expect(session.compatibility.serverInstanceId).toBeTruthy();
    session.socket.terminate();
  });

  it("falls back after a healthy endpoint refuses upgrade, with a fresh grant", async () => {
    const input = await fixture();
    const refusing = http.createServer((_request, response) => response.end("ok"));
    refusing.on("upgrade", (_request, socket) =>
      socket.end("HTTP/1.1 503 Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"),
    );
    refusing.listen(0, "127.0.0.1");
    await once(refusing, "listening");
    cleanups.push(() => new Promise<void>((resolve) => refusing.close(() => resolve())));
    const address = refusing.address() as { port: number };
    const session = await dialHost({
      ...input,
      host: {
        ...input.host,
        endpoints: [
          { url: `http://127.0.0.1:${address.port}`, transport: "lan" },
          ...input.host.endpoints,
        ],
      },
    });
    expect(input.requestGrant).toHaveBeenCalledTimes(2);
    expect(session.transport).toBe("tailscale");
    session.socket.terminate();
  });

  it("refuses a substituted root before sending device authorization", async () => {
    const input = await fixture();
    const substituted = await initializeRemoteTlsIdentity(
      path.join(input.directory, "substituted.json"),
      environmentId,
    );
    await expect(
      dialHost({ ...input, anchor: remoteTlsAnchor(substituted) }),
    ).rejects.toMatchObject({ detail: { stage: "unreachable" } });
    expect(input.authorize).not.toHaveBeenCalled();
    expect(input.sessions.size).toBe(0);
  });

  it("denies a valid cloud grant without host approval", async () => {
    const input = await fixture(false);
    await expect(dialHost(input)).rejects.toMatchObject({ detail: { stage: "handshake" } });
    expect(input.authorize).toHaveBeenCalledOnce();
    expect(input.sessions.size).toBe(0);
  });
});
