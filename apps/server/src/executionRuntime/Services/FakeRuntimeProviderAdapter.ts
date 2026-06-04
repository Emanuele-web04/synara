/**
 * FakeRuntimeProviderAdapter - Service tag for the fake-remote runtime adapter.
 *
 * The concrete implementation lives in `Layers/FakeRuntimeProviderAdapter.ts`.
 * `ExecutionRuntimeService` resolves this tag to provision instances, create
 * transports, and destroy instances for the `fake` provider family.
 *
 * @module FakeRuntimeProviderAdapter
 */
import { ServiceMap } from "effect";

import type { FakeRuntimeProviderAdapterShape } from "../Layers/FakeRuntimeProviderAdapter.ts";

export class FakeRuntimeProviderAdapter extends ServiceMap.Service<
  FakeRuntimeProviderAdapter,
  FakeRuntimeProviderAdapterShape
>()("t3/executionRuntime/Services/FakeRuntimeProviderAdapter") {}
