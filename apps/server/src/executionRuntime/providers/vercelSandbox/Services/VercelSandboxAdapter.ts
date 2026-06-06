/**
 * VercelSandboxAdapter - Service tag for the Vercel Sandbox runtime adapter.
 *
 * The concrete implementation lives in `Layers/VercelSandboxAdapter.ts`. It
 * pairs the static {@link VERCEL_SANDBOX_DESCRIPTOR} with the lifecycle
 * operations that provision sandboxes, run the agent as a streaming/detached
 * command behind a `JsonRpcLineTransport`, run fire-and-collect git commands,
 * expose declared ports, snapshot, extend the timeout, and tear down. It talks
 * only to {@link VercelSandboxClient}, so it is identical against the real
 * provider and the in-memory fake.
 *
 * @module VercelSandboxAdapter
 */
import { ServiceMap } from "effect";

import type { VercelSandboxAdapterShape } from "../Layers/VercelSandboxAdapter.ts";

export class VercelSandboxAdapter extends ServiceMap.Service<
  VercelSandboxAdapter,
  VercelSandboxAdapterShape
>()("t3/executionRuntime/providers/vercelSandbox/VercelSandboxAdapter") {}
