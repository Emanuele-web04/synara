import type { BridgeInstance } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import type { BridgeEnv, DurableObjectNamespace, DurableObjectStub } from "./cloudflareRuntime.ts";
import {
  makeFakeDurableObjectState,
  makeFakeSandboxRuntime,
  makeFakeWebSocketPair,
} from "./fakeSandboxRuntime.ts";
import {
  RuntimeInstanceDurableObject,
  type DurableObjectPlatform,
} from "./instanceDurableObject.ts";
import { handleFetch } from "./worker.ts";

const platform: DurableObjectPlatform = {
  makeWebSocketPair: makeFakeWebSocketPair,
  now: () => "2026-06-03T00:00:00.000Z",
  randomId: () => "rid",
};

/**
 * Back the namespace with real DOs keyed by instance id so the Worker's
 * create -> address-by-id flow is exercised end to end in one process.
 */
const makeNamespace = (env: BridgeEnv): DurableObjectNamespace => {
  const objects = new Map<string, RuntimeInstanceDurableObject>();
  return {
    idFromName: (name) => ({ toString: () => name }),
    get: (id): DurableObjectStub => {
      const key = id.toString();
      let object = objects.get(key);
      if (object === undefined) {
        object = new RuntimeInstanceDurableObject(
          makeFakeDurableObjectState(key),
          env,
          () => Promise.resolve(makeFakeSandboxRuntime()),
          platform,
        );
        objects.set(key, object);
      }
      const resolved = object;
      return { fetch: (request) => resolved.fetch(request) };
    },
  };
};

const makeEnv = (): BridgeEnv => {
  const env = { BRIDGE_AUTH_TOKEN: "s3cret" } as BridgeEnv;
  return { ...env, RUNTIME_INSTANCES: makeNamespace(env) };
};

const post = (path: string, token: string | null, body: unknown): Request =>
  new Request(`https://bridge.example${path}`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    },
  });

describe("bridge worker", () => {
  it("rejects an unauthenticated request", async () => {
    const env = makeEnv();
    const response = await handleFetch(post("/instances", null, {}), env);
    expect(response.status).toBe(401);
  });

  it("rejects a wrong token", async () => {
    const env = makeEnv();
    const response = await handleFetch(post("/instances", "wrong", {}), env);
    expect(response.status).toBe(401);
  });

  it("404s a path outside the instances namespace", async () => {
    const env = makeEnv();
    const response = await handleFetch(post("/unknown", "s3cret", {}), env);
    expect(response.status).toBe(404);
  });

  it("creates an instance and then addresses it by id", async () => {
    const env = makeEnv();
    const created = await handleFetch(post("/instances", "s3cret", { flavor: "workspace" }), env);
    expect(created.status).toBe(201);
    const record = (await created.json()) as BridgeInstance;
    expect(record.id.startsWith("cf-")).toBe(true);

    const fetched = await handleFetch(
      new Request(`https://bridge.example/instances/${record.id}`, {
        headers: { authorization: "Bearer s3cret" },
      }),
      env,
    );
    expect(fetched.status).toBe(200);
    const same = (await fetched.json()) as BridgeInstance;
    expect(same.id).toBe(record.id);
  });
});
