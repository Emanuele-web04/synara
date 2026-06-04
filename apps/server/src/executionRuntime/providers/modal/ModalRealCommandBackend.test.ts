/**
 * ModalRealCommandBackend tests — the real backend's SDK-backed ingress path.
 *
 * The real Modal backend resolves a port's public tunnel URL through the `modal`
 * JS SDK. These tests inject a stub SDK loader (no network, no optional
 * dependency installed) so the real `exposePort -> sandboxes.fromId -> tunnels()`
 * code path is covered, plus its honest fallbacks: a CLI-staging instance with no
 * live sandbox, an unknown port, and an SDK failure all surface a null url rather
 * than a fault.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ExecutionInstanceId } from "@t3tools/contracts";
import { Effect, ManagedRuntime } from "effect";
import { describe, expect, it } from "vitest";

import { makeModalRealCommandBackend } from "./ModalRealCommandBackend.ts";
import type { ModalCredentials } from "./ModalCredentials.ts";
import type { ModalSdk, ModalSdkLoader, ModalSdkSandbox } from "./modalSdk.ts";

const credentials: ModalCredentials = {
  tokenId: "tok-id",
  tokenSecret: "tok-secret",
  environment: undefined,
};

/**
 * A stub SDK whose `sandboxes.fromId` returns a sandbox exposing one tunnel per
 * declared port. `tunnels()` mirrors the real shape: a record keyed by container
 * port whose entry's `url()` yields the public `*.modal.run` endpoint.
 */
const makeStubSdk = (
  tunnelPorts: ReadonlyArray<number>,
  options?: { readonly failFromId?: boolean },
): ModalSdkLoader => {
  const sdk: ModalSdk = {
    makeClient: () => ({
      sandboxes: {
        fromId: async (sandboxId: string): Promise<ModalSdkSandbox> => {
          if (options?.failFromId === true) {
            throw new Error("sandbox not found");
          }
          const tunnels = Object.fromEntries(
            tunnelPorts.map((port) => [port, { url: () => `https://${sandboxId}.modal.run` }]),
          );
          return {
            sandboxId,
            tunnels: async () => tunnels,
            poll: async () => null,
            terminate: async () => undefined,
          };
        },
      },
    }),
  };
  return () => Promise.resolve(sdk);
};

const runtime = ManagedRuntime.make(NodeServices.layer);

describe("ModalRealCommandBackend ingress", () => {
  it("resolves a live sandbox's tunnel URL through the SDK once a sandbox is attached", async () => {
    const route = await runtime.runPromise(
      Effect.gen(function* () {
        const backend = yield* makeModalRealCommandBackend(credentials, {
          loadSdk: makeStubSdk([3000]),
        });
        const context = yield* backend.provision({ threadId: "t", role: "service" });
        yield* backend.attachSandbox(context.instanceId, "sb-live-1");
        const result = yield* backend.exposePort(context.instanceId, 3000);
        yield* backend.destroy(context.instanceId);
        return result;
      }),
    );
    expect(route.port).toBe(3000);
    expect(route.url).toBe("https://sb-live-1.modal.run");
  });

  it("reports a null url for an instance with no live sandbox (CLI staging path)", async () => {
    const route = await runtime.runPromise(
      Effect.gen(function* () {
        const backend = yield* makeModalRealCommandBackend(credentials, {
          loadSdk: makeStubSdk([3000]),
        });
        const context = yield* backend.provision({ threadId: "t", role: "service" });
        const result = yield* backend.exposePort(context.instanceId, 3000);
        yield* backend.destroy(context.instanceId);
        return result;
      }),
    );
    expect(route).toEqual({ port: 3000, url: null });
  });

  it("reports a null url for a port the live sandbox exposes no tunnel for", async () => {
    const route = await runtime.runPromise(
      Effect.gen(function* () {
        const backend = yield* makeModalRealCommandBackend(credentials, {
          loadSdk: makeStubSdk([3000]),
        });
        const context = yield* backend.provision({ threadId: "t", role: "service" });
        yield* backend.attachSandbox(context.instanceId, "sb-live-2");
        const result = yield* backend.exposePort(context.instanceId, 9999);
        yield* backend.destroy(context.instanceId);
        return result;
      }),
    );
    expect(route).toEqual({ port: 9999, url: null });
  });

  it("falls soft to a null url when the SDK lookup fails", async () => {
    const route = await runtime.runPromise(
      Effect.gen(function* () {
        const backend = yield* makeModalRealCommandBackend(credentials, {
          loadSdk: makeStubSdk([3000], { failFromId: true }),
        });
        const context = yield* backend.provision({ threadId: "t", role: "service" });
        yield* backend.attachSandbox(context.instanceId, "sb-live-3");
        const result = yield* backend.exposePort(context.instanceId, 3000);
        yield* backend.destroy(context.instanceId);
        return result;
      }),
    );
    expect(route).toEqual({ port: 3000, url: null });
  });

  it("reports a null url for an unknown instance", async () => {
    const route = await runtime.runPromise(
      Effect.gen(function* () {
        const backend = yield* makeModalRealCommandBackend(credentials, {
          loadSdk: makeStubSdk([3000]),
        });
        return yield* backend.exposePort(ExecutionInstanceId.makeUnsafe("modal-missing"), 3000);
      }),
    );
    expect(route).toEqual({ port: 3000, url: null });
  });
});
