import { once } from "node:events";
import WebSocket, { WebSocketServer } from "ws";
import { afterEach, expect, it, vi } from "vitest";
import { HostConnectionRegistry } from "./registry";
import { superviseHostConnections } from "./supervisor";
import { RemoteHostTrustError } from "./failure";
import { controllerProtocol, HostDialError } from "./dialer";
import type { HostConnectionsPort } from "./port";

afterEach(() => vi.useRealTimers());

it("retries a desired host whose published route disappears during connector recovery", async () => {
  vi.useFakeTimers();
  const registry = new HostConnectionRegistry();
  registry.setConnector("mini", "Mini", async () => {
    throw new HostDialError("That host has no published route", { stage: "no-route" });
  });
  await expect(registry.probe("mini", controllerProtocol)).rejects.toMatchObject({
    detail: { stage: "no-route" },
  });
  expect(registry.status("mini").state).toBe("reconnecting");
  const connect = vi.fn(async () => {
    await registry.probe("mini", controllerProtocol);
    return registry.get("mini")!;
  });
  const port: HostConnectionsPort = {
    connect,
    disconnect: async () => {},
    list: async () => ({
      connections: registry.list(),
      desiredHosts: [{ hostId: "mini", environmentId: "mini", label: "Mini" }],
    }),
  };
  const stop = superviseHostConnections(port, registry);
  try {
    await vi.advanceTimersByTimeAsync(1_000);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(registry.status("mini").state).toBe("reconnecting");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(connect).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(connect).toHaveBeenCalledTimes(2);
  } finally {
    stop();
  }
});

it("bounds restoration to two dials and never resumes after stop during pending work", async () => {
  vi.useFakeTimers();
  const registry = new HostConnectionRegistry();
  const pending: Array<() => void> = [];
  const connect = vi.fn(
    () =>
      new Promise<never>((_resolve, reject) => pending.push(() => reject(new Error("offline")))),
  );
  const port: HostConnectionsPort = {
    connect,
    disconnect: async () => {},
    list: async () => ({
      connections: [],
      desiredHosts: ["a", "b", "c"].map((hostId) => ({
        hostId,
        environmentId: hostId,
        label: hostId,
      })),
    }),
  };
  const stop = superviseHostConnections(port, registry);
  await vi.advanceTimersByTimeAsync(0);
  expect(connect).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(5000);
  expect(connect).toHaveBeenCalledTimes(2);
  stop();
  pending.forEach((fail) => fail());
  await vi.advanceTimersByTimeAsync(60000);
  expect(connect).toHaveBeenCalledTimes(2);
  expect(registry.list()).toEqual([]);
});

it("waits for trust repair, then recovers from a transient failure even between supervisor ticks", async () => {
  vi.useFakeTimers();
  const registry = new HostConnectionRegistry();
  const host = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(host, "listening");
  const address = host.address();
  if (!address || typeof address === "string") throw new Error("No listening address");
  let desired = true;
  let failure: Error | undefined = new RemoteHostTrustError("Pair on the host again");
  const connect = vi.fn(async () => {
    if (failure) throw failure;
    registry.setConnector("mini", "Mini", async () => {
      if (failure) throw failure;
      const socket = new WebSocket(`ws://127.0.0.1:${address.port}`);
      await once(socket, "open");
      return {
        socket,
        environmentId: "mini",
        credential: "test-only",
        credentialExpiresAtSeconds: Date.now() / 1000 + 3600,
        transport: "lan",
        race: { outcome: "unreachable", attempts: [] },
        compatibility: {
          protocolEpoch: 1,
          negotiatedRevision: 1,
          serverBuild: "test",
          serverInstanceId: "mini",
          capabilities: [],
        },
      };
    });
    await registry.probe("mini", controllerProtocol);
    return registry.get("mini")!;
  });
  const port: HostConnectionsPort = {
    connect,
    disconnect: async () => {},
    list: async () => ({
      connections: [],
      desiredHosts: desired ? [{ hostId: "mini", environmentId: "mini", label: "Mini" }] : [],
    }),
  };
  const stop = superviseHostConnections(port, registry);
  try {
    await vi.advanceTimersByTimeAsync(60000);
    expect(connect).toHaveBeenCalledTimes(1);
    desired = false;
    await vi.advanceTimersByTimeAsync(1000);
    desired = true;
    await vi.advanceTimersByTimeAsync(1000);
    expect(connect).toHaveBeenCalledTimes(2);
    failure = undefined;
    await port.connect({ hostId: "mini" });
    expect(registry.status("mini").state).toBe("idle");
    // The next renderer can fail before the supervisor ever observes idle/connected.
    failure = new HostDialError("Route temporarily unavailable", { stage: "no-route" });
    await expect(registry.probe("mini", controllerProtocol)).rejects.toBe(failure);
    failure = undefined;
    await vi.advanceTimersByTimeAsync(3000);
    expect(connect).toHaveBeenCalledTimes(4);
    await vi.waitFor(() => expect(registry.status("mini").state).toBe("idle"));
  } finally {
    stop();
    for (const socket of host.clients) socket.terminate();
    host.close();
  }
});
