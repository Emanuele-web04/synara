import { formatModelDisplayName } from "@t3tools/shared/model";
import type {
  ClaudeModelOptions,
  ClaudeModelSelection,
  CodexModelOptions,
  CodexModelSelection,
  GeminiModelOptions,
  GeminiModelSelection,
  ModelSelection,
  OpenCodeModelOptions,
  OpenCodeModelSelection,
  ProviderKind,
  ProviderModelOptions,
} from "@t3tools/contracts";

export type ProviderOptions = ProviderModelOptions[ProviderKind];

export interface ProviderModelOption {
  slug: string;
  name: string;
  upstreamProviderId?: string;
  upstreamProviderName?: string;
}

export interface ProviderModelOptionGroup {
  key: string;
  label: string | null;
  options: ProviderModelOption[];
}

function humanizeModelIdentifier(value: string): string {
  return value.replace(/[-_/]+/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function modelOptionKey(option: Pick<ProviderModelOption, "slug">): string {
  return option.slug.trim().toLowerCase();
}

export function formatProviderModelOptionName(input: {
  provider: ProviderKind;
  slug: string;
}): string {
  const trimmedSlug = input.slug.trim();
  if (trimmedSlug.length === 0) {
    return trimmedSlug;
  }

  if (input.provider === "opencode") {
    const modelIdentifier = trimmedSlug.includes("/")
      ? trimmedSlug.slice(trimmedSlug.lastIndexOf("/") + 1)
      : trimmedSlug;
    const sharedDisplayName = formatModelDisplayName(modelIdentifier);
    return sharedDisplayName && sharedDisplayName !== modelIdentifier
      ? sharedDisplayName
      : humanizeModelIdentifier(modelIdentifier);
  }

  return formatModelDisplayName(trimmedSlug) ?? trimmedSlug;
}

export function mergeProviderModelOptions(
  preferred: ReadonlyArray<ProviderModelOption>,
  fallback: ReadonlyArray<ProviderModelOption>,
): ProviderModelOption[] {
  const merged = [...preferred];
  const seen = new Set(preferred.map((option) => modelOptionKey(option)));

  for (const option of fallback) {
    const key = modelOptionKey(option);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(option);
  }

  return merged;
}

export function groupProviderModelOptions(
  options: ReadonlyArray<ProviderModelOption>,
): ProviderModelOptionGroup[] {
  const groupedOptions: ProviderModelOptionGroup[] = [];
  const groupIndexByKey = new Map<string, number>();

  for (const option of options) {
    const upstreamProviderId = option.upstreamProviderId?.trim();
    const upstreamProviderName = option.upstreamProviderName?.trim();
    const groupLabel =
      upstreamProviderName && upstreamProviderName.length > 0
        ? upstreamProviderName
        : upstreamProviderId && upstreamProviderId.length > 0
          ? upstreamProviderId
          : null;
    const groupKey = groupLabel
      ? `${(upstreamProviderId ?? groupLabel).trim().toLowerCase()}`
      : "__ungrouped__";
    const existingIndex = groupIndexByKey.get(groupKey);

    if (existingIndex !== undefined) {
      groupedOptions[existingIndex]!.options.push(option);
      continue;
    }

    groupIndexByKey.set(groupKey, groupedOptions.length);
    groupedOptions.push({
      key: groupKey,
      label: groupLabel,
      options: [option],
    });
  }

  return groupedOptions;
}

export function groupProviderModelOptionsWithFavorites(input: {
  options: ReadonlyArray<ProviderModelOption>;
  favoriteSlugs: ReadonlySet<string>;
  favoriteLabel?: string;
}): ProviderModelOptionGroup[] {
  if (input.favoriteSlugs.size === 0) {
    return groupProviderModelOptions(input.options);
  }

  const favoriteOptions = input.options.filter((option) => input.favoriteSlugs.has(option.slug));
  if (favoriteOptions.length === 0) {
    return groupProviderModelOptions(input.options);
  }
  const groupedOptions = groupProviderModelOptions(
    input.options.filter((option) => !input.favoriteSlugs.has(option.slug)),
  );

  return [
    {
      key: "__favorites__",
      label: input.favoriteLabel ?? "Favourites",
      options: favoriteOptions,
    },
    ...groupedOptions,
  ];
}

export function buildNextProviderOptions(
  provider: ProviderKind,
  modelOptions: ProviderOptions | null | undefined,
  patch: Record<string, unknown>,
): ProviderOptions {
  if (provider === "codex") {
    return { ...(modelOptions as CodexModelOptions | undefined), ...patch } as CodexModelOptions;
  }
  if (provider === "claudeAgent") {
    return { ...(modelOptions as ClaudeModelOptions | undefined), ...patch } as ClaudeModelOptions;
  }
  if (provider === "gemini") {
    return {
      ...(modelOptions as GeminiModelOptions | undefined),
      thinkingLevel: undefined,
      thinkingBudget: undefined,
      ...patch,
    } as GeminiModelOptions;
  }
  return {
    ...(modelOptions as OpenCodeModelOptions | undefined),
    ...patch,
  } as OpenCodeModelOptions;
}

export function buildModelSelection(
  provider: "codex",
  model: string,
  options?: CodexModelOptions | null | undefined,
): CodexModelSelection;
export function buildModelSelection(
  provider: "claudeAgent",
  model: string,
  options?: ClaudeModelOptions | null | undefined,
): ClaudeModelSelection;
export function buildModelSelection(
  provider: "gemini",
  model: string,
  options?: GeminiModelOptions | null | undefined,
): GeminiModelSelection;
export function buildModelSelection(
  provider: "opencode",
  model: string,
  options?: OpenCodeModelOptions | null | undefined,
): OpenCodeModelSelection;
export function buildModelSelection(
  provider: ProviderKind,
  model: string,
  options?: ProviderOptions | null | undefined,
): ModelSelection;
export function buildModelSelection(
  provider: ProviderKind,
  model: string,
  options?: ProviderOptions | null | undefined,
): ModelSelection {
  switch (provider) {
    case "codex":
      return options
        ? {
            provider,
            model,
            options: options as CodexModelOptions,
          }
        : { provider, model };
    case "claudeAgent":
      return options
        ? {
            provider,
            model,
            options: options as ClaudeModelOptions,
          }
        : { provider, model };
    case "gemini":
      return options
        ? {
            provider,
            model,
            options: options as GeminiModelOptions,
          }
        : { provider, model };
    case "opencode":
      return options
        ? {
            provider,
            model,
            options: options as OpenCodeModelOptions,
          }
        : { provider, model };
  }
}
