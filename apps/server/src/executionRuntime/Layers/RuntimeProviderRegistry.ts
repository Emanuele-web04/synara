/**
 * RuntimeProviderRegistryLive - In-memory execution-runtime descriptor + adapter
 * lookup.
 *
 * Binds providers to their descriptors and (optionally) their lifecycle
 * adapters. Defaults to the built-in `local`/`worktree` descriptors with no
 * adapters; callers inject a custom descriptor set (planner validation) and/or
 * the adapters the service routes through. It performs lookup only — no
 * lifecycle, no provider calls.
 *
 * @module RuntimeProviderRegistryLive
 */
import { Effect, Layer } from "effect";

import type { ExecutionRuntimeProvider } from "@t3tools/contracts";

import { RuntimeProviderUnsupportedError } from "../Errors.ts";
import type { ExecutionRuntimeProviderAdapterShape } from "../Services/ExecutionRuntimeProviderAdapter.ts";
import type { FakeRuntimeFlavor } from "../Services/FakeRuntimeFlavor.ts";
import type { RuntimeProviderDescriptor } from "../Services/RuntimeProviderDescriptor.ts";
import {
  RuntimeProviderRegistry,
  type RuntimeProviderRegistryShape,
} from "../Services/RuntimeProviderRegistry.ts";
import { BUILT_IN_RUNTIME_DESCRIPTORS } from "./descriptors.ts";
import { FakeRuntimeProviderAdapter } from "../Services/FakeRuntimeProviderAdapter.ts";
import { makeFakeRuntimeProviderFacade } from "./FakeRuntimeProviderFacade.ts";
import { DaytonaRuntimeAdapter } from "../providers/daytona/DaytonaRuntimeAdapter.ts";
import { makeDaytonaRuntimeProviderFacade } from "./DaytonaRuntimeProviderFacade.ts";
import { VercelSandboxAdapter } from "../providers/vercelSandbox/Services/VercelSandboxAdapter.ts";
import { makeVercelSandboxRuntimeProviderFacade } from "./VercelSandboxRuntimeProviderFacade.ts";
import { ModalRuntimeProviderAdapter } from "../providers/modal/ModalRuntimeProviderAdapter.ts";
import { makeModalRuntimeProviderFacade } from "./ModalRuntimeProviderFacade.ts";
import { CloudflareRuntimeProviderAdapter } from "../Services/CloudflareRuntimeProviderAdapter.ts";
import { makeCloudflareRuntimeProviderFacade } from "./CloudflareRuntimeProviderFacade.ts";

export interface RuntimeProviderAdapterBinding {
  readonly provider: ExecutionRuntimeProvider;
  readonly adapter: ExecutionRuntimeProviderAdapterShape;
}

export interface RuntimeProviderRegistryLiveOptions {
  readonly descriptors?: ReadonlyArray<RuntimeProviderDescriptor>;
  readonly adapters?: ReadonlyArray<RuntimeProviderAdapterBinding>;
}

const makeRuntimeProviderRegistry = (options?: RuntimeProviderRegistryLiveOptions) =>
  Effect.sync(() => {
    const descriptors = options?.descriptors ?? BUILT_IN_RUNTIME_DESCRIPTORS;
    // Provider-keyed lookup ignores flavored `fake` descriptors so a plain
    // `fake` provider resolution does not silently bind to one arbitrary flavor.
    const byProvider = new Map(
      descriptors
        .filter((descriptor) => descriptor.flavor === undefined)
        .map((descriptor) => [descriptor.provider, descriptor]),
    );
    const byFlavor = new Map<FakeRuntimeFlavor, RuntimeProviderDescriptor>(
      descriptors
        .filter(
          (descriptor): descriptor is RuntimeProviderDescriptor & { flavor: FakeRuntimeFlavor } =>
            descriptor.flavor !== undefined,
        )
        .map((descriptor) => [descriptor.flavor, descriptor]),
    );
    const adapterByProvider = new Map<
      ExecutionRuntimeProvider,
      ExecutionRuntimeProviderAdapterShape
    >((options?.adapters ?? []).map((binding) => [binding.provider, binding.adapter]));

    const getDescriptor: RuntimeProviderRegistryShape["getDescriptor"] = (provider) => {
      const descriptor = byProvider.get(provider);
      if (!descriptor) {
        return Effect.fail(new RuntimeProviderUnsupportedError({ provider }));
      }
      return Effect.succeed(descriptor);
    };

    const getAdapter: RuntimeProviderRegistryShape["getAdapter"] = (provider) => {
      const adapter = adapterByProvider.get(provider);
      if (!adapter) {
        return Effect.fail(new RuntimeProviderUnsupportedError({ provider }));
      }
      return Effect.succeed(adapter);
    };

    const getDescriptorByFlavor: RuntimeProviderRegistryShape["getDescriptorByFlavor"] = (
      flavor,
    ) => {
      const descriptor = byFlavor.get(flavor);
      if (!descriptor) {
        return Effect.fail(new RuntimeProviderUnsupportedError({ provider: flavor }));
      }
      return Effect.succeed(descriptor);
    };

    const listProviders: RuntimeProviderRegistryShape["listProviders"] = () =>
      Effect.sync(() => Array.from(byProvider.keys()));

    return {
      getDescriptor,
      getAdapter,
      getDescriptorByFlavor,
      listProviders,
    } satisfies RuntimeProviderRegistryShape;
  });

export const makeRuntimeProviderRegistryLive = (options?: RuntimeProviderRegistryLiveOptions) =>
  Layer.effect(RuntimeProviderRegistry, makeRuntimeProviderRegistry(options));

export const RuntimeProviderRegistryLive = makeRuntimeProviderRegistryLive();

/**
 * Registry Live that also carries the `fake` provider's lifecycle adapter,
 * resolved from `FakeRuntimeProviderAdapter` and wrapped in its facade. This is
 * the variant `ExecutionRuntimeService` routes through; the descriptor-only Live
 * above is enough for callers that only validate plans. Real provider adapters
 * register here in later increments.
 */
export const makeRuntimeProviderRegistryWithFakeLive = (
  options?: RuntimeProviderRegistryLiveOptions,
) =>
  Layer.effect(
    RuntimeProviderRegistry,
    Effect.gen(function* () {
      const fake = yield* FakeRuntimeProviderAdapter;
      return yield* makeRuntimeProviderRegistry({
        ...options,
        adapters: [
          ...(options?.adapters ?? []),
          { provider: "fake", adapter: makeFakeRuntimeProviderFacade(fake) },
        ],
      });
    }),
  );

/**
 * Registry Live carrying the `fake` adapter plus every real provider adapter
 * registered to date. Each real adapter is resolved from its ServiceMap tag and
 * wrapped in its facade so the service routes to it by provider literal through
 * `getAdapter`. Callers `Layer.provide` each adapter's own Live layer (which
 * env-selects real-vs-fake client). The fake binding stays so the fake/local
 * paths are unchanged.
 */
export const makeRuntimeProviderRegistryWithAdaptersLive = (
  options?: RuntimeProviderRegistryLiveOptions,
) =>
  Layer.effect(
    RuntimeProviderRegistry,
    Effect.gen(function* () {
      const fake = yield* FakeRuntimeProviderAdapter;
      const daytona = yield* DaytonaRuntimeAdapter;
      const vercel = yield* VercelSandboxAdapter;
      const modal = yield* ModalRuntimeProviderAdapter;
      const cloudflare = yield* CloudflareRuntimeProviderAdapter;
      return yield* makeRuntimeProviderRegistry({
        ...options,
        adapters: [
          ...(options?.adapters ?? []),
          { provider: "fake", adapter: makeFakeRuntimeProviderFacade(fake) },
          { provider: "daytona", adapter: makeDaytonaRuntimeProviderFacade(daytona) },
          { provider: "vercel-sandbox", adapter: makeVercelSandboxRuntimeProviderFacade(vercel) },
          { provider: "modal", adapter: makeModalRuntimeProviderFacade(modal) },
          { provider: "cloudflare", adapter: makeCloudflareRuntimeProviderFacade(cloudflare) },
        ],
      });
    }),
  );
