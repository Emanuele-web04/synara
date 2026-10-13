# Interface languages

Synara supports **System**, **English** and **Español** in Settings → General → Language. The preference is stored in the existing app settings. System selects a supported browser language, falling back to English; dates and numbers retain the system's regional conventions. Selecting a language changes mounted interface copy without restarting providers, reloading the page or losing drafts.

The web interface uses bundled i18next resources in `apps/web/src/i18n/locales/es.json`. English source messages are the keys and the fallback. Key and namespace separators are disabled, so punctuation in a source sentence is literal. No translation service or network request is involved.

## Writing interface copy

Use `const { t, formatLocale } = useTranslation()` from `~/i18n` in React components. Use the module's `t` in imperative event handlers. Translate authored source messages, not arbitrary user/provider strings:

```tsx
const { t } = useTranslation();
return <button>{t("Open {{name}}", { name: project.name })}</button>;
```

Add the exact source key and its Spanish translation to `locales/es.json`. Preserve every `{{placeholder}}`. Interpolated names, paths and content are data; leave them untouched. Use complete sentences where Spanish word order differs. i18next supports `count` plural variants and context suffixes; use context for meanings such as command verbs versus status labels.

Do not translate project names, chat messages, user-entered labels, source code, commands, provider output, protocol identifiers or labels consumed as state/agent context. Localize the final presentation after classifying source states. Settings rows keep English source titles for their stable search anchors. Settings groups containing project names use `translateTitle={false}`.

React Compiler can cache calls with unchanged arguments. Include `t` in dependencies for memoized translated data, pass it to presentation helpers, and pass the hook's `formatLocale` to formatting helpers. Do not translate at module initialization. Keep module metadata as source text and translate at render, or make a rendering callback receive `t` explicitly. Existing callbacks can keep an older translator reference: the wrapper always reads the current runtime language.

Work-log parsing keeps source titles in its cache. Presentation recipes produce `displayToolTitle` after parsing and grouping, so changing language does not alter tool classification or freeze titles in the first language used. Relative-time list labels and complete “time ago” phrases have separate helpers; avoid appending another “ago” to an already localized phrase.

`~/i18n/pluralize` localizes known UI nouns. The shared text utility remains unchanged for protocols and source parsing. Explicit technical `en-US` formatting stays technical.

## Desktop

The native bridge synchronizes the renderer preference through a validated language setter. Desktop persists it in `desktop-language.json` under the current app flavor's state directory, so Stable and Beta retain separate preferences. System follows Electron's system locale. App-owned native menus and dialogs use the desktop's bundled catalog; action IDs, roles, shortcuts, file paths and backend details retain their source values.

## Adding a language

1. Add the locale to the web preference/resolution list and the desktop language schema in contracts.
2. Add a bundled catalog and register it in the web and desktop runtimes; add its native-name choice to the existing settings selector.
3. Preserve placeholders, context variants and plural forms. Translate application-owned copy only.
4. Run the focused i18n tests, browser language-switching tests, native language tests and the repository's required checks.

`apps/web/src/i18n/catalog.test.ts` checks explicit source-message coverage, interpolation preservation and module-initialization mistakes. Browser tests verify persistence, regional formatting and live switching through memoized components without remounting state.
