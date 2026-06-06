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
  WorkerWebSocketPair,
} from "./cloudflareRuntime.ts";
import {
  loadCloudflareSandboxSdk,
  type CloudflareSandboxSdkLoader,
} from "./cloudflareSandboxSdk.ts";
import {
  RuntimeInstanceDurableObject,
  type DurableObjectPlatform,
  type SandboxRuntimeFactory,
} from "./instanceDurableObject.ts";
import { resolveRealSandboxRuntime } from "./realSandboxRuntime.ts";
import { handleFetch } from "./worker.ts";

/**
 * Build the production runtime factory bound to this instance's environment.
 *
 * The real `workspace` runtime is the `@cloudflare/sandbox` SDK resolved from the
 * `SANDBOX` Durable Object binding. The factory constructs that runtime per
 * instance id rather than throwing: a configured deploy gets a live workspace.
 * It throws only on a genuine misconfiguration — the SANDBOX binding missing at
 * runtime — so a broken deploy fails loudly instead of silently degrading. The
 * `container` flavor (raw Containers) is intentionally not wired here: it stays a
 * lower-level service runtime and rejects until a Containers binding is added.
 *
 * `loadSdk` is injected so a deploy can supply an already-imported SDK (or a
 * stub) without this module statically importing the optional dependency.
 */
export const makeRealSandboxRuntimeFactory = (
  env: BridgeEnv,
  loadSdk: CloudflareSandboxSdkLoader,
): SandboxRuntimeFactory => {
  return async (input) => {
    if (input.flavor === "container") {
      throw new Error(
        "Cloudflare `container` flavor (raw Containers) is not wired in workerEntry.ts; add a Containers binding before using it.",
      );
    }
    if (env.SANDBOX === undefined) {
      throw new Error(
        "Cloudflare `SANDBOX` binding is not configured; add a [[durable_objects]] binding named SANDBOX (the @cloudflare/sandbox DO) before deploy.",
      );
    }
    const sdk = await loadSdk();
    return resolveRealSandboxRuntime(sdk, env.SANDBOX, input.instanceId);
  };
};

const realPlatform = (globals: DurableObjectPlatformGlobals): DurableObjectPlatform => ({
  makeWebSocketPair: () => new globals.WebSocketPair() as unknown as WorkerWebSocketPair,
  now: () => new Date().toISOString(),
  randomId: () => crypto.randomUUID(),
});

/**
 * The Durable Object class wrangler binds. Cloudflare constructs it with
 * `(state, env)`; this subclass supplies the injected factory (bound to `env`'s
 * SANDBOX binding) + platform the core DO needs.
 */
export class RuntimeInstanceDurableObjectBinding extends RuntimeInstanceDurableObject {
  constructor(state: DurableObjectState, env: BridgeEnv) {
    super(
      state,
      env,
      makeRealSandboxRuntimeFactory(env, loadCloudflareSandboxSdk),
      realPlatform(globalThis as never),
    );
  }
}

export default {
  fetch: (request: Request, env: BridgeEnv): Promise<Response> => handleFetch(request, env),
};
