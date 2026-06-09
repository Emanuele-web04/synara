// FILE: storeSlices/threadActivities.ts
// Purpose: Pure normalization, dedupe, capping, and slice-building for thread activity timelines.
// Layer: Pure activity helpers consumed by store.ts's Zustand projection actions and event handlers.
// Exports: normalizeActivities, dedupeActivitiesById, preferRicherActivity, activityPayloadDetailScore,
//   activitiesEqual, capThreadActivities, pendingInteractionRequestIds, activityRequestId,
//   normalizeActivityCommandValue, buildActivitySlice, and the THREAD_SUMMARY_ACTIVITY_KINDS,
//   PENDING_INTERACTION_REQUEST_KINDS, MAX_THREAD_ACTIVITIES constants.

import { isStalePendingRequestFailureDetail } from "../lib/pendingInteraction";
import { arraysShallowEqual, deepEqualJson } from "../store";
import { type Thread } from "../types";

export const MAX_THREAD_ACTIVITIES = 500;
export const THREAD_SUMMARY_ACTIVITY_KINDS = new Set([
  "approval.requested",
  "approval.resolved",
  "provider.approval.respond.failed",
  "user-input.requested",
  "user-input.resolved",
  "provider.user-input.respond.failed",
]);
export const PENDING_INTERACTION_REQUEST_KINDS = new Set([
  "approval.requested",
  "user-input.requested",
]);

export function buildActivitySlice(thread: Thread): {
  ids: string[];
  byId: Record<string, Thread["activities"][number]>;
} {
  const activities = capThreadActivities(dedupeActivitiesById(thread.activities));
  return {
    ids: activities.map((activity) => activity.id),
    byId: Object.fromEntries(
      activities.map((activity) => [activity.id, activity] as const),
    ) as Record<string, Thread["activities"][number]>,
  };
}

export function normalizeActivities(
  incoming: ReadonlyArray<Thread["activities"][number]>,
  previous: Thread["activities"] | undefined,
): Thread["activities"] {
  const previousActivities = previous ? dedupeActivitiesById(previous) : undefined;
  const incomingActivities = dedupeActivitiesById(incoming);
  const previousById = new Map(
    previousActivities?.map((activity) => [activity.id, activity] as const),
  );
  const nextActivities = incomingActivities.map((activity) => {
    const existing = previousById.get(activity.id);
    if (existing) {
      const preferred = preferRicherActivity(existing, activity);
      if (preferred === existing || activitiesEqual(existing, preferred)) {
        return existing;
      }
      return preferred;
    }
    return activity;
  });
  const cappedActivities = capThreadActivities(nextActivities);
  return arraysShallowEqual(previous, cappedActivities) ? previous : cappedActivities;
}

export function capThreadActivities<TActivity extends Thread["activities"][number]>(
  activities: readonly TActivity[],
): TActivity[] {
  if (activities.length <= MAX_THREAD_ACTIVITIES) {
    return activities as TActivity[];
  }
  const retainedIds = new Set(
    activities.slice(-MAX_THREAD_ACTIVITIES).map((activity) => activity.id),
  );
  const pendingRequestIds = pendingInteractionRequestIds(activities);
  for (const activity of activities) {
    const requestId = activityRequestId(activity);
    if (
      requestId !== null &&
      pendingRequestIds.has(requestId) &&
      PENDING_INTERACTION_REQUEST_KINDS.has(activity.kind)
    ) {
      retainedIds.add(activity.id);
    }
  }
  return activities.filter((activity) => retainedIds.has(activity.id));
}

export function activityRequestId(activity: Thread["activities"][number]): string | null {
  const payload = asActivityRecord(activity.payload);
  const requestId = payload?.requestId;
  return typeof requestId === "string" && requestId.trim().length > 0 ? requestId : null;
}

// Keep old actionable prompts even when their timeline rows fall outside the cap.
export function pendingInteractionRequestIds(
  activities: readonly Thread["activities"][number][],
): Set<string> {
  const pendingRequestIds = new Set<string>();
  for (const activity of activities) {
    const requestId = activityRequestId(activity);
    if (requestId === null) {
      continue;
    }
    if (activity.kind === "approval.requested" || activity.kind === "user-input.requested") {
      pendingRequestIds.add(requestId);
      continue;
    }
    if (activity.kind === "approval.resolved" || activity.kind === "user-input.resolved") {
      pendingRequestIds.delete(requestId);
      continue;
    }
    if (
      (activity.kind === "provider.approval.respond.failed" ||
        activity.kind === "provider.user-input.respond.failed") &&
      isStalePendingRequestFailureDetail(asActivityRecord(activity.payload)?.detail)
    ) {
      pendingRequestIds.delete(requestId);
    }
  }
  return pendingRequestIds;
}

export function dedupeActivitiesById<TActivity extends Thread["activities"][number]>(
  activities: ReadonlyArray<TActivity>,
): TActivity[] {
  const indexById = new Map<string, number>();
  const result: TActivity[] = [];
  for (const activity of activities) {
    const existingIndex = indexById.get(activity.id);
    if (existingIndex === undefined) {
      indexById.set(activity.id, result.length);
      result.push(activity);
      continue;
    }
    result[existingIndex] = preferRicherActivity(result[existingIndex]!, activity);
  }
  return arraysShallowEqual(activities, result) ? (activities as TActivity[]) : result;
}

// Duplicate activity ids can arrive from snapshot + live event races. Keep the
// payload with the most tool detail so normalized state cannot regress to a generic row.
export function preferRicherActivity<TActivity extends Thread["activities"][number]>(
  previous: TActivity,
  incoming: TActivity,
): TActivity {
  if (activitiesEqual(previous, incoming)) {
    return previous;
  }
  const previousScore = activityPayloadDetailScore(previous);
  const incomingScore = activityPayloadDetailScore(incoming);
  return incomingScore < previousScore ? previous : incoming;
}

export function activitiesEqual(
  left: Thread["activities"][number],
  right: Thread["activities"][number],
): boolean {
  return (
    left.kind === right.kind &&
    left.tone === right.tone &&
    left.summary === right.summary &&
    deepEqualJson(left.payload, right.payload) &&
    left.turnId === right.turnId &&
    left.sequence === right.sequence &&
    left.createdAt === right.createdAt
  );
}

export function activityPayloadDetailScore(activity: Thread["activities"][number]): number {
  const payload = asActivityRecord(activity.payload);
  const data = asActivityRecord(payload?.data);
  const item = asActivityRecord(data?.item);
  const commandActions = item?.commandActions ?? data?.commandActions ?? payload?.commandActions;
  let score = 0;
  if (payload?.itemType) score += 4;
  if (payload?.title) score += 1;
  if (payload?.detail) score += 2;
  if (data) score += 2;
  if (item) score += 4;
  if (normalizeActivityCommandValue(item?.command ?? data?.command ?? payload?.command)) score += 8;
  if (Array.isArray(commandActions) && commandActions.length > 0) score += 8;
  return score;
}

function asActivityRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

export function normalizeActivityCommandValue(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (!Array.isArray(value)) {
    return null;
  }
  const parts = value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry) => entry.length > 0);
  return parts.length > 0 ? parts.join(" ") : null;
}
