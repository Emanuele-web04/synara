// FILE: projectDevServers.ts
// Purpose: Shared identity helpers for workspace-scoped project dev servers.
// Layer: Shared runtime utility (consumed by server and web process registries).

import type { ProjectDevServerTarget } from "@synara/contracts";

export type ProjectDevServerTargetKey = string & {
  readonly ProjectDevServerTargetKey: unique symbol;
};

/**
 * Collision-safe registry identity for a project/workspace runtime target.
 *
 * Entity ids accept arbitrary non-empty strings, so delimiter concatenation is
 * ambiguous. A JSON tuple preserves the two fields without imposing new id
 * restrictions and remains deterministic in both Node and browser runtimes.
 */
export function projectDevServerTargetKey(
  target: ProjectDevServerTarget,
): ProjectDevServerTargetKey {
  return JSON.stringify([target.projectId, target.workspaceId]) as ProjectDevServerTargetKey;
}
