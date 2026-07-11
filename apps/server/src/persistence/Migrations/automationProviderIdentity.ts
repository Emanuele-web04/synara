import {
  codexAccountInstanceId,
  unresolvedAutomationInstanceId,
} from "@synara/shared/providerInstances";

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

function identityFieldState(
  options: Record<string, unknown>,
  key: string,
): "absent" | "empty-environment" | "present" | "invalid" {
  if (!Object.hasOwn(options, key)) {
    return "absent";
  }
  const value = options[key];
  if (key === "environment") {
    if (!isRecord(value)) {
      return "invalid";
    }
    return Object.keys(value).length === 0 ? "empty-environment" : "present";
  }
  return nonEmptyString(value) === null ? "invalid" : "present";
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
    if (Object.hasOwn(selectedOptions, "accountId")) {
      const accountId = nonEmptyString(selectedOptions.accountId);
      const hasMalformedCompanionIdentity = IDENTITY_KEYS.codex.some(
        (key) => identityFieldState(selectedOptions, key) === "invalid",
      );
      if (accountId === null || hasMalformedCompanionIdentity) {
        return { safe: false };
      }
      return {
        safe: true,
        modelSelection: canonicalSelection(
          modelSelectionValue,
          accountId === "default" ? "codex" : codexAccountInstanceId(accountId),
        ),
      };
    }
  }

  // An explicitly empty environment is the only identity-bearing field with
  // a legitimate empty value. Empty/mistyped scalar fields are malformed,
  // not evidence that the default account was intended.
  const carriesAmbiguousIdentity = IDENTITY_KEYS[provider].some((key) => {
    const state = identityFieldState(selectedOptions, key);
    return state === "present" || state === "invalid";
  });
  return carriesAmbiguousIdentity
    ? { safe: false }
    : {
        safe: true,
        modelSelection: canonicalSelection(modelSelectionValue, provider),
      };
}

const UNRESOLVED_MODEL = "legacy-automation-unresolved";
const ISO_DATE_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

function providerForUnresolvedIdentity(
  modelSelectionValue: unknown,
  providerOptionsValue?: unknown,
  providerHintValue?: unknown,
): Provider {
  if (isProvider(providerHintValue)) {
    return providerHintValue;
  }
  if (isRecord(modelSelectionValue)) {
    if (isProvider(modelSelectionValue.instanceId)) {
      return modelSelectionValue.instanceId;
    }
    if (isProvider(modelSelectionValue.provider)) {
      return modelSelectionValue.provider;
    }
  }
  if (isRecord(providerOptionsValue)) {
    const configuredProviders = PROVIDERS.filter((provider) =>
      Object.hasOwn(providerOptionsValue, provider),
    );
    if (configuredProviders.length === 1) {
      return configuredProviders[0]!;
    }
  }
  return "codex";
}

export function makeUnresolvedAutomationModelSelection(
  modelSelectionValue: unknown,
  providerOptionsValue?: unknown,
  providerHintValue?: unknown,
): { readonly provider: Provider; readonly modelSelection: Record<string, unknown> } {
  const provider = providerForUnresolvedIdentity(
    modelSelectionValue,
    providerOptionsValue,
    providerHintValue,
  );
  const model = isRecord(modelSelectionValue)
    ? (nonEmptyString(modelSelectionValue.model) ?? UNRESOLVED_MODEL)
    : UNRESOLVED_MODEL;
  return {
    provider,
    modelSelection: {
      instanceId: unresolvedAutomationInstanceId(provider),
      model,
    },
  };
}

export function makeUnresolvedAutomationPermissionSnapshot(
  snapshotValue: unknown,
  createdAtFallback: string,
): Record<string, unknown> {
  const snapshot = isRecord(snapshotValue) ? snapshotValue : {};
  const unresolved = makeUnresolvedAutomationModelSelection(
    snapshot.modelSelection,
    snapshot.providerOptions,
    snapshot.provider,
  );
  const createdAt =
    typeof snapshot.createdAt === "string" && ISO_DATE_TIME_PATTERN.test(snapshot.createdAt)
      ? snapshot.createdAt
      : ISO_DATE_TIME_PATTERN.test(createdAtFallback)
        ? createdAtFallback
        : "1970-01-01T00:00:00.000Z";
  const allowedCapabilities = Array.isArray(snapshot.allowedCapabilities)
    ? snapshot.allowedCapabilities.filter(
        (capability): capability is string =>
          capability === "send-turn" ||
          capability === "create-worktree" ||
          capability === "full-access",
      )
    : [];
  return {
    provider: unresolved.provider,
    modelSelection: unresolved.modelSelection,
    ...(Number.isInteger(snapshot.completionPolicyVersion) &&
    Number(snapshot.completionPolicyVersion) >= 0
      ? { completionPolicyVersion: snapshot.completionPolicyVersion }
      : {}),
    runtimeMode: snapshot.runtimeMode === "full-access" ? "full-access" : "approval-required",
    interactionMode: snapshot.interactionMode === "plan" ? "plan" : "default",
    worktreeMode:
      snapshot.worktreeMode === "local" || snapshot.worktreeMode === "worktree"
        ? snapshot.worktreeMode
        : "auto",
    allowedCapabilities: Array.from(new Set(allowedCapabilities)),
    createdAt,
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
