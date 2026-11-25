# Interface text

Synara's interface is localized into English, Simplified Chinese, Hindi, Spanish, French, Arabic, Bengali, Portuguese, Russian, and Urdu. The General settings language selector can follow the system language or pin one of those interface languages. Arabic and Urdu set the document direction to RTL; other languages use LTR.

Application copy lives in message catalogs and is read through `t()`. This keeps wording in one place and keeps stable IDs independent of displayed text.

## Ownership

- `packages/contracts/src/uiLocale.ts` lists the shipped interface locales, native names, directions, and language aliases.
- `packages/shared/src/locales/<locale>/<namespace>.json` contains the catalogs. Namespaces cover common controls, settings, chat, workspace, computer use, Git, automation, onboarding, and desktop. `uiLocalizationResources` exports every locale; `nativeLocalizationResources` exports only the desktop namespace.
- `apps/web/src/i18n` owns language resolution, the React translator, the formatting locale, document language/direction, and rich React messages. Bootstrap error screens use text nodes for catalog strings.
- `apps/desktop/src/i18n.ts` reads the desktop namespace for native menus and startup dialogs. `desktopPreferences.ts` persists the native language preference in the desktop user-data directory.
- `apps/desktop/resources/localizations/*.lproj` contains macOS permission explanations. `zh-CN` maps to the macOS `zh-Hans.lproj` bundle folder.

The `system` preference uses the desktop operating system's preferred languages when the native bridge is available and otherwise uses the browser language list. Unsupported or malformed candidates fall through to the next preference and finally to English. A saved invalid preference normalizes to `system` without resetting other settings.

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

These commands are deterministic and read-only. The catalog check verifies namespaces, interpolation, protected tokens, message markup, and exact catalog key parity with English. Extraction lists UI literals that bypass the catalogs; its narrow exemptions document product names, native language names, and technical examples. CI blocks on catalog and source-key errors and reports UI literals for follow-up.
