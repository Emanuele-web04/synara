/**
 * CloudflareRuntimeProviderFacade - adapts the Cloudflare runtime adapter to the
 * provider-agnostic `ExecutionRuntimeProviderAdapterShape` the registry resolves.
 *
 * The Cloudflare adapter provisions from a Cloudflare-shaped input and fails with
 * `CloudflareBridgeError`; the common surface provisions from a public
 * `RuntimePlan` and carries narrower channels (no error on `provision`/
 * `createTransport`, `RuntimeInstanceUnknownError` on `execCollect`). This facade
 * owns that translation: it maps the plan onto the Cloudflare provision input,
 * erases the bridge error on the channels the common shape declares as `never`
 * (via `Effect.orDie`), and converts the bridge error to
 * `RuntimeInstanceUnknownError` on `execCollect`.
 *
 * Cloudflare's `createTransport` returns a BARE `JsonRpcLineTransport` (the
 * bridge terminal needs no in-memory forwarding controller — the WebSocket is the
 * forwarding seam), so the facade returns `{ transport }` and omits `controller`.
 * That is the one reason `controller` is optional on the common shape; every
 * other provider returns a real controller. Provider-only operations
 * (file read/write, port exposure, network policy, activity renewal) stay on the
 * concrete bridge client for the ingress/lease slices to call directly.
 *
 * Mirrors `FakeRuntimeProviderFacade`: the service never learns Cloudflare's
 * input shape or error types.
 *
 * @module CloudflareRuntimeProviderFacade
 */
import { Effect } from "effect";

import type { RuntimePlan } from "@t3tools/contracts";

import { RuntimeInstanceUnknownError } from "../Errors.ts";
import type { ExecutionRuntimeProviderAdapterShape } from "../Services/ExecutionRuntimeProviderAdapter.ts";
import type { CloudflareRuntimeProviderAdapterShape } from "./CloudflareRuntimeProviderAdapter.ts";

const provisionInput = (
  threadId: string,
  plan: RuntimePlan,
): {
  readonly threadId: string;
  readonly ports: ReadonlyArray<number>;
} => ({
  threadId,
  ports: plan.ports ?? [],
});

export const makeCloudflareRuntimeProviderFacade = (
  cloudflare: CloudflareRuntimeProviderAdapterShape,
): ExecutionRuntimeProviderAdapterShape => ({
  provision: ({ threadId, plan }) =>
    cloudflare.provision(provisionInput(String(threadId), plan)).pipe(
      Effect.map((context) => ({ instance: context.instance, rootPath: context.rootPath })),
      Effect.orDie,
    ),
  createTransport: (instanceId, spawn) =>
    cloudflare.createTransport(instanceId, spawn).pipe(
      Effect.map((transport) => ({ transport })),
      Effect.orDie,
    ),
  execCollect: (instanceId, input) =>
    cloudflare
      .execCollect(instanceId, input)
      .pipe(
        Effect.mapError(() => new RuntimeInstanceUnknownError({ instanceId: String(instanceId) })),
      ),
  isAlive: cloudflare.isAlive,
  destroy: cloudflare.destroy,
});
