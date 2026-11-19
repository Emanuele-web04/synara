// FILE: useBotDefaultEngine.ts
// Purpose: The engine a new bot starts on: the economy model (`economyModelSlug`) of the
//          provider the user's default model uses, once live discovery lists it; until then,
//          and for providers without one, that provider's default model.
// Layer: SynBot editor hook
// Exports: useBotDefaultEngine

import type { ModelSelection } from "@synara/contracts";
import { economyModelSlug } from "@synara/shared/bots";
import { useMemo } from "react";

import { useAppSettings } from "~/appSettings";
import { useNewChatDefault } from "~/hooks/useNewChatDefault";
import { useProviderModelCatalog } from "~/hooks/useProviderModelCatalog";
import { resolveDraftFallbackModelSelection } from "~/lib/draftFallbackModelSelection";
import { buildModelSelection } from "~/providerModelOptions";

export function useBotDefaultEngine(): ModelSelection {
  const { settings } = useAppSettings();
  const newChatDefault = useNewChatDefault(settings);
  const fallback = useMemo(
    () => resolveDraftFallbackModelSelection({ projectDefault: null, newChatDefault }),
    [newChatDefault],
  );
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
