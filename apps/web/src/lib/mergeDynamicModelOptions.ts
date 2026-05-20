import type { ProviderKind } from "@t3tools/contracts";
import { normalizeModelSlug } from "@t3tools/shared/model";

import { formatProviderModelOptionName, type ProviderModelOption } from "../providerModelOptions";

function normalizeDynamicModelSlug(provider: ProviderKind, slug: string): string {
  if (provider === "claudeAgent") {
    const withoutContextSuffix = slug.replace(/\[[^\]]+\]$/u, "");
    return normalizeModelSlug(withoutContextSuffix, provider) ?? withoutContextSuffix;
  }
  return normalizeModelSlug(slug, provider) ?? slug;
}

export function mergeDynamicModelOptions(input: {
  provider: ProviderKind;
  staticOptions: ReadonlyArray<ProviderModelOption & { isCustom?: boolean }>;
  dynamicModels: ReadonlyArray<{
    slug: string;
    name?: string | null;
    upstreamProviderId?: string | null;
    upstreamProviderName?: string | null;
  }>;
}): ReadonlyArray<ProviderModelOption & { isCustom?: boolean }> {
  const staticNameBySlug = new Map(input.staticOptions.map((model) => [model.slug, model.name]));
  const dynamicNormalizedSlugs = new Set<string>();
  const normalizedDynamicOptions: ProviderModelOption[] = [];

  for (const dynamicModel of input.dynamicModels) {
    const rawName = dynamicModel.name?.trim() ?? "";
    const isClaudeDefaultAlias =
      input.provider === "claudeAgent" &&
      (rawName.toLowerCase() === "default (recommended)" ||
        rawName.toLowerCase() === "default recommended" ||
        dynamicModel.slug.trim().toLowerCase() === "default");
    if (isClaudeDefaultAlias) {
      continue;
    }

    const normalizedSlug = normalizeDynamicModelSlug(input.provider, dynamicModel.slug);
    const rawSlug = dynamicModel.slug.trim().toLowerCase();
    const displayNameFallback = formatProviderModelOptionName({
      provider: input.provider,
      slug: normalizedSlug,
    });
    if (dynamicNormalizedSlugs.has(normalizedSlug)) {
      continue;
    }
    dynamicNormalizedSlugs.add(normalizedSlug);
    normalizedDynamicOptions.push({
      slug: normalizedSlug,
      name:
        staticNameBySlug.get(normalizedSlug) ??
        (rawName.length > 0 &&
        rawName.toLowerCase() !== rawSlug &&
        rawName.toLowerCase() !== normalizedSlug.toLowerCase()
          ? rawName
          : displayNameFallback),
      ...(dynamicModel.upstreamProviderId?.trim()
        ? { upstreamProviderId: dynamicModel.upstreamProviderId.trim() }
        : {}),
      ...(dynamicModel.upstreamProviderName?.trim()
        ? { upstreamProviderName: dynamicModel.upstreamProviderName.trim() }
        : {}),
    });
  }

  const customOnlyModels = input.staticOptions.filter(
    (model) => "isCustom" in model && model.isCustom && !dynamicNormalizedSlugs.has(model.slug),
  );
  const staticBuiltInModels = input.staticOptions.filter(
    (model) => !("isCustom" in model) || model.isCustom !== true,
  );
  const missingStaticBuiltIns =
    (input.provider === "kilo" || input.provider === "opencode" || input.provider === "cursor") &&
    normalizedDynamicOptions.length > 0
      ? []
      : staticBuiltInModels.filter((model) => !dynamicNormalizedSlugs.has(model.slug));

  const orderedDynamicOptions =
    input.provider === "claudeAgent"
      ? normalizedDynamicOptions.toReversed()
      : normalizedDynamicOptions;

  return [...orderedDynamicOptions, ...missingStaticBuiltIns, ...customOnlyModels];
}
