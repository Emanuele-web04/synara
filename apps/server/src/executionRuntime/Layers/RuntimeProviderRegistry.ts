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
    const byProvider = new Map(descriptors.map((descriptor) => [descriptor.provider, descriptor]));

    const getDescriptor: RuntimeProviderRegistryShape["getDescriptor"] = (provider) => {
      const descriptor = byProvider.get(provider);
      if (!descriptor) {
        return Effect.fail(new RuntimeProviderUnsupportedError({ provider }));
      }
      return Effect.succeed(descriptor);
    };

    const listProviders: RuntimeProviderRegistryShape["listProviders"] = () =>
      Effect.sync(() => Array.from(byProvider.keys()));

    return {
      getDescriptor,
      listProviders,
    } satisfies RuntimeProviderRegistryShape;
  });

export const makeRuntimeProviderRegistryLive = (options?: RuntimeProviderRegistryLiveOptions) =>
  Layer.effect(RuntimeProviderRegistry, makeRuntimeProviderRegistry(options));

export const RuntimeProviderRegistryLive = makeRuntimeProviderRegistryLive();
