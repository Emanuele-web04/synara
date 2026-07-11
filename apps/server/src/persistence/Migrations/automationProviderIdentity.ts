import { codexAccountInstanceId } from "@synara/shared/providerInstances";

const PROVIDERS = [
  "codex",
  "claudeAgent",
  "cursor",
  "gemini",
  "grok",
  "kilo",
  "opencode",
  "pi",
] as const;

type Provider = (typeof PROVIDERS)[number];

const PROVIDER_SET = new Set<string>(PROVIDERS);

const IDENTITY_KEYS = {
  codex: ["homePath", "shadowHomePath", "environment"],
  claudeAgent: ["homePath", "environment"],
  cursor: ["apiEndpoint", "environment"],
  gemini: ["environment"],
  grok: ["environment"],
  kilo: ["serverUrl", "serverPassword", "environment"],
  opencode: ["serverUrl", "serverPassword", "environment"],
  pi: ["agentDir", "environment"],
} as const satisfies Record<Provider, readonly string[]>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isProvider(value: unknown): value is Provider {
  return typeof value === "string" && PROVIDER_SET.has(value);
}

function hasIdentityValue(value: unknown): boolean {
  if (value === null || value === undefined) {
    return false;
  }
  if (typeof value === "string") {
    return value.trim().length > 0;
  }
  if (isRecord(value)) {
    return Object.keys(value).length > 0;
  }
  return true;
}

function canonicalSelection(
  selection: Record<string, unknown>,
  instanceId: string,
): Record<string, unknown> {
  const { provider: _legacyProvider, ...canonical } = selection;
  void _legacyProvider;
  return { ...canonical, instanceId };
}

export type AutomationProviderIdentityResolution =
  | { readonly safe: true; readonly modelSelection: Record<string, unknown> }
  | { readonly safe: false };

/**
 * Resolves the account identity carried by a pre-instance automation snapshot.
 *
 * Migrations cannot read settings.json, so arbitrary home/env/server overrides
 * are intentionally not guessed. Legacy Codex account ids are the one exception:
 * their provider-instance ids are derived deterministically by shared runtime code.
 */
export function resolveAutomationProviderIdentity(
  modelSelectionValue: unknown,
  providerOptionsValue: unknown,
  providerHintValue?: unknown,
): AutomationProviderIdentityResolution {
  if (!isRecord(modelSelectionValue) || nonEmptyString(modelSelectionValue.model) === null) {
    return { safe: false };
  }

  const rawInstanceId = modelSelectionValue.instanceId;
  const instanceId = nonEmptyString(rawInstanceId);
  if (
    rawInstanceId !== null &&
    rawInstanceId !== undefined &&
    rawInstanceId !== "" &&
    instanceId === null
  ) {
    return { safe: false };
  }
  if (instanceId !== null && !isProvider(instanceId)) {
    return {
      safe: true,
      modelSelection: canonicalSelection(modelSelectionValue, instanceId),
    };
  }

  const provider = isProvider(instanceId)
    ? instanceId
    : isProvider(modelSelectionValue.provider)
      ? modelSelectionValue.provider
      : null;
  if (provider === null) {
    return { safe: false };
  }
  if (
    (modelSelectionValue.provider !== undefined &&
      (!isProvider(modelSelectionValue.provider) || modelSelectionValue.provider !== provider)) ||
    (providerHintValue !== undefined &&
      (!isProvider(providerHintValue) || providerHintValue !== provider))
  ) {
    return { safe: false };
  }

  if (providerOptionsValue === null || providerOptionsValue === undefined) {
    return {
      safe: true,
      modelSelection: canonicalSelection(modelSelectionValue, provider),
    };
  }
  if (!isRecord(providerOptionsValue)) {
    return { safe: false };
  }

  const selectedOptions = providerOptionsValue[provider];
  if (selectedOptions === null || selectedOptions === undefined) {
    return {
      safe: true,
      modelSelection: canonicalSelection(modelSelectionValue, provider),
    };
  }
  if (!isRecord(selectedOptions)) {
    return { safe: false };
  }

  if (provider === "codex") {
    const accountId = nonEmptyString(selectedOptions.accountId);
    if (accountId !== null) {
      return {
        safe: true,
        modelSelection: canonicalSelection(
          modelSelectionValue,
          accountId === "default" ? "codex" : codexAccountInstanceId(accountId),
        ),
      };
    }
    if (hasIdentityValue(selectedOptions.accountId)) {
      return { safe: false };
    }
  }

  const carriesAmbiguousIdentity = IDENTITY_KEYS[provider].some((key) =>
    hasIdentityValue(selectedOptions[key]),
  );
  return carriesAmbiguousIdentity
    ? { safe: false }
    : {
        safe: true,
        modelSelection: canonicalSelection(modelSelectionValue, provider),
      };
}

export const INVALID_AUTOMATION_JSON = Symbol("InvalidAutomationJson");

export function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return INVALID_AUTOMATION_JSON;
  }
}
