// FILE: continuousHandoffPath.ts
// Purpose: Derive and compress the same-conversation provider route from durable activities.
// Layer: Web handoff presentation utilities

import { type OrchestrationThreadActivity, ProviderKind } from "@synara/contracts";
import { Schema } from "effect";
import { PROVIDER_HANDOFF_ACTIVITY_KIND } from "../workLog";

export interface ContinuousHandoffPathStep {
  readonly key: string;
  readonly provider: ProviderKind;
  readonly transition: "start" | "forward" | "return" | "gap";
}

export type ContinuousHandoffPathToken =
  | { readonly kind: "provider"; readonly step: ContinuousHandoffPathStep }
  | { readonly kind: "overflow"; readonly hiddenCount: number };

const isProviderKind = Schema.is(ProviderKind);

export function deriveContinuousHandoffPath(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlyArray<ContinuousHandoffPathStep> {
  // Success rows only: failed/pending starts and ordinary model changes must
  // never advertise a completed transition. Sequence wins over wall-clock time.
  const handoffs = activities
    .filter((activity) => activity.kind === PROVIDER_HANDOFF_ACTIVITY_KIND)
    .toSorted((left, right) => {
      if (left.sequence !== undefined && right.sequence !== undefined) {
        return left.sequence - right.sequence || left.id.localeCompare(right.id);
      }
      if (left.sequence !== undefined) return 1;
      if (right.sequence !== undefined) return -1;
      return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
    });
  const steps: ContinuousHandoffPathStep[] = [];
  const visitedProviders = new Set<ProviderKind>();
  const seenEvents = new Set<string>();
  for (const activity of handoffs) {
    const payload = activity.payload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) continue;
    const { sourceProvider: source, targetProvider: target } = payload as Readonly<
      Record<string, unknown>
    >;
    if (!isProviderKind(source) || !isProviderKind(target) || seenEvents.has(activity.id)) continue;
    seenEvents.add(activity.id);

    if (steps.at(-1)?.provider !== source) {
      steps.push({
        key: `${activity.id}:source`,
        provider: source,
        // A partial history must not invent a transition between disjoint rows.
        transition: steps.length === 0 ? "start" : "gap",
      });
      visitedProviders.add(source);
    }
    steps.push({
      key: `${activity.id}:target`,
      provider: target,
      transition: visitedProviders.has(target) ? "return" : "forward",
    });
    visitedProviders.add(target);
  }
  return steps;
}

function providerToken(step: ContinuousHandoffPathStep): ContinuousHandoffPathToken {
  return { kind: "provider", step };
}

/** Keep the origin and most recent visits; return markers survive compression. */
export function compressContinuousHandoffPath(
  steps: ReadonlyArray<ContinuousHandoffPathStep>,
  maxVisibleProviders = 4,
): ReadonlyArray<ContinuousHandoffPathToken> {
  const limit = Number.isFinite(maxVisibleProviders)
    ? Math.max(2, Math.floor(maxVisibleProviders))
    : 4;
  if (steps.length <= limit) return steps.map(providerToken);
  return [
    providerToken(steps[0]!),
    { kind: "overflow", hiddenCount: steps.length - limit },
    ...steps.slice(-(limit - 1)).map(providerToken),
  ];
}
