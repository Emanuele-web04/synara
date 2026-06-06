/**
 * Cloudflare-specific bridge-client tests.
 *
 * The provider's baseline behavior (provision / exec / non-zero exit / transport
 * roundtrip + exit / git clone + diff / idempotent destroy / liveness / plan
 * rejection) is asserted by the shared Phase-17 harness in
 * `CloudflareRuntimeProviderAdapter.contract.test.ts`. This file covers only the
 * Cloudflare-specific bridge routes the shared harness does not exercise: file
 * read/write round-trip, on-demand port exposure, network policy, and activity
 * renewal — driven through the in-process fake bridge (real temp dirs, no
 * network).
 *
 * @module CloudflareRuntimeProviderAdapter.test
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { CloudflareBridgeClient } from "../Services/CloudflareBridgeClient.ts";
import { CloudflareRuntimeProviderAdapter } from "../Services/CloudflareRuntimeProviderAdapter.ts";
import { CloudflareBridgeClientLive } from "./CloudflareBridgeClient.ts";
import { CloudflareRuntimeProviderAdapterLive } from "./CloudflareRuntimeProviderAdapter.ts";
import { makeFakeCloudflareBridge } from "./cloudflareBridgeTestSupport.ts";

const makeRuntime = () => {
  const { layer: connectionLayer } = makeFakeCloudflareBridge();
  const layer = CloudflareRuntimeProviderAdapterLive.pipe(
    Layer.provideMerge(CloudflareBridgeClientLive),
    Layer.provideMerge(connectionLayer),
    Layer.provideMerge(NodeServices.layer),
  );
  return ManagedRuntime.make(layer);
};

type AdapterRuntime = ReturnType<typeof makeRuntime>;

const provision = (runtime: AdapterRuntime) =>
  runtime.runPromise(
    Effect.gen(function* () {
      const adapter = yield* CloudflareRuntimeProviderAdapter;
      return yield* adapter.provision({ threadId: "thread-cf" });
    }),
  );

describe("CloudflareRuntimeProviderAdapter bridge-specific routes (fake bridge)", () => {
  let runtime: AdapterRuntime | undefined;

  afterEach(async () => {
    if (runtime) {
      await runtime.dispose();
      runtime = undefined;
    }
  });

  it("reads and writes a file through the bridge client (base64 round-trip)", async () => {
    runtime = makeRuntime();
    const localRuntime = runtime;
    const context = await provision(localRuntime);

    const content = new TextEncoder().encode("export const x = 1\n");
    await localRuntime.runPromise(
      Effect.gen(function* () {
        const client = yield* CloudflareBridgeClient;
        yield* client.writeFile({
          instanceId: context.instance.id,
          path: "x.ts",
          content,
        });
      }),
    );
    const read = await localRuntime.runPromise(
      Effect.gen(function* () {
        const client = yield* CloudflareBridgeClient;
        return yield* client.readFile({ instanceId: context.instance.id, path: "x.ts" });
      }),
    );
    expect(new TextDecoder().decode(read)).toBe("export const x = 1\n");
  });

  it("exposes a port, sets a network policy, and renews activity", async () => {
    runtime = makeRuntime();
    const localRuntime = runtime;
    const context = await provision(localRuntime);

    const route = await localRuntime.runPromise(
      Effect.gen(function* () {
        const client = yield* CloudflareBridgeClient;
        return yield* client.exposePort(context.instance.id, { port: 3000, label: "dev" });
      }),
    );
    expect(route.port).toBe(3000);
    expect(route.url).toContain("port-3000");

    await localRuntime.runPromise(
      Effect.gen(function* () {
        const client = yield* CloudflareBridgeClient;
        yield* client.setNetworkPolicy(context.instance.id, {
          defaultEgress: "deny",
          rules: [{ action: "allow", host: "github.com" }],
        });
      }),
    );

    const renew = await localRuntime.runPromise(
      Effect.gen(function* () {
        const client = yield* CloudflareBridgeClient;
        return yield* client.renewActivity(context.instance.id, {
          reason: "turn",
          extendSeconds: 120,
        });
      }),
    );
    expect(renew.remainingSeconds).toBe(120);
    expect(renew.expiresAt).not.toBeNull();
  });
});
