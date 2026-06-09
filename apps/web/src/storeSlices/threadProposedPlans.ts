// FILE: storeSlices/threadProposedPlans.ts
// Purpose: Normalizes proposed-plan payloads and projects them into stable per-thread slices.
// Layer: Pure proposed-plan transition helpers consumed by store.ts's event projection.
// Exports: normalizeProposedPlans, sourceProposedPlansEqual, buildProposedPlanSlice.

import { type OrchestrationReadModel } from "@t3tools/contracts";
import { arraysShallowEqual } from "./equality";
import { type Thread } from "../types";

type ReadModelThread = OrchestrationReadModel["threads"][number];

export function sourceProposedPlansEqual(
  left: Thread["pendingSourceProposedPlan"],
  right: Thread["pendingSourceProposedPlan"],
): boolean {
  if (left === right) return true;
  if (left === undefined || right === undefined) return false;
  return left.threadId === right.threadId && left.planId === right.planId;
}

export function normalizeProposedPlans(
  incoming: ReadModelThread["proposedPlans"],
  previous: Thread["proposedPlans"] | undefined,
): Thread["proposedPlans"] {
  const previousById = new Map(previous?.map((plan) => [plan.id, plan] as const));
  const nextPlans = incoming.map((plan) => {
    const existing = previousById.get(plan.id);
    if (
      existing &&
      existing.turnId === plan.turnId &&
      existing.planMarkdown === plan.planMarkdown &&
      existing.implementedAt === plan.implementedAt &&
      existing.implementationThreadId === plan.implementationThreadId &&
      existing.createdAt === plan.createdAt &&
      existing.updatedAt === plan.updatedAt
    ) {
      return existing;
    }
    return {
      id: plan.id,
      turnId: plan.turnId,
      planMarkdown: plan.planMarkdown,
      implementedAt: plan.implementedAt,
      implementationThreadId: plan.implementationThreadId,
      createdAt: plan.createdAt,
      updatedAt: plan.updatedAt,
    };
  });
  return arraysShallowEqual(previous, nextPlans) ? previous : nextPlans;
}

export function buildProposedPlanSlice(thread: Thread): {
  ids: string[];
  byId: Record<string, Thread["proposedPlans"][number]>;
} {
  return {
    ids: thread.proposedPlans.map((plan) => plan.id),
    byId: Object.fromEntries(
      thread.proposedPlans.map((plan) => [plan.id, plan] as const),
    ) as Record<string, Thread["proposedPlans"][number]>,
  };
}
