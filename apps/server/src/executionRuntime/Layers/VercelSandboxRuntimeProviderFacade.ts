/**
 * VercelSandboxRuntimeProviderFacade - adapts the Vercel Sandbox runtime adapter
 * to the provider-agnostic `ExecutionRuntimeProviderAdapterShape` the registry
 * resolves.
 *
 * The Vercel adapter provisions from a Vercel-shaped input that returns
 * `{ instance, rootPath, routes }` and fails with
 * `RuntimeRemoteOperationFailedError`; the common surface provisions from a
 * public `RuntimePlan`, returns `{ instance, rootPath }`, and carries the same
 * provider-neutral channels (`RuntimeRemoteOperationFailedError` on
 * `provision`/`createTransport`, `RuntimeInstanceUnknownError` on `execCollect`).
 * This facade owns that translation: it forwards the plan and drops the
 * provider-only `routes` from the result. The provider error matches the common
 * shape's channel exactly, so `provision`/`createTransport`/`execCollect` all pass
 * through unchanged and a real outage surfaces as a recoverable typed failure.
 * Provider-only operations (exposePort/snapshot/extendTimeout/stop) stay on the
 * concrete adapter for the lease/ingress slices to call directly.
 *
 * Mirrors `DaytonaRuntimeProviderFacade`: the service never learns the Vercel
 * input shape or error types.
 *
 * @module VercelSandboxRuntimeProviderFacade
 */
import { Effect } from "effect";

import type { ExecutionRuntimeProviderAdapterShape } from "../Services/ExecutionRuntimeProviderAdapter.ts";
import type { VercelSandboxAdapterShape } from "../providers/vercelSandbox/Layers/VercelSandboxAdapter.ts";

export const makeVercelSandboxRuntimeProviderFacade = (
  vercel: VercelSandboxAdapterShape,
): ExecutionRuntimeProviderAdapterShape => ({
  provision: ({ threadId, plan }) =>
    vercel
      .provision({ threadId: String(threadId), plan })
      .pipe(Effect.map((context) => ({ instance: context.instance, rootPath: context.rootPath }))),
  createTransport: vercel.createTransport,
  execCollect: vercel.execCollect,
  isAlive: vercel.isAlive,
  destroy: vercel.destroy,
});
