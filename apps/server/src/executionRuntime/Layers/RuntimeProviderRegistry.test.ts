/**
 * RuntimeProviderRegistry getAdapter resolution test.
 *
 * Pins the pr9 unify guarantee: the registry built by
 * `makeRuntimeProviderRegistryWithAdaptersLive` resolves a lifecycle adapter for
 * every wired provider literal — `fake`, `daytona`, `vercel-sandbox`, `modal`,
 * and `cloudflare` — through `getAdapter`, and fails with
 * `RuntimeProviderUnsupportedError` for a provider with no adapter binding. Each
 * adapter is forced into its fake/in-repo backend (`env: {}`) so the suite needs
 * no provider access and matches the server-root wiring shape.
 *
 * @module RuntimeProviderRegistry.test
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { ExecutionRuntimeProvider } from "@t3tools/contracts";
import { Effect, Layer, ManagedRuntime } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { describe, expect, it } from "vitest";

import { RuntimeProviderUnsupportedError } from "../Errors.ts";
import { RuntimeProviderRegistry } from "../Services/RuntimeProviderRegistry.ts";
import { CLOUDFLARE_RUNTIME_DESCRIPTOR } from "./cloudflareDescriptor.ts";
import { makeCloudflareRuntimeAdapterLayer } from "./CloudflareRuntimeProviderFacadeLayer.ts";
import { BUILT_IN_RUNTIME_DESCRIPTORS } from "./descriptors.ts";
import { FAKE_RUNTIME_DESCRIPTORS } from "./fakeDescriptors.ts";
import { FakeRuntimeProviderAdapterLive } from "./FakeRuntimeProviderAdapter.ts";
import { makeRuntimeProviderRegistryWithAdaptersLive } from "./RuntimeProviderRegistry.ts";
import { DAYTONA_RUNTIME_DESCRIPTOR } from "../providers/daytona/descriptor.ts";
import { makeDaytonaRuntimeAdapterLayer } from "../providers/daytona/runtimeLayer.ts";
import { MODAL_PROVIDER_DESCRIPTOR } from "../providers/modal/modalDescriptors.ts";
import { makeModalRuntimeAdapterLayer } from "../providers/modal/runtimeLayer.ts";
import { VERCEL_SANDBOX_DESCRIPTOR } from "../providers/vercelSandbox/descriptor.ts";
import { makeVercelSandboxRuntimeAdapterLayer } from "../providers/vercelSandbox/runtimeLayer.ts";

const registryLayer = makeRuntimeProviderRegistryWithAdaptersLive({
  descriptors: [
    ...BUILT_IN_RUNTIME_DESCRIPTORS,
    ...FAKE_RUNTIME_DESCRIPTORS,
    DAYTONA_RUNTIME_DESCRIPTOR,
    VERCEL_SANDBOX_DESCRIPTOR,
    MODAL_PROVIDER_DESCRIPTOR,
    CLOUDFLARE_RUNTIME_DESCRIPTOR,
  ],
}).pipe(
  Layer.provide(FakeRuntimeProviderAdapterLive),
  Layer.provide(makeDaytonaRuntimeAdapterLayer({ env: {} })),
  Layer.provide(makeVercelSandboxRuntimeAdapterLayer({ env: {} })),
  Layer.provide(makeModalRuntimeAdapterLayer({ env: {} })),
  Layer.provide(makeCloudflareRuntimeAdapterLayer({ env: {} })),
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(FetchHttpClient.layer),
);

describe("RuntimeProviderRegistry getAdapter", () => {
  const runtime = ManagedRuntime.make(registryLayer);

  const wiredProviders: ReadonlyArray<ExecutionRuntimeProvider> = [
    "fake",
    "daytona",
    "vercel-sandbox",
    "modal",
    "cloudflare",
  ];

  it.each(wiredProviders)("resolves a lifecycle adapter for %s", async (provider) => {
    const adapter = await runtime.runPromise(
      Effect.gen(function* () {
        const registry = yield* RuntimeProviderRegistry;
        return yield* registry.getAdapter(provider);
      }),
    );
    expect(typeof adapter.provision).toBe("function");
    expect(typeof adapter.execCollect).toBe("function");
    expect(typeof adapter.createTransport).toBe("function");
    expect(typeof adapter.isAlive).toBe("function");
    expect(typeof adapter.destroy).toBe("function");
  });

  it("fails with RuntimeProviderUnsupportedError for a provider with no adapter", async () => {
    const error = await runtime.runPromise(
      Effect.gen(function* () {
        const registry = yield* RuntimeProviderRegistry;
        return yield* registry.getAdapter("local");
      }).pipe(Effect.flip),
    );
    expect(error).toBeInstanceOf(RuntimeProviderUnsupportedError);
    expect(error._tag).toBe("RuntimeProviderUnsupportedError");
    expect(error.provider).toBe("local");
  });
});
