# Language Switcher in App Settings

**Date:** 2026-07-05
**Status:** Draft
**Author:** Claude (brainstormed with user)

## Overview

Add a language switch control in Settings → General so users can toggle the UI language between English (`en`) and Simplified Chinese (`zh-CN`) at runtime. The project already ships 1,789 translation keys in both locales via `i18next` + `react-i18next`, but currently hard-codes the locale from the `VITE_LOCALE` env var at build time with no runtime toggle.

Crucially, the **top-level navigation labels** (`General`, `Appearance`, `Profile`, etc.) and **panel section titles** are still hard-coded English in `settingsNavigation.ts`. To deliver a fully localized experience when switching languages, these strings must be moved into the i18n system **before** the language switcher can work properly.

## Design

### Prerequisite: Move navigation strings into i18n

Before adding the language switch, we must internationalise the settings navigation system:

1. Extract all hard-coded strings from `settingsNavigation.ts` into `en.json` and `zh-CN.json`:
   - `SETTINGS_NAV_GROUPS[].label` → `"settings.nav.groups.[id]"`
   - `SETTINGS_NAV_ITEMS[].label` → `"settings.nav.items.[id].label"`
   - `SETTINGS_NAV_ITEMS[].description` → `"settings.nav.items.[id].description"`
   - `SETTINGS_NAV_ITEMS[].eyebrow` → `"settings.nav.items.[id].eyebrow"`
   - `SETTINGS_SECTION_IDS[].label` (used in `settingsSectionLabel`) → `"settings.section.[id].label"`

2. Update `settingsNavigation.ts` to read these keys via `useTranslation()` instead of using hard-coded values.

3. Update `settingsSearchIndex.ts` and `settingsSectionLabel` helpers accordingly.

Once this prerequisite is done, switching language will translate **both** the navigation sidebar **and** the panel content.

> **Note:** The actual implementation of this prerequisite is outside the scope of this spec, but it is a necessary foundation. This spec assumes the navigation strings have already been moved into i18n.

### Placement: Settings → General, first row

With the navigation system now i18n-capable, the language switch sits at the **top of the General panel**, above Default provider. This follows the pattern of most desktop applications (macOS System Settings → General → Language & Region, Slack Preferences → Language & Region) where language is treated as a fundamental global preference rather than a visual-style setting.

```
┌─ General ────────────────────────────────────┐
│  Language         [ English  ▾ ]  ← 第一行   │
│  Default Provider [ codex  ▾ ]               │
│  New Threads      [ Local  ▾ ]               │
│  Sidebar Organization ...                     │
│  ...                                          │
└───────────────────────────────────────────────┘
```

### Locale field — `AppSettingsSchema`

Add a `locale` field to the existing AppSettings schema:

```ts
// apps/web/src/appSettings.ts
const SUPPORTED_LOCALES = ["en", "zh-CN"] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

// Inside AppSettingsSchema.Struct({...}) add:
locale: Schema.Literal(...SUPPORTED_LOCALES).pipe(Schema.withDecodingDefault(() => "en" as const));
```

The `SUPPORTED_LOCALES` constant centralises the list so adding a new language is a single-line change plus a new locale file. The `Literal` constrains valid values at both TypeScript type level and runtime (Schema decoding).

### i18n bootstrap — read from localStorage directly

`i18n/index.ts` initialises before React renders, so it cannot use `useAppSettings`. It reads the raw localStorage value directly with a safe fallback chain:

```ts
const storedLocale = (() => {
  try {
    const raw = localStorage.getItem("synara:app-settings:v1");
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed.locale === "en" || parsed.locale === "zh-CN") return parsed.locale;
    }
  } catch {}
  return import.meta.env.VITE_LOCALE || "en";
})();

i18n.use(initReactI18next).init({
  lng: storedLocale,
  fallbackLng: "en",
  resources: { en, "zh-CN": zhCN },
});
```

The try/catch is defensive: if localStorage is unavailable (incognito, SSR, corrupted data) it falls back to the env var, then to `"en"`.

### UI — dropdown select in General panel

A `SettingsRow` with a `SettingsSelectControl` added to `renderGeneralPanel()` in `_chat.settings.tsx`, positioned **first** inside the `coreDefaults` section, before Default provider:

```tsx
<SettingsRow
  title={t("settings.general.language")}
  description={t("settings.general.languageDescription")}
  control={
    <SettingsSelectControl
      value={settings.locale}
      onValueChange={(value) => {
        if (value !== "en" && value !== "zh-CN") return;
        updateSettings({ locale: value });
        i18n.changeLanguage(value);
      }}
      ariaLabel={t("settings.general.languageAria")}
    >
      <SelectItem key="en" value="en">
        English
      </SelectItem>
      <SelectItem key="zh-CN" value="zh-CN">
        简体中文
      </SelectItem>
    </SettingsSelectControl>
  }
/>
```

Using `SettingsSelectControl` (dropdown) rather than `SettingsSegmentedControl` (segmented button row) keeps the interaction consistent with the existing Default provider selector — same visual style, same interaction pattern. The option labels are hard-coded in their own script (English / 简体中文) so users can always identify their language regardless of the current UI locale.

The `coreDefaults` section already has a header `t("settings.general.coreDefaults")` which translates to "Core defaults". The Language row sits as the first child of this section.

### Translation keys

Add three new keys to both `en.json` and `zh-CN.json`:

| Key                                    | en                           | zh-CN          |
| -------------------------------------- | ---------------------------- | -------------- |
| `settings.general.language`            | Language                     | 语言           |
| `settings.general.languageDescription` | Display language for the UI. | 界面显示语言。 |
| `settings.general.languageAria`        | Language                     | 语言           |

These keys follow the existing naming convention under `settings.general.*` (`defaultProvider`, `newThreads`, `projectOrder`, etc.).

### Edge cases

| Scenario                                                                                  | Behaviour                                                                                           |
| ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| New user, no stored settings                                                              | Defaults to `"en"` (from Schema `withDecodingDefault`)                                              |
| Corrupt localStorage JSON                                                                 | `try/catch` in bootstrap silently falls back to env var, then `"en"`                                |
| Stored locale is `"fr"` (not in SUPPORTED_LOCALES)                                        | Schema decoding default kicks in → `"en"`                                                           |
| User switches language mid-conversation                                                   | i18next re-renders all components in the new language instantly; no page reload needed              |
| Locale dropdown shows current language name (e.g. "English") which is itself untranslated | Intentional — language names use endonym (the name in their own script) so they are always readable |

## Files changed (for language switcher only)

| File                                                   | Change                                                                                                  |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `apps/web/src/appSettings.ts`                          | Add `SUPPORTED_LOCALES` constant and `locale` field to `AppSettingsSchema`                              |
| `apps/web/src/i18n/index.ts`                           | Read locale from localStorage before init, fallback chain                                               |
| `apps/web/src/routes/_chat.settings.tsx`               | Add language `SettingsRow` + `SettingsSelectControl` to `renderGeneralPanel()`, first in `coreDefaults` |
| `apps/web/src/components/settings/SettingControls.tsx` | No change needed — `SettingsSelectControl` already supports string values                               |
| `apps/web/src/i18n/locales/en.json`                    | Add 3 new translation keys under `settings.general.*`                                                   |
| `apps/web/src/i18n/locales/zh-CN.json`                 | Add 3 new translation keys under `settings.general.*`                                                   |

## Scope

This spec is focused enough to implement in one pass. The work is fully contained in the web app — no server changes, no contract changes, no thread/project data schema changes.

> **Important:** This spec assumes the prerequisite work (moving navigation strings into i18n) has already been completed. Without that step, switching language will only translate panel contents while the navigation sidebar remains in English, creating a fragmented experience.
