// FILE: useBotDefaultEngine.ts
// Purpose: The engine a new bot starts on: the economy model (`economyModelSlug`) of the
//          provider the user's default model uses, once live discovery lists it; until then,
//          and for providers without one, that provider's default model. When this Synara
//          cannot run that provider, the first available one takes its place.
// Layer: SynBot editor hook
// Exports: useBotDefaultEngine

import type { ModelSelection, ProviderKind } from "@synara/contracts";
import { economyModelSlug } from "@synara/shared/bots";
import { getDefaultModel } from "@synara/shared/model";
import { useMemo } from "react";

import { useAppSettings } from "~/appSettings";
import { useNewChatDefault } from "~/hooks/useNewChatDefault";
import { useProviderModelCatalog } from "~/hooks/useProviderModelCatalog";
import { useProviderStatusesForLocalConfig } from "~/hooks/useProviderStatusesForLocalConfig";
import { resolveDraftFallbackModelSelection } from "~/lib/draftFallbackModelSelection";
import { buildModelSelection } from "~/providerModelOptions";

import { newBotEngineProvider } from "./newBot.logic";

export function useBotDefaultEngine(): ModelSelection {
  const { settings } = useAppSettings();
  const newChatDefault = useNewChatDefault(settings);
  const statuses = useProviderStatusesForLocalConfig();
  const fallback = useMemo(() => {
    const preferred = resolveDraftFallbackModelSelection({ projectDefault: null, newChatDefault });
    const provider = newBotEngineProvider({
      preferred: preferred.provider,
      statuses,
      hiddenProviders: settings.hiddenProviders,
      providerOrder: settings.providerOrder as ProviderKind[],
      hasDefaultModel: (candidate) => getDefaultModel(candidate) != null,
    });
    const model = provider === preferred.provider ? null : getDefaultModel(provider);
    return model ? buildModelSelection(provider, model) : preferred;
  }, [newChatDefault, settings.hiddenProviders, settings.providerOrder, statuses]);
  const prefetchProviders = useMemo(() => [fallback.provider], [fallback.provider]);
  const modelHintByProvider = useMemo(
    () => ({ [fallback.provider]: fallback.model }),
    [fallback.provider, fallback.model],
  );
  const { modelOptionsByProvider } = useProviderModelCatalog({
    selectedProvider: fallback.provider,
    discoveryEnabled: false,
    prefetchProviders,
    modelHintByProvider,
  });
  const options = modelOptionsByProvider[fallback.provider];
  return useMemo(() => {
    const slug = economyModelSlug(
      fallback.provider,
      (options ?? []).map((option) => option.slug),
    );
    return slug ? buildModelSelection(fallback.provider, slug) : fallback;
  }, [fallback, options]);
}
