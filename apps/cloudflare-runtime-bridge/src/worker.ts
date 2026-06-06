/**
 * Cloudflare Worker entrypoint for the runtime bridge.
 *
 * Authenticates every request with the shared bearer token, then routes:
 *   - `POST /instances`                 -> mint a new instance (new DO)
 *   - `*    /instances/:id/...`         -> forward to that instance's DO
 *
 * The Worker holds no instance state itself; the `runtimeInstanceId -> instance`
 * mapping lives in the Durable Object namespace keyed by instance id. This file
 * is the request dispatcher; per-instance behavior is in
 * `RuntimeInstanceDurableObject`.
 *
 * @module worker
 */
import { isAuthorized } from "./auth.ts";
import type { BridgeEnv, DurableObjectStub } from "./cloudflareRuntime.ts";
import { errorResponse } from "./responses.ts";
import { parseRoute } from "./routes.ts";

const newInstanceId = (): string => `cf-${crypto.randomUUID()}`;

/** Resolve the DO stub for an instance id. The DO branches on the same route. */
const instanceStub = (env: BridgeEnv, instanceId: string): DurableObjectStub => {
  const id = env.RUNTIME_INSTANCES.idFromName(instanceId);
  return env.RUNTIME_INSTANCES.get(id);
};

export const handleFetch = async (request: Request, env: BridgeEnv): Promise<Response> => {
  if (!isAuthorized(request, env.BRIDGE_AUTH_TOKEN)) {
    return errorResponse(401, "unauthorized");
  }
  const route = parseRoute(request);
  if (route === null) {
    return errorResponse(404, "not_found");
  }
  if (route.kind === "create-instance") {
    if (request.method !== "POST") {
      return errorResponse(405, "method_not_allowed");
    }
    // A fresh instance id names a never-before-addressed DO, so create is always
    // a clean single-writer instance.
    const instanceId = newInstanceId();
    return instanceStub(env, instanceId).fetch(rewriteForInstance(request, instanceId));
  }
  return instanceStub(env, route.instanceId).fetch(request);
};

/**
 * Point a create request at the freshly minted instance id so the DO addressed
 * by that id receives a `POST /instances/:id` it can treat as its own create.
 */
const rewriteForInstance = (request: Request, instanceId: string): Request => {
  const url = new URL(request.url);
  url.pathname = `/instances/${instanceId}`;
  return new Request(url.toString(), request);
};

export default {
  fetch: handleFetch,
};
