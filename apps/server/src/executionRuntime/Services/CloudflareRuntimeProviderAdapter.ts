/**
 * CloudflareRuntimeProviderAdapter - Service tag for the Cloudflare execution
 * runtime adapter.
 *
 * The concrete implementation lives in `Layers/CloudflareRuntimeProviderAdapter.ts`
 * and is built on `CloudflareBridgeClient`. It pairs the static Cloudflare
 * descriptor with provision / transport / git-exec / probe / destroy operations,
 * matching the shape of the fake-remote adapter so `ExecutionRuntimeService`
 * routes to it the same way.
 *
 * @module CloudflareRuntimeProviderAdapter
 */
import { ServiceMap } from "effect";

import type { CloudflareRuntimeProviderAdapterShape } from "../Layers/CloudflareRuntimeProviderAdapter.ts";

export class CloudflareRuntimeProviderAdapter extends ServiceMap.Service<
  CloudflareRuntimeProviderAdapter,
  CloudflareRuntimeProviderAdapterShape
>()("t3/executionRuntime/Services/CloudflareRuntimeProviderAdapter") {}
