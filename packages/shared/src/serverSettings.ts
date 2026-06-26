import {
  DEFAULT_MODEL_BY_PROVIDER,
  type ModelSelection,
  type ProviderKind,
  type ServerSettings,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
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

  const instances = deriveProviderInstances(next);
  const currentInstance = instances.find(
    (instance) => instance.instanceId === current.textGenerationModelSelection.instanceId,
  );
  const patchedInstanceId =
    selectionPatch.instanceId ??
    (selectionPatch.provider && selectionPatch.provider !== currentInstance?.driver
      ? selectionPatch.provider
      : current.textGenerationModelSelection.instanceId);
  const patchedInstance =
    patchedInstanceId !== undefined
      ? instances.find((instance) => instance.instanceId === patchedInstanceId)
      : undefined;
  const provider =
    patchedInstance?.driver ?? selectionPatch.provider ?? currentInstance?.driver ?? "codex";
  const instanceId = patchedInstance?.instanceId ?? patchedInstanceId ?? provider;
  const providerChanged = provider !== (currentInstance?.driver ?? "codex");
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
      instanceId,
      model,
      ...(options !== undefined ? { options: options as ModelSelection["options"] } : {}),
    } as ModelSelection,
  };
}
