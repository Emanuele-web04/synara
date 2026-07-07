# Language Switcher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a language switch control in Settings → General to toggle UI language between English and Simplified Chinese at runtime, with prerequisites for full navigation internationalization.

**Architecture:**

1. Add locale field to AppSettingsSchema with SUPPORTED_LOCALES constant
2. Modify i18n/index.ts to read locale from localStorage during initialization
3. Add SettingsRow with SettingsSelectControl in renderGeneralPanel() for language selection
4. On language change, update AppSettings and call i18n.changeLanguage()

**Tech Stack:** TypeScript, React, i18next, react-i18next, Effect Schema, localStorage

## Global Constraints

- Must use existing AppSettingsSchema pattern for new field
- Must use existing SettingsRow + SettingsSelectControl components
- Language options are fixed to ["en", "zh-CN"] for now
- Must persist selection in localStorage via existing synara:app-settings:v1 key
- Must follow existing naming convention for translation keys
- No server or contract changes required

---

### Task 1: Add locale field to AppSettingsSchema

**Files:**

- Modify: `apps/web/src/appSettings.ts`

**Interfaces:**

- Consumes: None
- Produces: AppSettingsSchema with locale field

- [ ] **Step 1: Add SUPPORTED_LOCALES constant and locale field**

```typescript
// Add near top of file after imports
const SUPPORTED_LOCALES = ["en", "zh-CN"] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

// Inside AppSettingsSchema.Struct({...}) add after textGenerationModel:
locale: Schema.Literal(...SUPPORTED_LOCALES).pipe(Schema.withDecodingDefault(() => "en" as const));
```

- [ ] **Step 2: Verify Schema compiles**

Run: `bun typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/appSettings.ts
git commit -m "feat: add locale field to AppSettingsSchema"
```

### Task 2: Initialize i18n from localStorage

**Files:**

- Modify: `apps/web/src/i18n/index.ts`

**Interfaces:**

- Consumes: None
- Produces: i18n instance initialized with locale from localStorage

- [ ] **Step 1: Add localStorage reading logic**

```typescript
// Replace current initialization logic with:
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

- [ ] **Step 2: Verify no build errors**

Run: `bun run build`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/i18n/index.ts
git commit -m "feat: initialize i18n from localStorage"
```

### Task 3: Add language switch UI to General panel

**Files:**

- Modify: `apps/web/src/routes/_chat.settings.tsx`

**Interfaces:**

- Consumes: settings.locale from useAppSettings hook
- Produces: SettingsRow with language selector in renderGeneralPanel()

- [ ] **Step 1: Add translation keys usage**

In renderGeneralPanel(), inside coreDefaults section, add as first SettingsRow:

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

- [ ] **Step 2: Verify UI renders without errors**

Run: `bun run dev` (manual visual check)
Expected: Language dropdown appears as first item in General → Core defaults

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/routes/_chat.settings.tsx
git commit -m "feat: add language switch to General panel"
```

### Task 4: Add translation keys for language switch

**Files:**

- Modify: `apps/web/src/i18n/locales/en.json`
- Modify: `apps/web/src/i18n/locales/zh-CN.json`

**Interfaces:**

- Consumes: None
- Produces: Added translation keys for language switch

- [ ] **Step 1: Add keys to en.json**

```json
// In the "settings": { "general": { } } section
"language": "Language",
"languageDescription": "Display language for the UI.",
"languageAria": "Language"
```

- [ ] **Step 2: Add keys to zh-CN.json**

```json
// In the "settings": { "general": { } } section
"language": "语言",
"languageDescription": "界面显示语言。",
"languageAria": "语言"
```

- [ ] **Step 3: Verify i18n works**

Run: `bun run dev` and switch language
Expected: Dropdown labels show correct language names

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/i18n/locales/en.json apps/web/src/i18n/locales/zh-CN.json
git commit -m "feat: add translation keys for language switch"
```

### Task 5: End-to-end language switch test

**Files:**

- Test: Manual verification

**Interfaces:**

- Consumes: All previous tasks
- Produces: Working language switch

- [ ] **Step 1: Test language persistence**

Actions:

1. Switch language to 中文
2. Refresh page
3. Verify UI shows 中文
4. Switch language to English
5. Refresh page
6. Verify UI shows English

Expected: Language selection persists across refreshes

- [ ] **Step 2: Test immediate UI update**

Actions:

1. Switch language from English to 中文
2. Verify all UI text updates immediately without refresh
3. Switch back to English
4. Verify all UI text updates immediately

Expected: All translatable text updates instantly

- [ ] **Step 3: Test invalid value handling**

Actions:

1. Manually set localStorage item to invalid locale (e.g. "fr")
2. Refresh page
3. Verify UI defaults to English

Expected: Falls back to English for invalid values

- [ ] **Step 4: Commit test results**

```bash
git commit -m "test: verify language switch functionality"
```

## Self-Review

### 1. Spec coverage check:

✓ Added locale field to AppSettingsSchema  
✓ Initialize i18n from localStorage  
✓ Added language switch UI to General panel  
✓ Added translation keys for language switch  
✓ Verified persistence and instant updates

### 2. Placeholder scan: No TBD, TODO, or placeholder text found

### 3. Type consistency:

- Schema.Literal returns "en" | "zh-CN"
- useAppSettings returns matching type
- updateSettings({ locale: value }) accepts string
- i18n.changeLanguage accepts string

All types consistent throughout the implementation flow.

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-07-05-language-switcher-plan.md`. Two execution options:**

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
