// FILE: AppearanceSettings.tsx
// Purpose: Appearance settings panel (theme, theme packs, fonts, font size, time format).
// Layer: Settings UI components
// Exports: AppearanceSettings

import { type AppSettings } from "../../appSettings";
import {
  MAX_CHAT_FONT_SIZE_PX,
  MIN_CHAT_FONT_SIZE_PX,
  normalizeChatFontSizePx,
} from "../../appSettings";
import { type ThemeMode, type ThemeVariant } from "../../theme/theme.logic";
import { Input } from "../ui/input";
import { SelectItem } from "../ui/select";
import { Switch } from "../ui/switch";
import { ThemePackEditor } from "../ThemePackEditor";
import { SETTINGS_SECTION_LABEL_CLASS_NAME } from "../../settingsPanelStyles";
import {
  CODE_FONT_PRESETS,
  SettingResetButton,
  SettingsFontControl,
  SettingsSelectControl,
  UI_FONT_PRESETS,
} from "./SettingControls";
import { SettingsCard, SettingsRow, SettingsSection } from "./SettingsPanelPrimitives";

const THEME_OPTIONS = [
  {
    value: "system",
    label: "System",
    description: "Match your OS appearance setting.",
  },
  {
    value: "light",
    label: "Light",
    description: "Always use the light theme.",
  },
  {
    value: "dark",
    label: "Dark",
    description: "Always use the dark theme.",
  },
] as const;

const TIMESTAMP_FORMAT_LABELS = {
  locale: "System default",
  "12-hour": "12-hour",
  "24-hour": "24-hour",
} as const;

export function AppearanceSettings({
  theme,
  resolvedTheme,
  setTheme,
  settings,
  defaults,
  updateSettings,
  shouldShowFontSmoothing,
}: {
  theme: ThemeMode;
  resolvedTheme: ThemeVariant;
  setTheme: (theme: ThemeMode) => void;
  settings: AppSettings;
  defaults: AppSettings;
  updateSettings: (patch: Partial<AppSettings>) => void;
  shouldShowFontSmoothing: boolean;
}) {
  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <h2 className={SETTINGS_SECTION_LABEL_CLASS_NAME}>Theme and typography</h2>
        <SettingsCard>
          <SettingsRow
            title="Theme"
            description="Choose how Synara looks across the app."
            resetAction={
              theme !== "system" ? (
                <SettingResetButton label="theme" onClick={() => setTheme("system")} />
              ) : null
            }
            control={
              <SettingsSelectControl
                value={theme}
                onValueChange={(value) => {
                  if (value !== "system" && value !== "light" && value !== "dark") return;
                  setTheme(value);
                }}
                ariaLabel="Theme preference"
                triggerClassName="w-full sm:w-40"
                valueContent={
                  THEME_OPTIONS.find((option) => option.value === theme)?.label ?? "System"
                }
              >
                {THEME_OPTIONS.map((option) => (
                  <SelectItem hideIndicator key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SettingsSelectControl>
            }
          />
        </SettingsCard>

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

        <SettingsCard>
          <SettingsRow
            title="UI font"
            description="Set a custom font for the interface. Leave empty to use the active theme's UI font."
            resetAction={
              settings.uiFontFamily !== defaults.uiFontFamily ? (
                <SettingResetButton
                  label="UI font"
                  onClick={() => updateSettings({ uiFontFamily: defaults.uiFontFamily })}
                />
              ) : null
            }
            control={
              <SettingsFontControl
                value={settings.uiFontFamily}
                onValueChange={(value) => updateSettings({ uiFontFamily: value })}
                presets={UI_FONT_PRESETS}
                placeholder="System default"
                ariaLabel="Custom UI font family"
              />
            }
          />

          <SettingsRow
            title="Code font"
            description="Set a custom font for code blocks and inline code in chat. Leave empty to use the active theme's code font."
            resetAction={
              settings.chatCodeFontFamily !== defaults.chatCodeFontFamily ? (
                <SettingResetButton
                  label="code font"
                  onClick={() =>
                    updateSettings({
                      chatCodeFontFamily: defaults.chatCodeFontFamily,
                    })
                  }
                />
              ) : null
            }
            control={
              <SettingsFontControl
                value={settings.chatCodeFontFamily}
                onValueChange={(value) => updateSettings({ chatCodeFontFamily: value })}
                presets={CODE_FONT_PRESETS}
                placeholder="System default"
                ariaLabel="Custom chat code font family"
              />
            }
          />

          <SettingsRow
            title="Base font size"
            description="Adjust the app text base in pixels. Chat and UI typography scale proportionally from this value."
            resetAction={
              settings.chatFontSizePx !== defaults.chatFontSizePx ? (
                <SettingResetButton
                  label="base font size"
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
                  min={MIN_CHAT_FONT_SIZE_PX}
                  max={MAX_CHAT_FONT_SIZE_PX}
                  step={1}
                  inputMode="numeric"
                  className="w-full text-right sm:w-20"
                  value={String(settings.chatFontSizePx)}
                  onChange={(event) => {
                    const nextValue = event.target.value.trim();
                    if (nextValue.length === 0) return;
                    updateSettings({
                      chatFontSizePx: normalizeChatFontSizePx(Number(nextValue)),
                    });
                  }}
                  aria-label="Base font size in pixels"
                />
                <span className="text-xs text-muted-foreground">px</span>
              </div>
            }
          />

          {shouldShowFontSmoothing ? (
            <SettingsRow
              title="Font smoothing"
              description="Use macOS-style antialiasing for lighter, crisper text rendering."
              resetAction={
                settings.enableNativeFontSmoothing !== defaults.enableNativeFontSmoothing ? (
                  <SettingResetButton
                    label="font smoothing"
                    onClick={() =>
                      updateSettings({
                        enableNativeFontSmoothing: defaults.enableNativeFontSmoothing,
                      })
                    }
                  />
                ) : null
              }
              control={
                <Switch
                  checked={settings.enableNativeFontSmoothing}
                  onCheckedChange={(checked) =>
                    updateSettings({ enableNativeFontSmoothing: checked })
                  }
                  aria-label="Enable font smoothing"
                />
              }
            />
          ) : null}
        </SettingsCard>
      </section>

      <SettingsSection title="Time and reading">
        <SettingsRow
          title="Time format"
          description="System default follows your browser or OS clock preference."
          resetAction={
            settings.timestampFormat !== defaults.timestampFormat ? (
              <SettingResetButton
                label="time format"
                onClick={() =>
                  updateSettings({
                    timestampFormat: defaults.timestampFormat,
                  })
                }
              />
            ) : null
          }
          control={
            <SettingsSelectControl
              value={settings.timestampFormat}
              onValueChange={(value) => {
                if (value !== "locale" && value !== "12-hour" && value !== "24-hour") {
                  return;
                }
                updateSettings({
                  timestampFormat: value,
                });
              }}
              ariaLabel="Timestamp format"
              triggerClassName="w-full sm:w-40"
              valueContent={TIMESTAMP_FORMAT_LABELS[settings.timestampFormat]}
            >
              <SelectItem hideIndicator value="locale">
                {TIMESTAMP_FORMAT_LABELS.locale}
              </SelectItem>
              <SelectItem hideIndicator value="12-hour">
                {TIMESTAMP_FORMAT_LABELS["12-hour"]}
              </SelectItem>
              <SelectItem hideIndicator value="24-hour">
                {TIMESTAMP_FORMAT_LABELS["24-hour"]}
              </SelectItem>
            </SettingsSelectControl>
          }
        />
      </SettingsSection>
    </div>
  );
}
