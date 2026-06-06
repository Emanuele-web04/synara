/**
 * ModalRuntimeProviderFacade - adapts the Modal runtime adapter to the
 * provider-agnostic `ExecutionRuntimeProviderAdapterShape` the registry resolves.
 *
 * Modal is the one provider keyed by an internal `ModalRuntimeRole` rather than a
 * plan, analogous to the fake's flavor. This facade owns the
 * `RuntimePlan -> ModalRuntimeRole` derivation (mirroring `deriveFakeFlavor`): a
 * plan that asks for ports lands on the ingress-capable `service` role; a plan
 * with no ports lands on the one-shot `job` role. `provision` forwards the
 * derived role and drops it from the result so the service stays provider-
 * agnostic. `createTransport`/`execCollect` already carry the same
 * `ChildProcessSpawner` requirement the common shape declares and Modal's exec
 * channel cannot fail (a non-zero exit is a terminal job result, not a provider
 * fault), so both pass through unchanged. Provider-only operations
 * (`exposePort`/`descriptorForRole`/`backendKind`) stay on the concrete adapter
 * for the ingress/lease slices to call directly.
 *
 * Mirrors `FakeRuntimeProviderFacade`: the service never learns Modal's roles or
 * input shape.
 *
 * @module ModalRuntimeProviderFacade
 */
import { Effect } from "effect";

import type { RuntimePlan } from "@t3tools/contracts";

import type { ExecutionRuntimeProviderAdapterShape } from "../Services/ExecutionRuntimeProviderAdapter.ts";
import type { ModalRuntimeProviderAdapterShape } from "../providers/modal/ModalRuntimeProviderAdapter.ts";
import type { ModalRuntimeRole } from "../providers/modal/ModalRuntimeRole.ts";

/**
 * Pick the Modal role a public `RuntimePlan` maps to. A plan requesting ports
 * needs ingress, which only `service`/`preview` honor, so it lands on `service`
 * (the broadest ingress-capable role the registry's `modal` descriptor reports);
 * a plan with no ports is the one-shot verification `job`. A `preview`-specific
 * plan has no distinct public signal yet, so it is not derived here — the
 * `preview` role stays an adapter-internal concern callers select directly. This
 * mirrors `deriveFakeFlavor`'s plan→flavor mapping.
 */
export const deriveModalRole = (plan: RuntimePlan): ModalRuntimeRole =>
  (plan.ports?.length ?? 0) > 0 ? "service" : "job";

export const makeModalRuntimeProviderFacade = (
  modal: ModalRuntimeProviderAdapterShape,
): ExecutionRuntimeProviderAdapterShape => ({
  provision: ({ threadId, plan }) =>
    modal
      .provision({ threadId: String(threadId), role: deriveModalRole(plan) })
      .pipe(Effect.map((context) => ({ instance: context.instance, rootPath: context.rootPath }))),
  createTransport: modal.createTransport,
  execCollect: modal.execCollect,
  isAlive: modal.isAlive,
  destroy: modal.destroy,
});
