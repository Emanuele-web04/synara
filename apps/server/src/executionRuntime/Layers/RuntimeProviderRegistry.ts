/**
 * RuntimeProviderRegistryLive - In-memory execution-runtime descriptor lookup.
 *
 * Binds providers to their descriptors. Defaults to the built-in
 * `local`/`worktree` descriptors; callers may inject a custom set (tests,
 * fake-remote slices). It performs lookup only — no lifecycle, no provider
 * calls.
 *
 * @module RuntimeProviderRegistryLive
 */
import { Effect, Layer } from "effect";

import { RuntimeProviderUnsupportedError } from "../Errors.ts";
import type { FakeRuntimeFlavor } from "../Services/FakeRuntimeFlavor.ts";
import type { RuntimeProviderDescriptor } from "../Services/RuntimeProviderDescriptor.ts";
import {
  RuntimeProviderRegistry,
  type RuntimeProviderRegistryShape,
} from "../Services/RuntimeProviderRegistry.ts";
import { BUILT_IN_RUNTIME_DESCRIPTORS } from "./descriptors.ts";

export interface RuntimeProviderRegistryLiveOptions {
  readonly descriptors?: ReadonlyArray<RuntimeProviderDescriptor>;
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

    const getDescriptor: RuntimeProviderRegistryShape["getDescriptor"] = (provider) => {
      const descriptor = byProvider.get(provider);
      if (!descriptor) {
        return Effect.fail(new RuntimeProviderUnsupportedError({ provider }));
      }
      return Effect.succeed(descriptor);
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
      getDescriptorByFlavor,
      listProviders,
    } satisfies RuntimeProviderRegistryShape;
  });

export const makeRuntimeProviderRegistryLive = (options?: RuntimeProviderRegistryLiveOptions) =>
  Layer.effect(RuntimeProviderRegistry, makeRuntimeProviderRegistry(options));

export const RuntimeProviderRegistryLive = makeRuntimeProviderRegistryLive();
