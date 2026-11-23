// FILE: FusionSettingsPanel.tsx
// Purpose: Settings → Fusion — saved lead+sidekick pairing presets (#1301 P5).
//   Presets persist in ServerSettings.fusionPresets and surface in the composer's
//   Fusion section ahead of an ad-hoc pick.
// Layer: Settings panel

import {
  PROVIDER_DISPLAY_NAMES,
  type FusionPairingPreset,
  type ModelSelection,
  type ProviderKind,
} from "@synara/contracts";
import { getModelOptions } from "@synara/shared/model";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { useAppSettings, getCustomModelsForProvider } from "~/appSettings";
import { fusionPresetSummary, SHIPPED_FUSION_PRESETS } from "~/lib/fusionPresets";
import { PlusIcon, TrashCanIcon } from "~/lib/icons";
import { composerModelDisplayName } from "~/components/chat/ComposerModelPicker.logic";
import { normalizeModelSelection } from "~/composerDraftModels";
import { ensureNativeApi } from "~/nativeApi";
import { serverQueryKeys, serverSettingsQueryOptions } from "~/lib/serverReactQuery";
import { toastManager } from "~/components/ui/toast";
import { randomUUID } from "~/lib/utils";
import {
  SETTINGS_CARD_ROW_CLASS_NAME,
  SETTINGS_CARD_ROW_DIVIDER_CLASS_NAME,
} from "~/settingsPanelStyles";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import {
  SettingsEmptyState,
  SettingsSection,
  SettingsSelectPopup,
} from "./SettingsPanelPrimitives";
import { useTranslation } from "~/i18n";

const PROVIDERS = Object.keys(PROVIDER_DISPLAY_NAMES) as ProviderKind[];

type BriefStyle = "default" | "prescriptive" | "goal-level";

function modelChoices(provider: ProviderKind, customModels: ReadonlyArray<string>): string[] {
  return [...getModelOptions(provider).map((option) => option.slug), ...customModels];
}

export function FusionSettingsPanel({ active }: { active: boolean }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const serverSettings = useQuery(serverSettingsQueryOptions());
  const { settings } = useAppSettings();
  const presets = serverSettings.data?.fusionPresets ?? [];

  const [name, setName] = useState("");
  const [leadProvider, setLeadProvider] = useState<ProviderKind>("claudeAgent");
  const [leadModel, setLeadModel] = useState("");
  const [sidekickProvider, setSidekickProvider] = useState<ProviderKind>("codex");
  const [sidekickModel, setSidekickModel] = useState("");
  const [briefStyle, setBriefStyle] = useState<BriefStyle>("default");
  const [sidekickMayPushBack, setSidekickMayPushBack] = useState(false);
  const [delegateExploration, setDelegateExploration] = useState(false);
  const [saving, setSaving] = useState(false);

  const updatePresets = async (next: FusionPairingPreset[]) => {
    setSaving(true);
    try {
      const saved = await ensureNativeApi().server.updateSettings({ fusionPresets: next });
      queryClient.setQueryData(serverQueryKeys.settings(), saved);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: t("settings:couldNotUpdateFusionPresets"),
        description: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setSaving(false);
    }
  };

  const trimmedName = name.trim();
  const canSave = trimmedName.length > 0 && leadModel.length > 0 && sidekickModel.length > 0;

  const savePreset = async () => {
    if (!canSave) return;
    const lead = normalizePresetSelection(leadProvider, leadModel);
    const sidekick = normalizePresetSelection(sidekickProvider, sidekickModel);
    if (!lead || !sidekick) return;
    const preset: FusionPairingPreset = {
      id: `preset:${randomUUID()}`,
      name: trimmedName,
      pairing: {
        lead,
        sidekick,
        ...(briefStyle !== "default" ? { briefStyle } : {}),
        ...(sidekickMayPushBack ? { sidekickMayPushBack: true } : {}),
        ...(delegateExploration ? { delegateExploration: true } : {}),
      },
    };
    await updatePresets([...presets, preset]);
    setName("");
    setLeadModel("");
    setSidekickModel("");
    setBriefStyle("default");
    setSidekickMayPushBack(false);
    setDelegateExploration(false);
  };

  if (!active) return null;

  const leadChoices = modelChoices(
    leadProvider,
    getCustomModelsForProvider(settings, leadProvider),
  );
  const sidekickChoices = modelChoices(
    sidekickProvider,
    getCustomModelsForProvider(settings, sidekickProvider),
  );

  return (
    <div className="space-y-6">
      <SettingsSection title="settings:fusion_savedPairings">
        {presets.length === 0 && SHIPPED_FUSION_PRESETS.length === 0 ? (
          <SettingsEmptyState>{t("settings:fusion_noPresets")}</SettingsEmptyState>
        ) : (
          <>
            {presets.length === 0 ? (
              <div className={SETTINGS_CARD_ROW_CLASS_NAME}>
                <p className="text-ui-sm text-muted-foreground">
                  {t("settings:fusion_noSavedPresets")}
                </p>
              </div>
            ) : (
              presets.map((preset) => (
                <div
                  key={preset.id}
                  className={`flex items-center gap-3 ${SETTINGS_CARD_ROW_CLASS_NAME}`}
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-ui font-medium text-foreground">{preset.name}</p>
                    <p className="truncate text-ui-sm text-muted-foreground">
                      {fusionPresetSummary(preset, composerModelDisplayName)}
                      {preset.pairing.briefStyle
                        ? ` · ${t(
                            preset.pairing.briefStyle === "prescriptive"
                              ? "settings:fusion_briefStyle_prescriptive"
                              : "settings:fusion_briefStyle_goal-level",
                          )}`
                        : ""}
                    </p>
                  </div>
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    disabled={saving}
                    aria-label={t("settings:fusion_deletePreset")}
                    onClick={() =>
                      void updatePresets(presets.filter((entry) => entry.id !== preset.id))
                    }
                  >
                    <TrashCanIcon className="size-3.5" />
                  </Button>
                </div>
              ))
            )}
            <div
              className={`${SETTINGS_CARD_ROW_CLASS_NAME} ${SETTINGS_CARD_ROW_DIVIDER_CLASS_NAME}`}
            >
              <p className="text-ui-sm text-muted-foreground">
                {t("settings:fusion_builtInDescription")}
              </p>
            </div>
            {SHIPPED_FUSION_PRESETS.map((preset) => (
              <div
                key={preset.id}
                className={`flex items-center gap-3 ${SETTINGS_CARD_ROW_CLASS_NAME}`}
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-ui font-medium text-foreground">{preset.name}</p>
                  <p className="truncate text-ui-sm text-muted-foreground">
                    {fusionPresetSummary(preset, composerModelDisplayName)}
                  </p>
                </div>
                <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-ui-xs text-muted-foreground">
                  {t("settings:fusion_builtIn")}
                </span>
              </div>
            ))}
          </>
        )}
      </SettingsSection>

      <SettingsSection title="settings:fusion_addPairing">
        <div className={`flex flex-col gap-3 ${SETTINGS_CARD_ROW_CLASS_NAME}`}>
          <Input
            size="sm"
            variant="soft"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={t("settings:fusion_presetNamePlaceholder")}
            aria-label={t("settings:fusion_presetName")}
          />
          <PairingSelects
            provider={leadProvider}
            model={leadModel}
            choices={leadChoices}
            providerLabel={t("settings:fusion_lead")}
            modelLabel={t("settings:fusion_leadModel")}
            onProviderChange={(provider) => {
              setLeadProvider(provider);
              setLeadModel("");
            }}
            onModelChange={setLeadModel}
          />
          <PairingSelects
            provider={sidekickProvider}
            model={sidekickModel}
            choices={sidekickChoices}
            providerLabel={t("settings:fusion_sidekick")}
            modelLabel={t("settings:fusion_sidekickModel")}
            onProviderChange={(provider) => {
              setSidekickProvider(provider);
              setSidekickModel("");
            }}
            onModelChange={setSidekickModel}
          />
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <Select
              value={briefStyle}
              onValueChange={(value) => setBriefStyle(value as BriefStyle)}
            >
              <SelectTrigger
                size="sm"
                className="w-full sm:w-48"
                aria-label={t("settings:fusion_briefStyle")}
              >
                <SelectValue>{t(`settings:fusion_briefStyle_${briefStyle}`)}</SelectValue>
              </SelectTrigger>
              <SettingsSelectPopup align="start">
                <SelectItem hideIndicator value="default">
                  {t("settings:fusion_briefStyle_default")}
                </SelectItem>
                <SelectItem hideIndicator value="prescriptive">
                  {t("settings:fusion_briefStyle_prescriptive")}
                </SelectItem>
                <SelectItem hideIndicator value="goal-level">
                  {t("settings:fusion_briefStyle_goal-level")}
                </SelectItem>
              </SettingsSelectPopup>
            </Select>
            <KnobSwitch
              checked={sidekickMayPushBack}
              onCheckedChange={setSidekickMayPushBack}
              label={t("settings:fusion_mayPushBack")}
            />
            <KnobSwitch
              checked={delegateExploration}
              onCheckedChange={setDelegateExploration}
              label={t("settings:fusion_delegateExploration")}
            />
          </div>
          <div className="flex justify-end">
            <Button
              type="button"
              size="sm"
              disabled={!canSave || saving}
              onClick={() => void savePreset()}
            >
              <PlusIcon className="size-3.5" />
              {t("settings:fusion_savePreset")}
            </Button>
          </div>
        </div>
      </SettingsSection>
    </div>
  );
}

// Presets resolve against whatever accounts exist at apply time, so they store
// the provider's default instance id rather than a specific account.
function normalizePresetSelection(provider: ProviderKind, model: string): ModelSelection | null {
  return normalizeModelSelection({ provider, instanceId: provider, model });
}

function PairingSelects(props: {
  provider: ProviderKind;
  model: string;
  choices: ReadonlyArray<string>;
  providerLabel: string;
  modelLabel: string;
  onProviderChange: (provider: ProviderKind) => void;
  onModelChange: (model: string) => void;
}) {
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
      <Select
        value={props.provider}
        onValueChange={(value) => props.onProviderChange(value as ProviderKind)}
      >
        <SelectTrigger size="sm" className="w-full sm:w-40" aria-label={props.providerLabel}>
          <SelectValue>{PROVIDER_DISPLAY_NAMES[props.provider]}</SelectValue>
        </SelectTrigger>
        <SettingsSelectPopup align="start">
          {PROVIDERS.map((provider) => (
            <SelectItem hideIndicator key={provider} value={provider}>
              {PROVIDER_DISPLAY_NAMES[provider]}
            </SelectItem>
          ))}
        </SettingsSelectPopup>
      </Select>
      <Select
        value={props.model}
        onValueChange={(value) => {
          if (value !== null) props.onModelChange(value);
        }}
      >
        <SelectTrigger size="sm" className="w-full sm:w-52" aria-label={props.modelLabel}>
          <SelectValue>
            {props.model ? composerModelDisplayName(props.provider, props.model) : null}
          </SelectValue>
        </SelectTrigger>
        <SettingsSelectPopup align="start">
          {props.choices.map((model) => (
            <SelectItem hideIndicator key={model} value={model}>
              {composerModelDisplayName(props.provider, model)}
            </SelectItem>
          ))}
        </SettingsSelectPopup>
      </Select>
    </div>
  );
}

function KnobSwitch(props: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: string;
}) {
  return (
    <label className="flex items-center gap-2 text-ui-sm text-foreground">
      <Switch checked={props.checked} onCheckedChange={props.onCheckedChange} />
      {props.label}
    </label>
  );
}
