import { once } from "node:events";
import WebSocket, { WebSocketServer } from "ws";
import { afterEach, expect, it, vi } from "vitest";
import { HostConnectionRegistry } from "./registry";
import { AccountApiError } from "@synara/shared/account";
import {
  attentionRetryDelayMs,
  backgroundRetryDelayMs,
  superviseHostConnections,
} from "./supervisor";
import { RemoteHostTrustError } from "./failure";
import { controllerProtocol, HostDialError } from "./dialer";
import { HOST_SESSION_CLOSE_AUTH_FAILED } from "@synara/contracts";
import type { HostConnectionsPort } from "./port";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("retries a desired host whose published route disappears during connector recovery", async () => {
  vi.useFakeTimers();
  // Background retries are jittered; pin it to the nominal delay.
  vi.spyOn(Math, "random").mockReturnValue(0.5);
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
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  vi.spyOn(console, "warn").mockImplementation(() => {});
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
    await vi.advanceTimersByTimeAsync(59_000);
    expect(connect).toHaveBeenCalledTimes(1);
    // Trust failures stay parked between slow retries instead of forever.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(connect).toHaveBeenCalledTimes(2);
    desired = false;
    await vi.advanceTimersByTimeAsync(1000);
    desired = true;
    await vi.advanceTimersByTimeAsync(1000);
    expect(connect).toHaveBeenCalledTimes(3);
    failure = undefined;
    await port.connect({ hostId: "mini" });
    expect(registry.status("mini").state).toBe("idle");
    // The next renderer can fail before the supervisor ever observes idle/connected.
    failure = new HostDialError("Route temporarily unavailable", { stage: "no-route" });
    await expect(registry.probe("mini", controllerProtocol)).rejects.toBe(failure);
    failure = undefined;
    await vi.advanceTimersByTimeAsync(3000);
    expect(connect).toHaveBeenCalledTimes(5);
    await vi.waitFor(() => expect(registry.status("mini").state).toBe("idle"));
  } finally {
    stop();
    for (const socket of host.clients) socket.terminate();
    host.close();
  }
});

it("keeps short retries for a brief outage and spaces them out for a long or refused one", () => {
  const offline = new HostDialError("That host has no published route", { stage: "no-route" });
  const refused = new HostDialError(
    "Could not obtain a connection grant",
    { stage: "grant" },
    {
      cause: new AccountApiError({
        status: 403,
        code: "subscription_required",
        message: "Remote access requires an active Synara Alto subscription",
      }),
    },
  );
  const seconds = (error: unknown, failures: number[]) =>
    failures.map((count) => backgroundRetryDelayMs(count, error) / 1_000);
  expect(seconds(offline, [1, 2, 3, 4, 5, 10, 11, 12, 13, 14, 30])).toEqual([
    2, 4, 8, 16, 30, 30, 60, 120, 240, 300, 300,
  ]);
  expect(seconds(new Error("wrapper", { cause: refused }), [1, 2, 3, 4, 9])).toEqual([
    60, 120, 240, 300, 300,
  ]);
});

it("retries a relationship a renderer parked in an attention state after one slow interval", async () => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const registry = new HostConnectionRegistry();
  registry.setConnector("mini", "Mini", async () => {
    throw new HostDialError("Host closed the session", {
      stage: "handshake",
      closeCode: HOST_SESSION_CLOSE_AUTH_FAILED,
    });
  });
  await expect(registry.probe("mini", controllerProtocol)).rejects.toBeInstanceOf(HostDialError);
  expect(registry.status("mini").state).toBe("revoked");
  const connect = vi.fn(async () => {
    throw new HostDialError("Host is asleep", { stage: "unreachable" });
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
    await vi.advanceTimersByTimeAsync(59_000);
    expect(connect).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(connect).toHaveBeenCalledTimes(1);
    // The redial failed transiently, so the fast schedule takes over again.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(connect).toHaveBeenCalledTimes(2);
  } finally {
    stop();
  }
});

it("retries attention states no less often than every five minutes", () => {
  expect([1, 2, 3, 4, 9].map((count) => attentionRetryDelayMs(count) / 1_000)).toEqual([
    60, 120, 240, 300, 300,
  ]);
});
