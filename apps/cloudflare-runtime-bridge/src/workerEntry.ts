/**
 * Deploy entrypoint: wraps the testable Worker/DO with the real Cloudflare
 * bindings (WebSocketPair global, a sandbox/container runtime factory).
 *
 * The core logic in `worker.ts` and `instanceDurableObject.ts` takes its
 * platform and runtime factory by injection so it can run in a plain test
 * process. This file is the thin production seam that supplies the real ones; it
 * is what `wrangler.toml` points `main` at. It is intentionally untyped against
 * the live `@cloudflare/workers-types` (not vendored here) — the bindings are
 * resolved at deploy time.
 *
 * @module workerEntry
 */
import type {
  BridgeEnv,
  DurableObjectPlatformGlobals,
  DurableObjectState,
  SandboxRuntime,
  WorkerWebSocketPair,
} from "./cloudflareRuntime.ts";
import {
  RuntimeInstanceDurableObject,
  type DurableObjectPlatform,
  type SandboxRuntimeFactory,
} from "./instanceDurableObject.ts";
import { handleFetch } from "./worker.ts";

/**
 * Resolve the lower-level Cloudflare runtime for an instance. The real binding
 * (Sandbox SDK for `workspace`, raw Containers for `container`) is wired here at
 * deploy time. Until that binding is configured this throws, so a misconfigured
 * deploy fails loudly rather than silently degrading.
 */
const realSandboxRuntimeFactory: SandboxRuntimeFactory = () =>
  Promise.reject(
    new Error(
      "Cloudflare sandbox/container runtime binding is not configured; wire it in workerEntry.ts before deploy.",
    ) as never,
  ) as Promise<SandboxRuntime>;

const realPlatform = (globals: DurableObjectPlatformGlobals): DurableObjectPlatform => ({
  makeWebSocketPair: () => new globals.WebSocketPair() as unknown as WorkerWebSocketPair,
  now: () => new Date().toISOString(),
  randomId: () => crypto.randomUUID(),
});

/**
 * The Durable Object class wrangler binds. Cloudflare constructs it with
 * `(state, env)`; this subclass supplies the injected factory + platform the
 * core DO needs.
 */
export class RuntimeInstanceDurableObjectBinding extends RuntimeInstanceDurableObject {
  constructor(state: DurableObjectState, env: BridgeEnv) {
    super(state, env, realSandboxRuntimeFactory, realPlatform(globalThis as never));
  }
}

export default {
  fetch: (request: Request, env: BridgeEnv): Promise<Response> => handleFetch(request, env),
};
