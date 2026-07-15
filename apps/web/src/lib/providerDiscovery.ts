// FILE: providerDiscovery.ts
// Purpose: Shares provider-discovery helpers across chat and browser surfaces.
// Layer: Web lib
// Exports: cwd resolution, search normalization, and provider skill/plugin display helpers.

import { resolveThreadBranchSourceCwd } from "@synara/shared/threadEnvironment";
import type {
  ProviderNativeCommandDescriptor,
  ProviderPluginDescriptor,
  ProviderSkillDescriptor,
} from "@synara/contracts";

// Prefer the most specific workspace context so discovery reflects the active thread first.
export function resolveProviderDiscoveryCwd(options: {
  activeThreadWorktreePath: string | null;
  activeProjectCwd: string | null;
  serverCwd: string | null;
}): string | null {
  return (
    resolveThreadBranchSourceCwd({
      projectCwd: options.activeProjectCwd,
      worktreePath: options.activeThreadWorktreePath,
    }) ?? options.serverCwd
  );
}

export function normalizeProviderDiscoveryText(value: string | undefined): string {
  if (!value) return "";
  return value
    .toLowerCase()
    .replace(/[:/_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export interface ProviderDiscoverySearchField {
  value: string | null | undefined;
  weight?: number;
}

interface RankedProviderDiscoveryItem<T> {
  item: T;
  score: number;
  index: number;
}

const PROVIDER_DISCOVERY_SECONDARY_FIELD_WEIGHT = 200;
const PROVIDER_DISCOVERY_TERTIARY_FIELD_WEIGHT = 400;

// Lower scores mean stronger intent: title/name hits beat descriptions, and
// fuzzy matching is reserved for primary fields to avoid noisy long-copy wins.
function compactNormalizedText(value: string): string {
  return value.replace(/\s+/g, "");
}

function scoreSubsequenceMatch(value: string, query: string): number | null {
  if (!query) return 0;

  let queryIndex = 0;
  let firstMatchIndex = -1;
  let previousMatchIndex = -1;
  let gapPenalty = 0;

  for (let valueIndex = 0; valueIndex < value.length; valueIndex += 1) {
    if (value[valueIndex] !== query[queryIndex]) {
      continue;
    }

    if (firstMatchIndex === -1) {
      firstMatchIndex = valueIndex;
    }
    if (previousMatchIndex !== -1) {
      gapPenalty += valueIndex - previousMatchIndex - 1;
    }

    previousMatchIndex = valueIndex;
    queryIndex += 1;
    if (queryIndex === query.length) {
      // The matched span beyond the query length always equals gapPenalty, so
      // fold the former span weighting into a single gap coefficient.
      const lengthPenalty = Math.min(64, value.length - query.length);
      return firstMatchIndex * 2 + gapPenalty * 4 + lengthPenalty;
    }
  }

  return null;
}

function scoreTokenCoverage(value: string, query: string): number | null {
  const tokens = query.split(" ").filter((token) => token.length > 0);
  if (tokens.length <= 1) {
    return null;
  }

  let offset = 0;
  let totalDistance = 0;
  for (const token of tokens) {
    const index = value.indexOf(token, offset);
    if (index === -1) {
      return null;
    }
    totalDistance += index - offset;
    offset = index + token.length;
  }
  return totalDistance;
}

function scoreNormalizedDiscoveryText(
  value: string,
  query: string,
  options?: { allowFuzzy?: boolean },
): number | null {
  if (!query) {
    return 0;
  }
  if (!value) {
    return null;
  }

  const compactValue = compactNormalizedText(value);
  const compactQuery = compactNormalizedText(query);

  if (value === query || compactValue === compactQuery) return 0;
  if (value.startsWith(query) || compactValue.startsWith(compactQuery)) return 10;

  const words = value.split(" ").filter((word) => word.length > 0);
  const wordPrefixIndex = words.findIndex((word) => word.startsWith(query));
  if (wordPrefixIndex !== -1) return 20 + wordPrefixIndex;

  const boundaryIndex = value.indexOf(` ${query}`);
  if (boundaryIndex !== -1) return 30 + boundaryIndex;

  const phraseIndex = value.indexOf(query);
  if (phraseIndex !== -1) return 40 + phraseIndex;

  const tokenCoverageScore = scoreTokenCoverage(value, query);
  if (tokenCoverageScore !== null) return 80 + tokenCoverageScore;

  if (!options?.allowFuzzy) {
    return null;
  }

  const subsequenceScore = scoreSubsequenceMatch(compactValue, compactQuery);
  if (subsequenceScore !== null) return 120 + subsequenceScore;

  return null;
}

function scoreProviderDiscoverySearchFieldsForNormalizedQuery(
  normalizedQuery: string,
  fields: readonly ProviderDiscoverySearchField[],
): number | null {
  if (!normalizedQuery) {
    return 0;
  }

  let bestScore: number | null = null;
  for (const field of fields) {
    const fieldWeight = field.weight ?? 0;
    const normalizedValue = normalizeProviderDiscoveryText(field.value ?? undefined);
    const fieldScore = scoreNormalizedDiscoveryText(normalizedValue, normalizedQuery, {
      allowFuzzy: fieldWeight === 0,
    });
    if (fieldScore === null) {
      continue;
    }
    const weightedScore = fieldWeight + fieldScore;
    if (bestScore === null || weightedScore < bestScore) {
      bestScore = weightedScore;
    }
  }
  return bestScore;
}

export function rankProviderDiscoveryItems<T>(
  items: readonly T[],
  query: string,
  fieldsForItem: (item: T) => readonly ProviderDiscoverySearchField[],
): T[] {
  const normalizedQuery = normalizeProviderDiscoveryText(query);
  if (!normalizedQuery) {
    return [...items];
  }

  return items
    .map((item, index): RankedProviderDiscoveryItem<T> | null => {
      const score = scoreProviderDiscoverySearchFieldsForNormalizedQuery(
        normalizedQuery,
        fieldsForItem(item),
      );
      return score === null ? null : { item, score, index };
    })
    .filter((entry): entry is RankedProviderDiscoveryItem<T> => entry !== null)
    .toSorted((left, right) => left.score - right.score || left.index - right.index)
    .map((entry) => entry.item);
}

export function buildSkillSearchFields(
  skill: Pick<ProviderSkillDescriptor, "name" | "description" | "interface"> &
    Partial<Pick<ProviderSkillDescriptor, "path">>,
): ProviderDiscoverySearchField[] {
  return [
    { value: skill.name },
    { value: skill.interface?.displayName },
    {
      value: skill.interface?.shortDescription,
      weight: PROVIDER_DISCOVERY_SECONDARY_FIELD_WEIGHT,
    },
    { value: skill.description, weight: PROVIDER_DISCOVERY_SECONDARY_FIELD_WEIGHT },
    { value: skill.path, weight: PROVIDER_DISCOVERY_TERTIARY_FIELD_WEIGHT },
  ];
}

export function isInstalledProviderPlugin(
  plugin: Pick<ProviderPluginDescriptor, "installed" | "enabled" | "installPolicy">,
): boolean {
  return plugin.installed || plugin.enabled || plugin.installPolicy === "INSTALLED_BY_DEFAULT";
}

export function buildPluginSearchFields(
  plugin: Pick<ProviderPluginDescriptor, "name" | "interface">,
): ProviderDiscoverySearchField[] {
  return [
    { value: plugin.name },
    { value: plugin.interface?.displayName },
    {
      value: plugin.interface?.shortDescription,
      weight: PROVIDER_DISCOVERY_SECONDARY_FIELD_WEIGHT,
    },
    { value: plugin.interface?.category, weight: PROVIDER_DISCOVERY_SECONDARY_FIELD_WEIGHT },
    { value: plugin.interface?.developerName, weight: PROVIDER_DISCOVERY_SECONDARY_FIELD_WEIGHT },
  ];
}

export function buildCommandSearchFields(
  command: Pick<ProviderNativeCommandDescriptor, "name" | "description">,
): ProviderDiscoverySearchField[] {
  return [
    { value: command.name },
    { value: command.description, weight: PROVIDER_DISCOVERY_SECONDARY_FIELD_WEIGHT },
  ];
}

export function formatSkillScope(scope: string | undefined): string {
  if (!scope) return "Personal";
  const normalized = scope.trim();
  if (normalized.length === 0) return "Personal";
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}
