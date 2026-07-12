// FILE: providerOrdering.ts
// Purpose: Keeps provider picker ordering stable across settings, search, and menus.
// Layer: Web settings utility
// Exports: default order, normalization, and order comparison helpers.

import type { ProviderKind } from "@synara/contracts";

export const DEFAULT_PROVIDER_ORDER: readonly ProviderKind[] = [
  "codex",
  "claudeAgent",
  "cursor",
  "gemini",
  "grok",
  "kilo",
  "opencode",
  "pi",
];

const PROVIDER_KIND_SET: ReadonlySet<ProviderKind> = new Set(DEFAULT_PROVIDER_ORDER);

export function isProviderKind(value: string): value is ProviderKind {
  return PROVIDER_KIND_SET.has(value as ProviderKind);
}

export function normalizeHiddenProviders(hiddenProviders: ReadonlyArray<string>): ProviderKind[] {
  const seen = new Set<ProviderKind>();
  const result: ProviderKind[] = [];
  for (const candidate of hiddenProviders) {
    if (isProviderKind(candidate) && !seen.has(candidate)) {
      seen.add(candidate);
      result.push(candidate);
    }
  }
  return result;
}

export function normalizeProviderOrder(providerOrder: ReadonlyArray<string>): ProviderKind[] {
  const seen = new Set<ProviderKind>();
  const result: ProviderKind[] = [];
  for (const candidate of providerOrder) {
    if (isProviderKind(candidate) && !seen.has(candidate)) {
      seen.add(candidate);
      result.push(candidate);
    }
  }
  for (const provider of DEFAULT_PROVIDER_ORDER) {
    if (!seen.has(provider)) {
      result.push(provider);
    }
  }
  return result;
}

export function sameProviderOrder(
  left: ReadonlyArray<ProviderKind>,
  right: ReadonlyArray<ProviderKind>,
): boolean {
  return left.length === right.length && left.every((provider, index) => provider === right[index]);
}

export function compareProvidersByOrder(
  providerOrder: ReadonlyArray<ProviderKind>,
  left: ProviderKind,
  right: ProviderKind,
): number {
  const leftIndex = providerOrder.indexOf(left);
  const rightIndex = providerOrder.indexOf(right);
  const normalizedLeftIndex =
    leftIndex >= 0 ? leftIndex : DEFAULT_PROVIDER_ORDER.indexOf(left) + providerOrder.length;
  const normalizedRightIndex =
    rightIndex >= 0 ? rightIndex : DEFAULT_PROVIDER_ORDER.indexOf(right) + providerOrder.length;
  return normalizedLeftIndex - normalizedRightIndex;
}
