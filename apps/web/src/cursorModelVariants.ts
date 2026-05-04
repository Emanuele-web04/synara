import type { ProviderModelDescriptor } from "@t3tools/contracts";

function uniqueByValue<T extends { readonly value: string }>(values: ReadonlyArray<T>): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const value of values) {
    if (seen.has(value.value)) {
      continue;
    }
    seen.add(value.value);
    result.push(value);
  }
  return result;
}

function cursorReasoningLabel(value: string): string {
  switch (value) {
    case "xhigh":
      return "Extra High";
    case "max":
      return "Max";
    default:
      return value.charAt(0).toUpperCase() + value.slice(1);
  }
}

function parseCursorCliReasoningEffort(model: string): string | undefined {
  const tokens = model.trim().toLowerCase().split("-");
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    const token = tokens[index];
    if (!token) {
      continue;
    }
    if (token === "xhigh") {
      return "xhigh";
    }
    if (token === "high" && tokens[index - 1] === "extra") {
      return "xhigh";
    }
    if (token === "max" || token === "none" || token === "low" || token === "medium" || token === "high") {
      return token;
    }
  }
  return undefined;
}

function stripCursorParameterizedSuffix(value: string): string {
  return value.trim().replace(/\[[^\]]*\]$/u, "");
}

export function normalizeCursorModelVariantBaseId(model: string | null | undefined): string | null {
  const trimmed = model?.trim();
  if (!trimmed) {
    return null;
  }
  let base = stripCursorParameterizedSuffix(trimmed)
    .replace(/-fast$/u, "")
    .replace(/-(?:extra-high|none|low|medium|high|xhigh)$/u, "")
    .replace(/-thinking$/u, "")
    .replace(/-fast$/u, "")
    .replace(/-(?:extra-high|none|low|medium|high|xhigh)$/u, "");

  if (base.endsWith("-max") && !base.includes("codex-max")) {
    base = base.slice(0, -"-max".length);
  }
  base = base.replace(/^claude-(\d+(?:\.\d+)?)-([a-z]+)-max$/u, "claude-$1-$2").replace(/-preview$/u, "");

  const claudeReordered = base.match(/^claude-(\d+(?:\.\d+)?)-([a-z]+)$/u);
  if (claudeReordered) {
    const version = claudeReordered[1];
    const family = claudeReordered[2];
    if (version && family) {
      return `claude-${family}-${version.replace(".", "-")}`;
    }
  }
  return base;
}

function removeVariantNameSuffix(name: string): string {
  return name
    .replace(/\s+Fast$/iu, "")
    .replace(/\s+Thinking$/iu, "")
    .replace(/\s+Fast$/iu, "")
    .replace(/\s+(?:None|Low|Medium|High|Extra High)$/iu, "")
    .replace(/\s+1M$/u, "")
    .trim();
}

function defaultEffortForGroup(baseSlug: string, efforts: ReadonlyArray<string>): string | undefined {
  if (efforts.length === 0) {
    return undefined;
  }
  if (baseSlug.includes("gpt") || baseSlug.includes("codex")) {
    return efforts.includes("medium") ? "medium" : efforts[0];
  }
  if (baseSlug.includes("claude")) {
    return efforts.includes("high") ? "high" : efforts[0];
  }
  return efforts[0];
}

function isCursorOneMillionVariant(model: ProviderModelDescriptor): boolean {
  if (model.defaultContextWindow === "1m") {
    return true;
  }
  if (model.contextWindowOptions?.some((option) => option.value === "1m" && option.isDefault === true)) {
    return true;
  }
  return /\b1M\b/u.test(model.name ?? "");
}

export function collapseCursorModelVariants(
  models: ReadonlyArray<ProviderModelDescriptor>,
): ProviderModelDescriptor[] {
  const groups = new Map<string, ProviderModelDescriptor[]>();
  for (const model of models) {
    const baseSlug = normalizeCursorModelVariantBaseId(model.slug) ?? model.slug;
    const group = groups.get(baseSlug);
    if (group) {
      group.push(model);
    } else {
      groups.set(baseSlug, [model]);
    }
  }

  return Array.from(groups.entries()).map(([baseSlug, variants]) => {
    const preferredName =
      variants.find((variant) => variant.slug === baseSlug)?.name ??
      variants.find((variant) => !variant.slug.endsWith("-fast"))?.name ??
      variants[0]?.name ??
      baseSlug;
    const efforts = uniqueByValue(
      variants.flatMap((variant) => [
        ...(variant.supportedReasoningEfforts ?? []),
        ...(parseCursorCliReasoningEffort(variant.slug)
          ? [
              {
                value: parseCursorCliReasoningEffort(variant.slug)!,
                label: cursorReasoningLabel(parseCursorCliReasoningEffort(variant.slug)!),
              },
            ]
          : []),
      ]),
    );
    const defaultEffort =
      variants.find((variant) => normalizeCursorModelVariantBaseId(variant.slug) === variant.slug)
        ?.defaultReasoningEffort ?? defaultEffortForGroup(baseSlug, efforts.map((effort) => effort.value));
    const hasOneMillionContext = variants.some(isCursorOneMillionVariant);
    const contextWindowOptions = uniqueByValue([
      ...variants.flatMap((variant) => variant.contextWindowOptions ?? []),
      ...(hasOneMillionContext ? [{ value: "1m", label: "1M", isDefault: true as const }] : []),
    ]);

    return {
      slug: baseSlug,
      name: removeVariantNameSuffix(preferredName),
      ...(variants[0]?.upstreamProviderId ? { upstreamProviderId: variants[0].upstreamProviderId } : {}),
      ...(variants[0]?.upstreamProviderName ? { upstreamProviderName: variants[0].upstreamProviderName } : {}),
      ...(efforts.length > 0
        ? {
            supportedReasoningEfforts: efforts.map((effort) => ({
              value: effort.value,
              label: effort.label,
              ...(effort.value === defaultEffort ? { isDefault: true as const } : {}),
            })),
            ...(defaultEffort ? { defaultReasoningEffort: defaultEffort } : {}),
          }
        : {}),
      ...(variants.some((variant) => variant.supportsFastMode === true)
        ? { supportsFastMode: true as const }
        : {}),
      ...(variants.some((variant) => variant.supportsThinkingToggle === true)
        ? { supportsThinkingToggle: true as const }
        : {}),
      ...(contextWindowOptions.length > 0
        ? {
            contextWindowOptions,
            defaultContextWindow:
              contextWindowOptions.find((option) => option.isDefault === true)?.value ??
              contextWindowOptions[0]?.value,
          }
        : {}),
    };
  });
}
