import {
  DEFAULT_CODEX_ACCOUNT_ID,
  DEFAULT_MODEL_BY_PROVIDER,
  type ModelSelection,
  type ProviderStartOptions,
  type ProviderKind,
  type ServerSettings,
  type ServerSettingsPatch,
} from "@synara/contracts";
import { deepMerge, type DeepPartial } from "./Struct";
import { deriveProviderInstances } from "./providerInstances";

function defaultModelForProvider(provider: ProviderKind): string {
  return provider === "pi" ? "openai/gpt-5.5" : DEFAULT_MODEL_BY_PROVIDER[provider];
}

function shouldReplaceTextGenerationModelSelection(
  patch: ServerSettingsPatch["textGenerationModelSelection"] | undefined,
): boolean {
  return Boolean(
    patch &&
    (patch.provider !== undefined || patch.instanceId !== undefined || patch.model !== undefined),
  );
}

export function applyServerSettingsPatch(
  current: ServerSettings,
  patch: ServerSettingsPatch,
): ServerSettings {
  const selectionPatch = patch.textGenerationModelSelection;
  const merged = deepMerge(current, patch as DeepPartial<ServerSettings>);
  const next: ServerSettings =
    patch.providerInstances !== undefined
      ? { ...merged, providerInstances: patch.providerInstances }
      : merged;
  if (!selectionPatch) {
    return next;
  }

  const patchedInstanceId =
    selectionPatch.instanceId ??
    (selectionPatch.provider &&
    selectionPatch.provider !== current.textGenerationModelSelection.provider
      ? selectionPatch.provider
      : current.textGenerationModelSelection.instanceId);
  const patchedInstance =
    patchedInstanceId !== undefined
      ? deriveProviderInstances(next).find((instance) => instance.instanceId === patchedInstanceId)
      : undefined;
  const provider =
    patchedInstance?.driver ??
    selectionPatch.provider ??
    current.textGenerationModelSelection.provider;
  const instanceId = patchedInstance?.instanceId ?? patchedInstanceId;
  const providerChanged = provider !== current.textGenerationModelSelection.provider;
  const model =
    selectionPatch.model ??
    (providerChanged
      ? defaultModelForProvider(provider)
      : current.textGenerationModelSelection.model);
  const options = shouldReplaceTextGenerationModelSelection(selectionPatch)
    ? selectionPatch.options
    : (selectionPatch.options ?? current.textGenerationModelSelection.options);

  return {
    ...next,
    textGenerationModelSelection: {
      provider,
      ...(instanceId !== undefined ? { instanceId } : {}),
      model,
      ...(options !== undefined ? { options } : {}),
    } as ModelSelection,
  };
}

/** Server-owned launch options derived from the persisted non-secret settings snapshot. */
export function providerStartOptionsFromServerSettings(
  settings: ServerSettings,
): ProviderStartOptions {
  const { providers } = settings;
  const selectedCodexAccount =
    providers.codex.selectedAccountId === DEFAULT_CODEX_ACCOUNT_ID
      ? undefined
      : providers.codex.accounts.find(
          (account) => account.id === providers.codex.selectedAccountId,
        );
  const codexHomePath = selectedCodexAccount?.homePath || providers.codex.homePath;
  return {
    codex: {
      ...(providers.codex.binaryPath ? { binaryPath: providers.codex.binaryPath } : {}),
      ...(codexHomePath ? { homePath: codexHomePath } : {}),
      ...(selectedCodexAccount?.shadowHomePath
        ? { shadowHomePath: selectedCodexAccount.shadowHomePath }
        : {}),
      ...(selectedCodexAccount ? { accountId: selectedCodexAccount.id } : {}),
    },
    claudeAgent: {
      ...(providers.claudeAgent.binaryPath ? { binaryPath: providers.claudeAgent.binaryPath } : {}),
      ...(providers.claudeAgent.homePath ? { homePath: providers.claudeAgent.homePath } : {}),
    },
    cursor: {
      ...(providers.cursor.binaryPath ? { binaryPath: providers.cursor.binaryPath } : {}),
      ...(providers.cursor.apiEndpoint ? { apiEndpoint: providers.cursor.apiEndpoint } : {}),
    },
    antigravity: {
      ...(providers.antigravity.binaryPath ? { binaryPath: providers.antigravity.binaryPath } : {}),
    },
    grok: {
      ...(providers.grok.binaryPath ? { binaryPath: providers.grok.binaryPath } : {}),
    },
    droid: {
      ...(providers.droid.binaryPath ? { binaryPath: providers.droid.binaryPath } : {}),
    },
    opencode: {
      ...(providers.opencode.binaryPath ? { binaryPath: providers.opencode.binaryPath } : {}),
      ...(providers.opencode.serverUrl ? { serverUrl: providers.opencode.serverUrl } : {}),
      experimentalWebSockets: providers.opencode.experimentalWebSockets,
    },
    pi: {
      ...(providers.pi.binaryPath ? { binaryPath: providers.pi.binaryPath } : {}),
      ...(providers.pi.agentDir ? { agentDir: providers.pi.agentDir } : {}),
    },
    devin: {
      ...(providers.devin.binaryPath ? { binaryPath: providers.devin.binaryPath } : {}),
    },
  };
}
