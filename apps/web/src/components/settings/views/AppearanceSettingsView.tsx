// FILE: AppearanceSettingsView.tsx
// Purpose: Settings › Appearance: theme, app icon and title bar, chat effects, typography, density.
// Layer: Settings view
// Exports: AppearanceSettingsView

import { type DesktopAudioInputDevice } from "@synara/contracts";
import { useEffect, useMemo, useState } from "react";
import {
  type AppSettingsBinding,
  DEFAULT_CHAT_WIDTH,
  DEFAULT_UI_DENSITY,
  MAX_CHAT_FONT_SIZE_PX,
  MAX_TERMINAL_FONT_SIZE_PX,
  type MessageTrailAudioSource,
  MIN_CHAT_FONT_SIZE_PX,
  MIN_TERMINAL_FONT_SIZE_PX,
  normalizeChatFontSizePx,
  normalizeTerminalFontFamily,
  normalizeTerminalFontSizePx,
  TERMINAL_FONT_FAMILY_SUGGESTIONS,
  type UiDensity,
} from "~/appSettings";
import { ThemePackEditor } from "~/components/ThemePackEditor";
import { AppIconPicker } from "~/components/settings/AppIconPicker";
import { BooleanSettingRow } from "~/components/settings/BooleanSettingRow";
import {
  SettingResetButton,
  SettingsSegmentedControl,
  SettingsSelectControl,
} from "~/components/settings/SettingControls";
import {
  SettingsRow,
  SettingsSection,
  SettingsSectionShell,
} from "~/components/settings/SettingsPanelPrimitives";
import { ThemeModePicker } from "~/components/settings/ThemeModePicker";
import {
  Autocomplete,
  AutocompleteEmpty,
  AutocompleteInput,
  AutocompleteItem,
  AutocompleteList,
  AutocompletePopup,
} from "~/components/ui/autocomplete";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { SelectItem } from "~/components/ui/select";
import { Switch } from "~/components/ui/switch";
import { isElectron } from "~/env";
import { useCustomTitleBarPreference } from "~/hooks/useCustomTitleBarPreference";
import { useDefaultDesktopAppIcon } from "~/hooks/useDefaultDesktopAppIcon";
import { useTranslation } from "~/i18n";
import { isUiDensity } from "~/lib/appDensity";
import { isAudioLevelAvailable } from "~/lib/audioLevel";
import { type ChatWidthMode, isChatWidthMode } from "~/lib/chatWidth";
import { getNavigatorPlatform, isMacPlatform } from "~/lib/utils";
import { settingRowAnchorId } from "~/settingsNavigation";
import { useTheme } from "~/hooks/useTheme";

const UI_DENSITY_OPTIONS = [
  {
    value: "compact",
    label: "settings:densityOptions_compact",
    description: "settings:densityOptions_compactDescription",
  },
  {
    value: "comfortable",
    label: "settings:densityOptions_comfortable",
    description: "settings:densityOptions_comfortableDescription",
  },
  {
    value: "spacious",
    label: "settings:densityOptions_spacious",
    description: "settings:densityOptions_spaciousDescription",
  },
] as const satisfies ReadonlyArray<{
  value: UiDensity;
  label: string;
  description: string;
}>;

const CHAT_WIDTH_OPTIONS = [
  {
    value: "standard",
    label: "chat:standard",
    description: "settings:keepsTheChatColumnAtTheDefaultReadingWidth",
  },
  {
    value: "wide",
    label: "settings:wide",
    description: "settings:givesTablesAndWideContentMoreRoom72rem",
  },
  {
    value: "full",
    label: "settings:full",
    description: "settings:letsTheChatColumnUseTheFullWindowWidth",
  },
] as const satisfies ReadonlyArray<{
  value: ChatWidthMode;
  label: string;
  description: string;
}>;

const MESSAGE_TRAIL_AUDIO_SOURCE_OPTIONS = [
  { value: "off", label: "automation:traitsPicker_off" },
  { value: "system", label: "settings:macAudio" },
  { value: "microphone", label: "settings:microphone" },
  { value: "both", label: "settings:both" },
] as const satisfies ReadonlyArray<{ value: MessageTrailAudioSource; label: string }>;

// Select items need a non-empty value; "" in settings means the Mac's default input.

const MAC_DEFAULT_MICROPHONE_VALUE = "mac-default";

function microphoneLabel(device: DesktopAudioInputDevice): string {
  return device.bluetooth ? `${device.name} (Bluetooth)` : device.name;
}

function MessageTrailMicrophoneRow({
  value,
  defaultValue,
  onChange,
}: {
  value: string;
  defaultValue: string;
  onChange: (microphoneId: string) => void;
}) {
  const { t } = useTranslation();

  const [devices, setDevices] = useState<readonly DesktopAudioInputDevice[]>([]);

  // Listing only reads device names; plugging a device in or out refreshes it.
  useEffect(() => {
    const audioLevel = window.desktopBridge?.audioLevel;
    if (!audioLevel) return;
    let cancelled = false;
    const refresh = () => {
      void audioLevel
        .listMicrophones()
        .then((next) => {
          if (!cancelled) setDevices(next);
        })
        .catch(() => undefined);
    };
    refresh();
    navigator.mediaDevices?.addEventListener("devicechange", refresh);
    return () => {
      cancelled = true;
      navigator.mediaDevices?.removeEventListener("devicechange", refresh);
    };
  }, []);

  const macDefault = devices.find((device) => device.default);
  const selected = devices.find((device) => device.id === value);
  const macDefaultLabel = macDefault
    ? t("settings:macDefault2", { microphone: microphoneLabel(macDefault) })
    : t("settings:macDefault");
  const valueContent = !value
    ? macDefaultLabel
    : selected
      ? microphoneLabel(selected)
      : t("common:toast_notConnected");

  return (
    <SettingsRow
      id="setting-message-trail-microphone"
      title="settings:messageTrailMicrophone"
      description="settings:microphoneTheMessageTrailListensToPickABuilt"
      resetAction={
        value !== defaultValue ? (
          <SettingResetButton
            label={t("settings:messageTrailMicrophone2")}
            onClick={() => onChange(defaultValue)}
          />
        ) : null
      }
      control={
        <SettingsSelectControl
          value={value || MAC_DEFAULT_MICROPHONE_VALUE}
          onValueChange={(next) => onChange(next === MAC_DEFAULT_MICROPHONE_VALUE ? "" : next)}
          ariaLabel={t("settings:messageTrailMicrophone")}
          triggerClassName="w-full sm:w-64"
          valueContent={valueContent}
        >
          <SelectItem hideIndicator value={MAC_DEFAULT_MICROPHONE_VALUE}>
            {macDefaultLabel}
          </SelectItem>
          {devices.map((device) => (
            <SelectItem hideIndicator key={device.id} value={device.id}>
              {microphoneLabel(device)}
            </SelectItem>
          ))}
          {value && !selected ? (
            <SelectItem hideIndicator value={value}>
              {t("common:toast_notConnected")}
            </SelectItem>
          ) : null}
        </SettingsSelectControl>
      }
    />
  );
}

export function AppearanceSettingsView(binding: AppSettingsBinding) {
  const { settings, defaults, updateSettings } = binding;
  const { t } = useTranslation();
  const { resolvedTheme, theme, setTheme, systemUiFont, setSystemUiFont } = useTheme();
  const platform = getNavigatorPlatform();
  const shouldShowFontSmoothing = isMacPlatform(platform);
  const defaultDesktopAppIcon = useDefaultDesktopAppIcon();
  const customTitleBar = useCustomTitleBarPreference(binding);
  const visibleTerminalFontFamilySuggestions = useMemo(() => {
    const query = settings.terminalFontFamily.trim().toLowerCase();
    if (!query) return TERMINAL_FONT_FAMILY_SUGGESTIONS;
    return TERMINAL_FONT_FAMILY_SUGGESTIONS.filter((suggestion) =>
      suggestion.toLowerCase().includes(query),
    );
  }, [settings.terminalFontFamily]);
  return (
    <div className="space-y-6">
      <SettingsSectionShell
        title="onboarding:changed_theme"
        action={
          theme !== "system" ? (
            <SettingResetButton label={t("workspace:theme")} onClick={() => setTheme("system")} />
          ) : null
        }
      >
        {/* The mode picker is the one settings control that sits directly on the page
            instead of inside a card — the mockups are the whole UI, so boxing them in
            a card reads as chrome around chrome. The anchor keeps search deep-links
            (`?target=setting-theme`) working without the SettingsRow. */}
        <div id={settingRowAnchorId("Theme")} className="scroll-mt-24 pb-1.5">
          <ThemeModePicker
            value={theme}
            onValueChange={setTheme}
            ariaLabel={t("onboarding:themePreference")}
          />
        </div>

        <div className="space-y-3">
          {(resolvedTheme === "dark"
            ? (["dark", "light"] as const)
            : (["light", "dark"] as const)
          ).map((variant) => (
            <ThemePackEditor
              key={variant}
              variant={variant}
              isActive={resolvedTheme === variant}
              mode={theme}
            />
          ))}
        </div>
      </SettingsSectionShell>

      {isElectron ? (
        <SettingsSection title="computer:nav_app">
          <SettingsRow
            id="setting-app-icon"
            title="settings:appIcon"
            description="settings:chooseTheIconSynaraUsesInTheDockOr"
            resetAction={
              settings.desktopAppIcon !== defaultDesktopAppIcon ? (
                <SettingResetButton
                  label={t("settings:appIcon2")}
                  onClick={() => updateSettings({ desktopAppIcon: defaultDesktopAppIcon })}
                />
              ) : null
            }
            control={
              <AppIconPicker
                platform={platform}
                value={settings.desktopAppIcon}
                onValueChange={async (desktopAppIcon) => {
                  if (desktopAppIcon !== settings.desktopAppIcon) {
                    updateSettings({ desktopAppIcon });
                  }
                  await window.desktopBridge?.setAppIcon(desktopAppIcon);
                }}
              />
            }
          />
          {customTitleBar.supported ? (
            <SettingsRow
              id="setting-use-custom-title-bar"
              title="settings:useCustomTitleBar"
              description={
                customTitleBar.restartRequired
                  ? "settings:restartSynaraToApplySomeLinuxWindowManagersWork"
                  : "settings:replaceTheSystemTitleBarWithSynaraSFrameless"
              }
              status={customTitleBar.restartRequired ? t("settings:restartRequired") : undefined}
              resetAction={
                settings.useCustomTitleBar !== defaults.useCustomTitleBar ? (
                  <SettingResetButton
                    label={t("settings:customTitleBar2")}
                    onClick={() => {
                      void customTitleBar.apply(defaults.useCustomTitleBar);
                    }}
                  />
                ) : null
              }
              control={
                <div className="flex items-center gap-2">
                  {customTitleBar.restartRequired ? (
                    <Button
                      type="button"
                      size="xs"
                      variant="outline"
                      onClick={() => {
                        void window.desktopBridge?.customTitleBar?.relaunch();
                      }}
                    >
                      {t("common:restart")}
                    </Button>
                  ) : null}
                  <Switch
                    checked={settings.useCustomTitleBar}
                    onCheckedChange={(checked) => {
                      void customTitleBar.apply(Boolean(checked));
                    }}
                    aria-label={t("settings:useCustomTitleBar")}
                  />
                </div>
              }
            />
          ) : null}
        </SettingsSection>
      ) : null}

      <SettingsSection title="settings:appearance_effects">
        <BooleanSettingRow
          {...binding}
          id="setting-ascii-background"
          settingKey="showAsciiBackground"
          title="settings:asciiBackground"
          description="settings:asciiBackgroundDescription"
          resetLabel="settings:asciiBackground"
          ariaLabel="settings:asciiBackground"
        />

        {isAudioLevelAvailable() ? (
          <SettingsRow
            id="setting-message-trail-sound"
            title="settings:messageTrailSound"
            description="settings:makeTheMessageMarksOnTheLeftOfLong"
            resetAction={
              settings.messageTrailAudioSource !== defaults.messageTrailAudioSource ? (
                <SettingResetButton
                  label={t("settings:messageTrailSound2")}
                  onClick={() =>
                    updateSettings({ messageTrailAudioSource: defaults.messageTrailAudioSource })
                  }
                />
              ) : null
            }
            control={
              <SettingsSegmentedControl
                value={settings.messageTrailAudioSource}
                onValueChange={(value) => updateSettings({ messageTrailAudioSource: value })}
                ariaLabel={t("settings:messageTrailSound")}
                options={MESSAGE_TRAIL_AUDIO_SOURCE_OPTIONS}
              />
            }
          />
        ) : null}

        {isAudioLevelAvailable() &&
        (settings.messageTrailAudioSource === "microphone" ||
          settings.messageTrailAudioSource === "both") ? (
          <MessageTrailMicrophoneRow
            value={settings.messageTrailMicrophoneId}
            defaultValue={defaults.messageTrailMicrophoneId}
            onChange={(messageTrailMicrophoneId) => updateSettings({ messageTrailMicrophoneId })}
          />
        ) : null}
      </SettingsSection>

      <SettingsSection title="settings:typographyAndSpacing">
        <SettingsRow
          id="setting-use-system-ui-font"
          title="settings:useSystemUIFont"
          description="settings:ignoreTheThemeSCustomUIFontAndRender"
          resetAction={
            !systemUiFont ? (
              <SettingResetButton
                label={t("settings:systemUIFont")}
                onClick={() => setSystemUiFont(true)}
              />
            ) : null
          }
          control={
            <Switch
              checked={systemUiFont}
              onCheckedChange={(checked) => setSystemUiFont(Boolean(checked))}
              aria-label={t("settings:useSystemUIFont")}
            />
          }
        />

        <SettingsRow
          id="setting-ui-density"
          title="settings:changed_uiDensity"
          description="settings:controlSpacingInTheSidebarComposerChatGuttersAnd"
          resetAction={
            settings.uiDensity !== defaults.uiDensity ? (
              <SettingResetButton
                label={t("settings:changed_uiDensity")}
                onClick={() =>
                  updateSettings({
                    uiDensity: DEFAULT_UI_DENSITY,
                  })
                }
              />
            ) : null
          }
          control={
            <SettingsSegmentedControl
              value={settings.uiDensity}
              onValueChange={(value) => {
                if (!isUiDensity(value)) {
                  return;
                }
                updateSettings({ uiDensity: value });
              }}
              ariaLabel={t("settings:changed_uiDensity")}
              options={UI_DENSITY_OPTIONS}
            />
          }
        />

        <SettingsRow
          id="setting-chat-width"
          title="settings:chatWidth"
          description="settings:controlHowWideTheChatColumnGrowsWideAnd"
          resetAction={
            settings.chatWidth !== defaults.chatWidth ? (
              <SettingResetButton
                label={t("settings:chatWidth2")}
                onClick={() =>
                  updateSettings({
                    chatWidth: DEFAULT_CHAT_WIDTH,
                  })
                }
              />
            ) : null
          }
          control={
            <SettingsSegmentedControl
              value={settings.chatWidth}
              onValueChange={(value) => {
                if (!isChatWidthMode(value)) {
                  return;
                }
                updateSettings({ chatWidth: value });
              }}
              ariaLabel={t("settings:chatWidth")}
              options={CHAT_WIDTH_OPTIONS}
            />
          }
        />

        <SettingsRow
          id="setting-base-font-size"
          title="settings:changed_baseFontSize"
          description="settings:adjustTheAppTextBaseInPixelsChatAnd2"
          resetAction={
            settings.chatFontSizePx !== defaults.chatFontSizePx ? (
              <SettingResetButton
                label={t("settings:baseFontSize")}
                onClick={() =>
                  updateSettings({
                    chatFontSizePx: defaults.chatFontSizePx,
                  })
                }
              />
            ) : null
          }
          control={
            <div className="flex w-full items-center justify-end gap-2 sm:w-auto">
              <Input
                type="number"
                size="sm"
                min={MIN_CHAT_FONT_SIZE_PX}
                max={MAX_CHAT_FONT_SIZE_PX}
                step={1}
                inputMode="numeric"
                variant="soft"
                className="w-full text-right sm:w-20"
                value={String(settings.chatFontSizePx)}
                onChange={(event) => {
                  const nextValue = event.target.value.trim();
                  if (nextValue.length === 0) return;
                  updateSettings({
                    chatFontSizePx: normalizeChatFontSizePx(Number(nextValue)),
                  });
                }}
                aria-label={t("settings:baseFontSizeInPixels")}
              />
              <span className="text-ui leading-snug text-muted-foreground">
                {t("settings:appearance_px")}
              </span>
            </div>
          }
        />

        <SettingsRow
          id="setting-terminal-font-size"
          title="settings:changed_terminalFontSize"
          description="settings:adjustTerminalTextIndependentlyFromTheAppAndChat"
          resetAction={
            settings.terminalFontSizePx !== defaults.terminalFontSizePx ? (
              <SettingResetButton
                label={t("settings:terminalFontSize")}
                onClick={() =>
                  updateSettings({
                    terminalFontSizePx: defaults.terminalFontSizePx,
                  })
                }
              />
            ) : null
          }
          control={
            <div className="flex w-full items-center justify-end gap-2 sm:w-auto">
              <Input
                type="number"
                size="sm"
                min={MIN_TERMINAL_FONT_SIZE_PX}
                max={MAX_TERMINAL_FONT_SIZE_PX}
                step={1}
                inputMode="numeric"
                variant="soft"
                className="w-full text-right sm:w-20"
                value={String(settings.terminalFontSizePx)}
                onChange={(event) => {
                  const nextValue = event.target.value.trim();
                  if (nextValue.length === 0) return;
                  updateSettings({
                    terminalFontSizePx: normalizeTerminalFontSizePx(Number(nextValue)),
                  });
                }}
                aria-label={t("settings:terminalFontSizeInPixels")}
              />
              <span className="text-ui leading-snug text-muted-foreground">
                {t("settings:appearance_px")}
              </span>
            </div>
          }
        />

        <SettingsRow
          id="setting-terminal-font"
          title="settings:changed_terminalFont"
          description="settings:typeAnyMonospaceFontInstalledOnThisDeviceE2"
          resetAction={
            settings.terminalFontFamily !== defaults.terminalFontFamily ? (
              <SettingResetButton
                label={t("settings:terminalFont")}
                onClick={() =>
                  updateSettings({
                    terminalFontFamily: defaults.terminalFontFamily,
                  })
                }
              />
            ) : null
          }
          control={
            <div className="flex w-full items-center justify-end sm:w-auto">
              <Autocomplete
                items={visibleTerminalFontFamilySuggestions}
                mode="none"
                openOnInputClick
                value={settings.terminalFontFamily}
                onValueChange={(value) => {
                  updateSettings({
                    terminalFontFamily: normalizeTerminalFontFamily(value),
                  });
                }}
              >
                <AutocompleteInput
                  size="sm"
                  variant="soft"
                  showTrigger
                  showClear={settings.terminalFontFamily.length > 0}
                  spellCheck={false}
                  autoComplete="off"
                  placeholder={t("settings:defaultJetBrainsMono")}
                  className="w-full sm:w-56"
                  aria-label={t("settings:terminalFontFamily")}
                />
                <AutocompletePopup className="w-56 min-w-56 font-system-ui">
                  <AutocompleteList>
                    {visibleTerminalFontFamilySuggestions.map((suggestion, index) => (
                      <AutocompleteItem
                        key={suggestion}
                        index={index}
                        value={suggestion}
                        className="font-normal text-[var(--color-text-foreground)]"
                        onClick={() => {
                          updateSettings({
                            terminalFontFamily: normalizeTerminalFontFamily(suggestion),
                          });
                        }}
                      >
                        {suggestion}
                      </AutocompleteItem>
                    ))}
                    <AutocompleteEmpty>{t("settings:noMatchingSuggestedFonts")}</AutocompleteEmpty>
                  </AutocompleteList>
                </AutocompletePopup>
              </Autocomplete>
            </div>
          }
        />

        {shouldShowFontSmoothing ? (
          <BooleanSettingRow
            {...binding}
            id="setting-font-smoothing"
            settingKey="enableNativeFontSmoothing"
            title="settings:changed_fontSmoothing"
            description="settings:useMacOSStyleAntialiasingForLighterCrisperTextRendering"
            resetLabel="settings:fontSmoothing"
            ariaLabel="settings:enableFontSmoothing"
          />
        ) : null}
      </SettingsSection>
    </div>
  );
}
