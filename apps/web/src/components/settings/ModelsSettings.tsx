// FILE: ModelsSettings.tsx
// Purpose: Models settings panel (git text-generation default and custom model slugs per provider).
// Layer: Settings UI components
// Exports: ModelsSettings

import {
  DEFAULT_GIT_TEXT_GENERATION_MODEL,
  PROVIDER_DISPLAY_NAMES,
  type ProviderKind,
} from "@t3tools/contracts";
import { type Dispatch, type SetStateAction } from "react";
import {
  type AppSettings,
  getCustomModelsForProvider,
  getGitTextGenerationModelOptions,
  MODEL_PROVIDER_SETTINGS,
} from "../../appSettings";
import { PlusIcon, XIcon } from "../../lib/icons";
import { cn } from "../../lib/utils";
import {
  SETTINGS_CARD_ROW_DIVIDER_CLASS_NAME,
  SETTINGS_INSET_LIST_CLASS_NAME,
} from "../../settingsPanelStyles";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { SettingResetButton, SettingsSelectControl } from "./SettingControls";
import { SettingsRow, SettingsSection, SettingsSelectPopup } from "./SettingsPanelPrimitives";

export function ModelsSettings(props: {
  settings: AppSettings;
  defaults: AppSettings;
  updateSettings: (patch: Partial<AppSettings>) => void;
  selectedCustomModelProvider: ProviderKind;
  setSelectedCustomModelProvider: Dispatch<SetStateAction<ProviderKind>>;
  customModelInputByProvider: Record<ProviderKind, string>;
  setCustomModelInputByProvider: Dispatch<SetStateAction<Record<ProviderKind, string>>>;
  customModelErrorByProvider: Partial<Record<ProviderKind, string | null>>;
  setCustomModelErrorByProvider: Dispatch<
    SetStateAction<Partial<Record<ProviderKind, string | null>>>
  >;
  showAllCustomModels: boolean;
  setShowAllCustomModels: Dispatch<SetStateAction<boolean>>;
  onAddCustomModel: (provider: ProviderKind) => void;
  onRemoveCustomModel: (provider: ProviderKind, slug: string) => void;
}) {
  const {
    settings,
    defaults,
    updateSettings,
    selectedCustomModelProvider,
    setSelectedCustomModelProvider,
    customModelInputByProvider,
    setCustomModelInputByProvider,
    customModelErrorByProvider,
    setCustomModelErrorByProvider,
    showAllCustomModels,
    setShowAllCustomModels,
    onAddCustomModel,
    onRemoveCustomModel,
  } = props;

  const gitTextGenerationModelOptions = getGitTextGenerationModelOptions(settings);
  const currentGitTextGenerationProvider = settings.textGenerationProvider ?? "codex";
  const currentGitTextGenerationModel =
    settings.textGenerationModel ?? DEFAULT_GIT_TEXT_GENERATION_MODEL;
  const currentGitTextGenerationValue = `${currentGitTextGenerationProvider}:${currentGitTextGenerationModel}`;
  const defaultGitTextGenerationProvider = defaults.textGenerationProvider ?? "codex";
  const defaultGitTextGenerationModel =
    defaults.textGenerationModel ?? DEFAULT_GIT_TEXT_GENERATION_MODEL;
  const isGitTextGenerationModelDirty =
    currentGitTextGenerationProvider !== defaultGitTextGenerationProvider ||
    currentGitTextGenerationModel !== defaultGitTextGenerationModel;
  const selectedGitTextGenerationModelLabel =
    gitTextGenerationModelOptions.find(
      (option) =>
        option.provider === currentGitTextGenerationProvider &&
        option.slug === currentGitTextGenerationModel,
    )?.name ?? currentGitTextGenerationModel;
  const selectedCustomModelProviderSettings = MODEL_PROVIDER_SETTINGS.find(
    (providerSettings) => providerSettings.provider === selectedCustomModelProvider,
  )!;
  const selectedCustomModelInput = customModelInputByProvider[selectedCustomModelProvider];
  const selectedCustomModelError = customModelErrorByProvider[selectedCustomModelProvider] ?? null;
  const totalCustomModels =
    settings.customCodexModels.length +
    settings.customClaudeModels.length +
    settings.customCursorModels.length +
    settings.customGeminiModels.length +
    settings.customGrokModels.length +
    settings.customKiloModels.length +
    settings.customOpenCodeModels.length +
    settings.customPiModels.length;
  const savedCustomModelRows = MODEL_PROVIDER_SETTINGS.flatMap((providerSettings) =>
    getCustomModelsForProvider(settings, providerSettings.provider).map((slug) => ({
      key: `${providerSettings.provider}:${slug}`,
      provider: providerSettings.provider,
      providerTitle: providerSettings.title,
      slug,
    })),
  );
  const visibleCustomModelRows = showAllCustomModels
    ? savedCustomModelRows
    : savedCustomModelRows.slice(0, 5);

  return (
    <div className="space-y-6">
      <SettingsSection title="Generation defaults">
        <SettingsRow
          title="Git writing model"
          description="Used for generated commit messages, PR titles, and branch names."
          resetAction={
            isGitTextGenerationModelDirty ? (
              <SettingResetButton
                label="git writing model"
                onClick={() =>
                  updateSettings({
                    textGenerationProvider: defaults.textGenerationProvider,
                    textGenerationModel: defaults.textGenerationModel,
                  })
                }
              />
            ) : null
          }
          control={
            <SettingsSelectControl
              value={currentGitTextGenerationValue}
              onValueChange={(value) => {
                if (!value) return;
                const separatorIndex = value.indexOf(":");
                const provider = value.slice(0, separatorIndex) as ProviderKind;
                const model = value.slice(separatorIndex + 1);
                if (!provider || !model) return;
                updateSettings({
                  textGenerationProvider: provider,
                  textGenerationModel: model,
                });
              }}
              ariaLabel="Git text generation model"
              triggerClassName="w-full sm:w-52"
              valueContent={selectedGitTextGenerationModelLabel}
            >
              {gitTextGenerationModelOptions.map((option) => (
                <SelectItem
                  hideIndicator
                  key={`${option.provider}:${option.slug}`}
                  value={`${option.provider}:${option.slug}`}
                >
                  {PROVIDER_DISPLAY_NAMES[option.provider]} / {option.name}
                </SelectItem>
              ))}
            </SettingsSelectControl>
          }
        />
      </SettingsSection>

      <SettingsSection title="Custom models">
        <SettingsRow
          title="Saved model slugs"
          description="Add custom model slugs for supported providers."
          resetAction={
            totalCustomModels > 0 ? (
              <SettingResetButton
                label="custom models"
                onClick={() => {
                  updateSettings({
                    customCodexModels: defaults.customCodexModels,
                    customClaudeModels: defaults.customClaudeModels,
                    customCursorModels: defaults.customCursorModels,
                    customGeminiModels: defaults.customGeminiModels,
                    customGrokModels: defaults.customGrokModels,
                    customKiloModels: defaults.customKiloModels,
                    customOpenCodeModels: defaults.customOpenCodeModels,
                    customPiModels: defaults.customPiModels,
                  });
                  setCustomModelErrorByProvider({});
                  setShowAllCustomModels(false);
                }}
              />
            ) : null
          }
        >
          <div className={cn("mt-4 pt-4", SETTINGS_CARD_ROW_DIVIDER_CLASS_NAME)}>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <Select
                value={selectedCustomModelProvider}
                onValueChange={(value) => {
                  if (
                    value !== "codex" &&
                    value !== "claudeAgent" &&
                    value !== "cursor" &&
                    value !== "gemini" &&
                    value !== "grok" &&
                    value !== "kilo" &&
                    value !== "opencode" &&
                    value !== "pi"
                  ) {
                    return;
                  }
                  setSelectedCustomModelProvider(value);
                }}
              >
                <SelectTrigger size="sm" className="w-full sm:w-40" aria-label="Custom model provider">
                  <SelectValue>{selectedCustomModelProviderSettings.title}</SelectValue>
                </SelectTrigger>
                <SettingsSelectPopup align="start">
                  {MODEL_PROVIDER_SETTINGS.map((providerSettings) => (
                    <SelectItem
                      hideIndicator
                      key={providerSettings.provider}
                      value={providerSettings.provider}
                    >
                      {providerSettings.title}
                    </SelectItem>
                  ))}
                </SettingsSelectPopup>
              </Select>
              <Input
                id="custom-model-slug"
                value={selectedCustomModelInput}
                onChange={(event) => {
                  const value = event.target.value;
                  setCustomModelInputByProvider((existing) => ({
                    ...existing,
                    [selectedCustomModelProvider]: value,
                  }));
                  if (selectedCustomModelError) {
                    setCustomModelErrorByProvider((existing) => ({
                      ...existing,
                      [selectedCustomModelProvider]: null,
                    }));
                  }
                }}
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  event.preventDefault();
                  onAddCustomModel(selectedCustomModelProvider);
                }}
                placeholder={selectedCustomModelProviderSettings.example}
                spellCheck={false}
              />
              <Button
                className="shrink-0"
                variant="outline"
                onClick={() => onAddCustomModel(selectedCustomModelProvider)}
              >
                <PlusIcon className="size-3.5" />
                Add
              </Button>
            </div>

            {selectedCustomModelError ? (
              <p className="mt-2 text-xs text-destructive">{selectedCustomModelError}</p>
            ) : null}

            {totalCustomModels > 0 ? (
              <div className={cn("mt-3", SETTINGS_INSET_LIST_CLASS_NAME)}>
                {visibleCustomModelRows.map((row) => (
                  <div
                    key={row.key}
                    className="group grid grid-cols-[minmax(5rem,6rem)_minmax(0,1fr)_auto] items-center gap-3 border-t border-[color:var(--color-border)] px-4 py-2 first:border-t-0"
                  >
                    <span className="truncate text-xs text-muted-foreground">
                      {row.providerTitle}
                    </span>
                    <code className="min-w-0 truncate text-sm text-foreground">{row.slug}</code>
                    <button
                      type="button"
                      className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100 hover:opacity-100"
                      aria-label={`Remove ${row.slug}`}
                      onClick={() => onRemoveCustomModel(row.provider, row.slug)}
                    >
                      <XIcon className="size-3.5 text-muted-foreground hover:text-foreground" />
                    </button>
                  </div>
                ))}

                {savedCustomModelRows.length > 5 ? (
                  <button
                    type="button"
                    className="mt-2 text-xs text-muted-foreground transition-colors hover:text-foreground"
                    onClick={() => setShowAllCustomModels((value) => !value)}
                  >
                    {showAllCustomModels
                      ? "Show less"
                      : `Show more (${savedCustomModelRows.length - 5})`}
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        </SettingsRow>
      </SettingsSection>
    </div>
  );
}
