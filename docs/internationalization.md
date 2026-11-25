# Interface text

Synara's interface is English-only. There is no language setting: the web app, native menus, startup dialogs and macOS permission explanations always use English. Dates, times and numbers follow the system locale, as an unspecified `Intl` locale does.

Application copy lives in English message catalogs and is read through `t()`. This keeps wording in one place and lets other languages be added later without touching every component.

## Ownership

- `packages/contracts/src/uiLocale.ts` lists the shipped interface locale (`en`).
- `packages/shared/src/locales/en/<namespace>.json` contains the catalogs. Namespaces cover common controls, settings, chat, workspace, computer use, Git, automation, onboarding, and desktop. `uiLocalizationResources` and `nativeLocalizationResources` export them; the native import includes only the desktop namespace.
- `apps/web/src/i18n` owns the React translator, the formatting locale, and rich React messages. Bootstrap error screens use text nodes for catalog strings.
- `apps/desktop/src/i18n.ts` reads the desktop namespace for native menus and startup dialogs.

A saved language preference from an earlier build is ignored; it does not reset other settings.

## Adding or changing copy

Use stable semantic keys, such as `settings:searchSettings`, rather than English sentences as IDs. Keep keys unchanged when wording changes.

```tsx
const { t } = useTranslation();
return <button>{t("common:form_cancel")}</button>;
```

Reuse an existing key only when it represents the same meaning. Use full messages with named interpolation values and plural forms (`_one`, `_other`) for counts. Avoid composing sentences from separate prefixes, nouns, and suffixes.

For styled text or links inside a sentence, use `Translation` with named React slots. Catalogs supply wording and slot placement, while source code owns components, URLs, handlers, and properties. Do not put HTML attributes or executable markup in catalogs. Never insert catalog strings with `innerHTML`.

Keep user-authored content, provider output, model IDs, commands, filenames, URLs, protocol values, raw error details, and agent-facing prompts out of the catalogs. Do not persist catalog text or classify events by it; keep stable identifiers and render the label at the presentation boundary.

Every searchable Settings row uses an explicit stable `target` and matching DOM `id`. Never derive anchors, persisted values, or action identifiers from displayed text.

## Verification

```sh
bun run i18n:check
bun run i18n:extract --check
bun run i18n:coverage
```

These commands are deterministic and read-only. The catalog check verifies namespaces, interpolation, protected tokens, message markup, and that every referenced key exists in the English catalogs. Extraction lists UI literals that bypass the catalogs; its narrow exemptions document product names and technical examples. CI blocks on catalog and source-key errors and reports UI literals for follow-up.
