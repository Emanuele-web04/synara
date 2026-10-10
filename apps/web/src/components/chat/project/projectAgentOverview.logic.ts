// FILE: projectAgentOverview.logic.ts
// Purpose: Single derivation of `configured` from config presence plus overview
//          patching helpers for stream events.
// Layer: Client logic
// Depends on: contracts project agent types.
//
// The server derives `configured` from `config !== null` when building an overview
// (ProjectAgentService.buildOverview) — it is never stored independently. Any client
// that patches an overview from a stream event must re-derive the flag from the same
// source instead of carrying a stale boolean.

import type { ProjectAgentConfig, ProjectAgentOverview } from "@synara/contracts";

export function projectAgentOverviewConfigured(
  overview: Pick<ProjectAgentOverview, "config"> | null | undefined,
): boolean {
  return overview?.config !== null && overview?.config !== undefined;
}

export function projectAgentOverviewWithConfig(
  overview: ProjectAgentOverview,
  config: ProjectAgentConfig,
): ProjectAgentOverview {
  return { ...overview, config, configured: projectAgentOverviewConfigured({ config }) };
}
