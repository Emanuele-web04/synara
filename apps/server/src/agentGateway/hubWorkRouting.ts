import {
  HUB_TASK_KEY_MAX_LENGTH,
  HUB_TASK_KEY_PATTERN,
  hubWorkLogicalTaskKey,
  hubWorkPositionalTaskKey,
  type ProjectId,
} from "@synara/contracts";

import { stableGatewayDigest } from "./creationUtils";

export { hubWorkLogicalTaskKey, hubWorkPositionalTaskKey };

/**
 * Normalize a coordinator-proposed task key. The model may propose a key, but the
 * server owns it: normalization happens once, and the frozen value is what later
 * retries are matched against. Returning null means the proposal is unusable and
 * the caller must reject it rather than silently substitute another identity.
 */
export function normalizeHubTaskKey(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  if (
    normalized.length === 0 ||
    normalized.length > HUB_TASK_KEY_MAX_LENGTH ||
    !HUB_TASK_KEY_PATTERN.test(normalized)
  ) {
    return null;
  }
  return normalized;
}

/**
 * Identity of one task inside a Hub request: hub + frozen source scope + task key.
 * The key replaces the task's position so a retry that reorders or extends the
 * plan still addresses the same worker instead of forking a second one.
 */
export function hubWorkWorkItemId(input: {
  readonly projectId: ProjectId;
  readonly scopeKey: string;
  readonly taskKey: string;
}): string {
  return `hub-work:${stableGatewayDigest(
    { projectId: input.projectId, scopeKey: input.scopeKey, taskKey: input.taskKey },
    40,
  )}`;
}

/** Digest of the frozen per-task decision: its original messages and its plan. */
export function hubWorkTaskFingerprint(input: {
  readonly sourceMessages: readonly unknown[];
  readonly spec: unknown;
  readonly title: string | undefined;
}): string {
  return stableGatewayDigest(
    {
      sourceMessages: input.sourceMessages,
      spec: input.spec,
      title: input.title ?? null,
    },
    64,
  );
}

/**
 * Digest of a whole request's routing decision. It identifies which task keys a
 * request decided, independently of plan details, so replays across turns are
 * recognizable while an unrelated request reusing the id is not.
 */
export function hubWorkRequestFingerprint(input: {
  readonly sourceMessages: readonly unknown[];
  readonly taskKeys: readonly string[];
}): string {
  return stableGatewayDigest(
    { sourceMessages: input.sourceMessages, taskKeys: [...input.taskKeys].toSorted() },
    64,
  );
}
