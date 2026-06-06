import { assert, it } from "@effect/vitest";
import { Effect } from "effect";

import { RuntimeProviderUnsupportedError } from "../Errors.ts";
import { RuntimeProviderRegistry } from "../Services/RuntimeProviderRegistry.ts";
import { FAKE_RUNTIME_DESCRIPTORS } from "./fakeDescriptors.ts";
import { makeRuntimeProviderRegistryLive } from "./RuntimeProviderRegistry.ts";

const registryWithFakes = makeRuntimeProviderRegistryLive({
  descriptors: FAKE_RUNTIME_DESCRIPTORS,
});

const layer = it.layer(registryWithFakes);

layer("fake runtime descriptors via the registry", (it) => {
  it.effect("resolves each fake flavor's descriptor by flavor", () =>
    Effect.gen(function* () {
      const registry = yield* RuntimeProviderRegistry;
      const pty = yield* registry.getDescriptorByFlavor("fake-pty-workspace");
      assert.equal(pty.provider, "fake");
      assert.equal(pty.flavor, "fake-pty-workspace");
      assert.isTrue(pty.capabilities.exec.pty);

      const command = yield* registry.getDescriptorByFlavor("fake-command-workspace");
      assert.isFalse(command.capabilities.exec.pty);
      assert.isTrue(command.capabilities.exec.command);
    }),
  );

  it.effect("fails for an unknown fake flavor", () =>
    Effect.gen(function* () {
      const registry = yield* RuntimeProviderRegistry;
      const result = yield* registry
        // @ts-expect-error - exercising the unregistered-flavor failure path
        .getDescriptorByFlavor("fake-does-not-exist")
        .pipe(Effect.flip);
      assert.instanceOf(result, RuntimeProviderUnsupportedError);
    }),
  );

  it.effect("does not bind a flavored fake to the plain `fake` provider lookup", () =>
    Effect.gen(function* () {
      const registry = yield* RuntimeProviderRegistry;
      const result = yield* registry.getDescriptor("fake").pipe(Effect.flip);
      assert.instanceOf(result, RuntimeProviderUnsupportedError);
    }),
  );
});
