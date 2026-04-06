// FILE: providerDiscovery.ts
// Purpose: Shares provider-discovery helpers across chat and browser surfaces.
// Layer: Web lib
// Exports: cwd resolution, search normalization, and provider skill/plugin display helpers.

import type { ProviderPluginDescriptor, ProviderSkillDescriptor } from "@t3tools/contracts";

// Prefer the most specific workspace context so discovery reflects the active thread first.
export function resolveProviderDiscoveryCwd(options: {
  activeThreadWorktreePath: string | null;
  activeProjectCwd: string | null;
  serverCwd: string | null;
}): string | null {
  return options.activeThreadWorktreePath ?? options.activeProjectCwd ?? options.serverCwd;
}

export function normalizeProviderDiscoveryText(value: string | undefined): string {
  if (!value) return "";
  return value
    .toLowerCase()
    .replace(/[:/_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function buildSkillSearchBlob(
  skill: Pick<ProviderSkillDescriptor, "name" | "description" | "interface">,
): string {
  return normalizeProviderDiscoveryText(
    [skill.name, skill.interface?.displayName, skill.interface?.shortDescription, skill.description]
      .filter((value) => typeof value === "string" && value.trim().length > 0)
      .join("\n"),
  );
}

export function buildPluginSearchBlob(
  plugin: Pick<ProviderPluginDescriptor, "name" | "interface">,
): string {
  return normalizeProviderDiscoveryText(
    [
      plugin.name,
      plugin.interface?.displayName,
      plugin.interface?.shortDescription,
      plugin.interface?.category,
      plugin.interface?.developerName,
    ]
      .filter((value) => typeof value === "string" && value.trim().length > 0)
      .join("\n"),
  );
}

export function formatSkillScope(scope: string | undefined): string {
  if (!scope) return "Personal";
  const normalized = scope.trim();
  if (normalized.length === 0) return "Personal";
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}
