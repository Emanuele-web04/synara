/**
 * Test-support layers for the execution-runtime service.
 *
 * `ExecutionRuntimeServiceLive` validates a `runtimePlan` against the resolved
 * provider descriptor, so it needs an `ExecutionRuntimePlanner` and a
 * `RuntimeProviderRegistry`. Production wiring builds these in `serverLayers.ts`;
 * harnesses and tests use this layer so the service's dependencies match without
 * duplicating the descriptor set.
 *
 * @module executionRuntime/testSupport
 */
import { Layer } from "effect";

import { BUILT_IN_RUNTIME_DESCRIPTORS } from "./descriptors.ts";
import { ExecutionRuntimePlannerLive } from "./ExecutionRuntimePlanner.ts";
import { FAKE_RUNTIME_DESCRIPTORS } from "./fakeDescriptors.ts";
import { makeRuntimeProviderRegistryLive } from "./RuntimeProviderRegistry.ts";

const runtimeProviderRegistryLayer = makeRuntimeProviderRegistryLive({
  descriptors: [...BUILT_IN_RUNTIME_DESCRIPTORS, ...FAKE_RUNTIME_DESCRIPTORS],
});

/** Planner + registry (with fake descriptors) for the execution-runtime service. */
export const ExecutionRuntimePlanningTestLive = Layer.mergeAll(
  ExecutionRuntimePlannerLive.pipe(Layer.provide(runtimeProviderRegistryLayer)),
  runtimeProviderRegistryLayer,
);
