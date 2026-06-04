/**
 * FakeRuntimeProviderFacade - adapts the fake-remote runtime adapter to the
 * provider-agnostic `ExecutionRuntimeProviderAdapterShape` the registry resolves.
 *
 * The fake adapter provisions by an internal `FakeRuntimeFlavor`; the common
 * surface provisions by a public `RuntimePlan`. This facade owns that
 * translation: `provision({ threadId, plan })` derives the fake flavor from the
 * plan and forwards to the fake adapter, dropping the flavor from the result so
 * the service stays provider-agnostic. Every other operation passes through
 * unchanged. Flavor derivation lives here, not in `ExecutionRuntimeService`, so
 * the service never knows the fake's sub-kinds exist.
 *
 * @module FakeRuntimeProviderFacade
 */
import { Effect } from "effect";

import type { RuntimePlan } from "@t3tools/contracts";

import type { ExecutionRuntimeProviderAdapterShape } from "../Services/ExecutionRuntimeProviderAdapter.ts";
import type { FakeRuntimeFlavor } from "../Services/FakeRuntimeFlavor.ts";
import type { FakeRuntimeProviderAdapterShape } from "./FakeRuntimeProviderAdapter.ts";

/**
 * Pick the server-internal fake flavor a public `RuntimePlan` maps to. The
 * public `fake` provider hides flavor; we choose by the plan's persistence
 * intent. A persistent (or snapshot-backed) plan lands on the pty-workspace
 * flavor, which backs every role, ports, persistence, and snapshots. A
 * non-persistent plan lands on the throwaway ephemeral flavor, which exposes no
 * ports and no snapshots — so a non-persistent plan that still asks for ports or
 * a snapshot is genuinely unsupported and the planner rejects it pre-provision.
 */
export const deriveFakeFlavor = (plan: RuntimePlan): FakeRuntimeFlavor =>
  plan.persistent === true || plan.snapshotId != null
    ? "fake-pty-workspace"
    : "fake-ephemeral-runtime";

export const makeFakeRuntimeProviderFacade = (
  fake: FakeRuntimeProviderAdapterShape,
): ExecutionRuntimeProviderAdapterShape => ({
  provision: ({ threadId, plan }) =>
    fake
      .provision({ threadId: String(threadId), flavor: deriveFakeFlavor(plan) })
      .pipe(Effect.map((context) => ({ instance: context.instance, rootPath: context.rootPath }))),
  createTransport: fake.createTransport,
  execCollect: fake.execCollect,
  isAlive: fake.isAlive,
  destroy: fake.destroy,
});
