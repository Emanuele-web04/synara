/**
 * VercelSandboxRuntimeProviderFacade - adapts the Vercel Sandbox runtime adapter
 * to the provider-agnostic `ExecutionRuntimeProviderAdapterShape` the registry
 * resolves.
 *
 * The Vercel adapter provisions from a Vercel-shaped input that returns
 * `{ instance, rootPath, routes }` and fails with
 * `RuntimeRemoteOperationFailedError`; the common surface provisions from a
 * public `RuntimePlan`, returns `{ instance, rootPath }`, and carries narrower
 * channels (no error on `provision`/`createTransport`,
 * `RuntimeInstanceUnknownError` on `execCollect`). This facade owns that
 * translation: it forwards the plan, drops the provider-only `routes` from the
 * result, and erases the provider error on the channels the common shape declares
 * as `never` (via `Effect.orDie`). `execCollect` already fails with
 * `RuntimeInstanceUnknownError`, so it passes through unchanged. Provider-only
 * operations (exposePort/snapshot/extendTimeout/stop) stay on the concrete
 * adapter for the lease/ingress slices to call directly.
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
    vercel.provision({ threadId: String(threadId), plan }).pipe(
      Effect.map((context) => ({ instance: context.instance, rootPath: context.rootPath })),
      Effect.orDie,
    ),
  createTransport: (instanceId, spawn) =>
    vercel.createTransport(instanceId, spawn).pipe(Effect.orDie),
  execCollect: vercel.execCollect,
  isAlive: vercel.isAlive,
  destroy: vercel.destroy,
});
