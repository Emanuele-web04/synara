import { ThreadId } from "@synara/contracts";
import { Deferred, Effect, Fiber } from "effect";
import { describe, expect, it, vi } from "vitest";

import {
  acquireAgentGatewaySessionLease,
  releaseAgentGatewaySessionLeaseOnInterrupt,
  startAgentGatewaySessionLeaseExitWatcher,
} from "./sessionLease.ts";

describe("AgentGatewaySessionLease", () => {
  it("acquires one scoped connection and revokes it at most once", () => {
    const connectionForThread = vi.fn(() => ({
      url: "http://127.0.0.1:48123/mcp",
      bearerToken: "gateway-token",
    }));
    const revokeSessionToken = vi.fn();

    const lease = acquireAgentGatewaySessionLease(
      { connectionForThread, revokeSessionToken },
      ThreadId.makeUnsafe("thread-1"),
      "cursor",
    );

    expect(lease?.connection).toEqual({
      url: "http://127.0.0.1:48123/mcp",
      bearerToken: "gateway-token",
    });
    expect(connectionForThread).toHaveBeenCalledOnce();
    expect(connectionForThread).toHaveBeenCalledWith("thread-1", "cursor");

    lease?.release();
    lease?.release();

    expect(revokeSessionToken).toHaveBeenCalledOnce();
    expect(revokeSessionToken).toHaveBeenCalledWith("gateway-token");
  });

  it("keeps replacement runtimes on independent leases", () => {
    let sequence = 0;
    const connectionForThread = vi.fn(() => ({
      url: "http://127.0.0.1:48123/mcp",
      bearerToken: `gateway-token-${++sequence}`,
    }));
    const revokeSessionToken = vi.fn();
    const credentials = { connectionForThread, revokeSessionToken };
    const threadId = ThreadId.makeUnsafe("thread-1");

    const previous = acquireAgentGatewaySessionLease(credentials, threadId, "grok");
    const replacement = acquireAgentGatewaySessionLease(credentials, threadId, "grok");

    previous?.release();
    expect(revokeSessionToken).toHaveBeenLastCalledWith("gateway-token-1");
    expect(replacement?.connection.bearerToken).toBe("gateway-token-2");

    replacement?.release();
    expect(revokeSessionToken).toHaveBeenCalledTimes(2);
    expect(revokeSessionToken).toHaveBeenLastCalledWith("gateway-token-2");
  });

  it("does not acquire a credential when the gateway layer is absent", () => {
    expect(
      acquireAgentGatewaySessionLease(undefined, ThreadId.makeUnsafe("thread-1"), "droid"),
    ).toBeUndefined();
  });

  it("marks the lease released before delegating to a throwing revoker", () => {
    const revokeSessionToken = vi.fn(() => {
      throw new Error("revoke failed");
    });
    const lease = acquireAgentGatewaySessionLease(
      {
        connectionForThread: () => ({
          url: "http://127.0.0.1:48123/mcp",
          bearerToken: "gateway-token",
        }),
        revokeSessionToken,
      },
      ThreadId.makeUnsafe("thread-1"),
      "claudeAgent",
    );

    expect(() => lease?.release()).toThrow("revoke failed");
    expect(() => lease?.release()).not.toThrow();
    expect(revokeSessionToken).toHaveBeenCalledOnce();
  });

  it("releases a live lease when the provider exits spontaneously", async () => {
    const providerExited = Deferred.makeUnsafe<void>();
    const revokeSessionToken = vi.fn();
    const lease = acquireAgentGatewaySessionLease(
      {
        connectionForThread: () => ({
          url: "http://127.0.0.1:48123/mcp",
          bearerToken: "gateway-token",
        }),
        revokeSessionToken,
      },
      ThreadId.makeUnsafe("thread-1"),
      "cursor",
    );

    await Effect.runPromise(
      startAgentGatewaySessionLeaseExitWatcher(lease, Deferred.await(providerExited)),
    );
    expect(revokeSessionToken).not.toHaveBeenCalled();

    Deferred.doneUnsafe(providerExited, Effect.void);
    await vi.waitFor(() => expect(revokeSessionToken).toHaveBeenCalledOnce());

    lease?.release();
    expect(revokeSessionToken).toHaveBeenCalledOnce();
  });

  it("does not start an exit watcher when no credential was acquired", async () => {
    let awaitedExit = false;

    await Effect.runPromise(
      startAgentGatewaySessionLeaseExitWatcher(
        undefined,
        Effect.sync(() => {
          awaitedExit = true;
        }),
      ),
    );

    expect(awaitedExit).toBe(false);
  });

  it("releases an untransferred lease when provider startup is interrupted", async () => {
    const startupBarrier = Deferred.makeUnsafe<void>();
    const startupEntered = Deferred.makeUnsafe<void>();
    const revokeSessionToken = vi.fn();
    const lease = acquireAgentGatewaySessionLease(
      {
        connectionForThread: () => ({
          url: "http://127.0.0.1:48123/mcp",
          bearerToken: "gateway-token",
        }),
        revokeSessionToken,
      },
      ThreadId.makeUnsafe("thread-1"),
      "pi",
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        const startupFiber = yield* releaseAgentGatewaySessionLeaseOnInterrupt(
          lease,
          Deferred.succeed(startupEntered, undefined).pipe(
            Effect.andThen(Deferred.await(startupBarrier)),
          ),
        ).pipe(Effect.forkChild);
        yield* Deferred.await(startupEntered);
        yield* Fiber.interrupt(startupFiber);
      }),
    );

    expect(revokeSessionToken).toHaveBeenCalledOnce();
    lease?.release();
    expect(revokeSessionToken).toHaveBeenCalledOnce();
  });
});
