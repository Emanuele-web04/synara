// FILE: useEngineMenu.ts
// Purpose: The engine and the model as two sections of a HoloBot menu (HoloBot's
//          thread/engineMenu.ts, the iPhone's Engine and Model pickers): the providers this
//          Synara has available, then the chosen provider's models from Synara's model catalog,
//          a check on each choice. Picking one hands a new ModelSelection to `onChange` (the top
//          bar saves it with bots.update; the bot sheet keeps it in its form).
// Layer: SynBot hooks
// Exports: useEngineMenu, engineLabel

import type { ModelSelection, ProviderKind } from "@synara/contracts";
import { getDefaultModel } from "@synara/shared/model";
import { PROVIDER_DESCRIPTORS } from "@synara/shared/providerMetadata";
import { useMemo, useState } from "react";

import { useAppSettings } from "~/appSettings";
import { useProviderModelCatalog } from "~/hooks/useProviderModelCatalog";
import { useProviderStatusesForLocalConfig } from "~/hooks/useProviderStatusesForLocalConfig";
import { useTranslation } from "~/i18n";
import { buildModelSelection } from "~/providerModelOptions";
import { compareProvidersByOrder, isProviderKind } from "~/providerOrdering";

import type { MenuEntry } from "../kit/Menu";

const providerName = (provider: ProviderKind) =>
  PROVIDER_DESCRIPTORS.find((descriptor) => descriptor.kind === provider)?.displayName ?? provider;

/** "Codex · gpt-6-luna": the engine and its model, for a pill or a capsule. */
export function engineLabel(selection: ModelSelection, modelName?: string | null): string {
  return `${providerName(selection.provider)} · ${modelName ?? selection.model}`;
}

export function useEngineMenu({
  selection,
  onChange,
}: {
  readonly selection: ModelSelection;
  readonly onChange: (next: ModelSelection) => void;
}) {
  const { t } = useTranslation();
  const { settings } = useAppSettings();
  const statuses = useProviderStatusesForLocalConfig();
  // Discovery runs while the menu is open, as Synara's own model picker does.
  const [open, setOpen] = useState(false);
  const modelHintByProvider = useMemo(
    () => ({ [selection.provider]: selection.model }),
    [selection.model, selection.provider],
  );
  const catalog = useProviderModelCatalog({
    selectedProvider: selection.provider,
    discoveryEnabled: open,
    modelHintByProvider,
    prefetchProviders: [selection.provider],
  });
  const providers = useMemo(() => {
    const hidden = new Set<string>(settings.hiddenProviders);
    const seen = new Set<ProviderKind>();
    for (const status of statuses) {
      const provider = status.driver ?? status.provider;
      if (!isProviderKind(provider) || hidden.has(provider) || !status.available) continue;
      seen.add(provider);
    }
    seen.add(selection.provider);
    return [...seen].toSorted((left, right) =>
      compareProvidersByOrder(settings.providerOrder as ProviderKind[], left, right),
    );
  }, [selection.provider, settings.hiddenProviders, settings.providerOrder, statuses]);
  const models = catalog.modelOptionsByProvider[selection.provider] ?? [];
  const current = models.find((model) => model.slug === selection.model);

  const items: MenuEntry[] = [
    { section: t("synbot:engineSection") },
    ...providers.map((provider) => ({
      id: `engine:${provider}`,
      label: providerName(provider),
      checked: provider === selection.provider,
      onSelect: () => {
        if (provider === selection.provider) return;
        const model =
          getDefaultModel(provider) ?? catalog.modelOptionsByProvider[provider]?.[0]?.slug;
        if (!model) return;
        onChange(buildModelSelection(provider, model));
      },
    })),
    { section: t("synbot:modelSection") },
    ...models.map((model) => ({
      id: `model:${model.slug}`,
      label: model.name,
      checked: model.slug === selection.model,
      onSelect: () => {
        if (model.slug === selection.model) return;
        onChange(
          buildModelSelection(selection.provider, model.slug, undefined, {
            instanceId: selection.instanceId ?? null,
          }),
        );
      },
    })),
    ...(current || models.length > 0
      ? []
      : [
          {
            id: `model:${selection.model}`,
            label: selection.model,
            checked: true,
            onSelect: () => undefined,
          },
        ]),
  ];
  return {
    items,
    setOpen,
    label: engineLabel(selection, current?.name ?? null),
    modelName: current?.name ?? selection.model,
  };
}
