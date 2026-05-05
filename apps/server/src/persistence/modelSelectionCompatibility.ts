// FILE: modelSelectionCompatibility.ts
// Purpose: Normalizes persisted model-selection JSON from older/newer app builds.
// Layer: Persistence compatibility helper
// Exports: normalizeLegacyModelSelection, normalizePersistedModelSelection

type ModelProviderKind = "codex" | "claudeAgent" | "cursor" | "gemini" | "opencode";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readTrimmedString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

// Imported instance ids may be runtime names rather than DP Code provider literals.
function inferProviderFromLabel(label: string): ModelProviderKind | undefined {
  const lowerLabel = label.toLowerCase();
  if (lowerLabel.includes("opencode")) {
    return "opencode";
  }
  if (lowerLabel.includes("cursor")) {
    return "cursor";
  }
  if (lowerLabel.includes("claude") || lowerLabel.includes("anthropic")) {
    return "claudeAgent";
  }
  if (lowerLabel.includes("gemini") || lowerLabel.includes("google")) {
    return "gemini";
  }
  if (lowerLabel.includes("codex")) {
    return "codex";
  }
  return undefined;
}

function inferLegacyModelProvider(provider: unknown, model: string): ModelProviderKind {
  if (
    provider === "codex" ||
    provider === "claudeAgent" ||
    provider === "cursor" ||
    provider === "gemini" ||
    provider === "opencode"
  ) {
    return provider;
  }
  if (typeof provider === "string") {
    const providerFromLabel = inferProviderFromLabel(provider);
    if (providerFromLabel !== undefined) {
      return providerFromLabel;
    }
  }
  const lowerModel = model.toLowerCase();
  if (lowerModel.includes("claude")) {
    return "claudeAgent";
  }
  if (lowerModel.includes("gemini")) {
    return "gemini";
  }
  return "codex";
}

function readLegacyProviderOptions(options: unknown, provider: ModelProviderKind): unknown {
  if (!isRecord(options)) {
    return options;
  }
  const providerScopedOptions = options[provider];
  return providerScopedOptions === undefined ? options : providerScopedOptions;
}

function normalizeModelOptions(input: unknown): unknown {
  if (!Array.isArray(input)) {
    return input;
  }

  const entries: Array<readonly [string, unknown]> = [];
  for (const option of input) {
    if (!isRecord(option)) {
      return input;
    }
    const id = readTrimmedString(option, "id");
    if (id === undefined) {
      return input;
    }
    entries.push([id, option.value]);
  }
  return Object.fromEntries(entries);
}

export function normalizeLegacyModelSelection(input: {
  readonly provider: unknown;
  readonly model: string;
  readonly options: unknown;
}): Record<string, unknown> {
  const provider = inferLegacyModelProvider(input.provider, input.model);
  const options = normalizeModelOptions(readLegacyProviderOptions(input.options, provider));
  return {
    provider,
    model: input.model,
    ...(options === undefined ? {} : { options }),
  };
}

export function normalizePersistedModelSelection(input: unknown): unknown {
  if (!isRecord(input)) {
    return input;
  }

  const model = readTrimmedString(input, "model");
  if (model === undefined) {
    return input;
  }

  // Newer T3 Code writes provider-less selections as { instanceId, model } and
  // option rows as [{ id, value }]; DP Code stores canonical provider/options objects.
  return normalizeLegacyModelSelection({
    provider: input.provider ?? input.instanceId,
    model,
    options: input.options,
  });
}
