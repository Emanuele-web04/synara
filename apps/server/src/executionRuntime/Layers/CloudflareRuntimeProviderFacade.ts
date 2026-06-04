/**
 * CloudflareRuntimeProviderFacade - adapts the Cloudflare runtime adapter to the
 * provider-agnostic `ExecutionRuntimeProviderAdapterShape` the registry resolves.
 *
 * The Cloudflare adapter provisions from a Cloudflare-shaped input and fails with
 * `CloudflareBridgeError`; the common surface provisions from a public
 * `RuntimePlan` and carries provider-neutral channels
 * (`RuntimeRemoteOperationFailedError` on `provision`/`createTransport`,
 * `RuntimeInstanceUnknownError` on `execCollect`). This facade owns that
 * translation: it maps the plan onto the Cloudflare provision input, converts the
 * bridge error to `RuntimeRemoteOperationFailedError` on `provision`/
 * `createTransport` so a real outage surfaces as a recoverable typed failure, and
 * converts the bridge error to `RuntimeInstanceUnknownError` on `execCollect`.
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

import { RuntimeInstanceUnknownError, RuntimeRemoteOperationFailedError } from "../Errors.ts";
import type { CloudflareBridgeError } from "../Errors.ts";
import type { ExecutionRuntimeProviderAdapterShape } from "../Services/ExecutionRuntimeProviderAdapter.ts";
import type { CloudflareRuntimeProviderAdapterShape } from "./CloudflareRuntimeProviderAdapter.ts";

const toRemoteOperationFailed = (error: CloudflareBridgeError): RuntimeRemoteOperationFailedError =>
  new RuntimeRemoteOperationFailedError({
    provider: "cloudflare",
    operation: error.operation,
    detail: error.detail,
  });

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
      Effect.mapError(toRemoteOperationFailed),
    ),
  createTransport: (instanceId, spawn) =>
    cloudflare.createTransport(instanceId, spawn).pipe(
      Effect.map((transport) => ({ transport })),
      Effect.mapError(toRemoteOperationFailed),
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
