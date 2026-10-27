# Interface languages

Synara supports English, Simplified Chinese (`zh-CN`), and Spanish. Choose **Settings → General → Language**. **System** follows the browser's preferred languages on the web and Electron's preferred operating-system languages on desktop. An explicit choice overrides the system preference.

The resolver tries candidates in preference order. Simplified Chinese includes `zh`, `zh-CN`, `zh-SG`, and `zh-Hans` variants. Traditional Chinese (`zh-TW`, `zh-HK`, `zh-MO`, or explicit `zh-Hant`) is not silently treated as Simplified Chinese: resolution continues to the next supported candidate, then falls back to English. Malformed preferences safely fall back to System; malformed platform candidates are skipped.

## Ownership

- `packages/contracts/src/uiLocale.ts` defines the locale IDs, preference schema, names, aliases, and text directions. Language is a presentation preference, not a provider option.
- `packages/shared/src/uiLocale.ts` resolves preferences for both processes. Shared resources are exported through `uiLocalizationResources` and `nativeLocalizationResources`; the native import includes only the desktop namespace.
- `packages/shared/src/locales/<locale>/<namespace>.json` contains the catalogs. English is authoritative. Namespaces cover common controls, settings, chat, workspace, computer use, Git, automation, onboarding, and desktop.
- `apps/web/src/i18n` owns the React subscription, document `lang`/`dir`, formatting locale, storage synchronization, and rich React messages. Bootstrap error screens use text nodes for translated strings.
- `apps/desktop/src/i18n.ts` localizes native menus and startup dialogs before any renderer opens. `desktopPreferences.ts` atomically mirrors the preference beside the renderer's actual Electron `userData` profile, including isolated profile overrides. Stable and Beta remain isolated. Only the main window's main frame may change that mirror.

Settings retain their existing local storage ownership. A language change updates the mounted interface and native menu without replacing drafts or user content. Use the resolved interface locale for `Intl.DateTimeFormat`, `Intl.NumberFormat`, `Intl.RelativeTimeFormat`, and `Intl.ListFormat`.

The embedded editor loads Monaco's bundled locale before its engine is first imported. Some engine registrations cache translated labels at module evaluation. After changing language with an already loaded editor, Settings offers a reload action using the existing save-before-reload guard. It never forces a reload or discards unsaved edits. Synara's own editor controls update immediately.

macOS permission dialogs select their language through macOS, independently of Synara's interface setting. Packaged apps and source launchers include English, Simplified Chinese, and Spanish app-authored permission explanations. System-owned menu items, dialog titles, and buttons remain controlled by macOS.

## Adding or changing copy

Use stable semantic keys, such as `settings:searchSettings`, rather than English sentences as IDs. Keep keys unchanged when wording changes. Add the corresponding value to every shipped locale in the same change.

```tsx
const { t } = useTranslation();
return <button>{t("common:form_cancel")}</button>;
```

Reuse an existing key only when it represents the same meaning. A read receipt and the command to read a file need different contexts. Use full messages with named interpolation values and plural forms (`_one`, `_other`) for counts. Avoid composing sentences from translated prefixes, nouns, and suffixes.

For styled text or links inside a sentence, use `Translation` with named React slots. Catalogs supply wording and slot placement, while source code owns components, URLs, handlers, and properties. Do not put HTML attributes or executable markup in catalogs. Never insert translated strings with `innerHTML`.

Keep these values unchanged:

- User-authored messages, names, drafts, instructions, notes, and imported content.
- Provider output, model IDs, executable paths, commands, filenames, URLs, protocol values, and raw error details.
- Agent-facing prompts and context assembled by the application.
- Product and protocol identifiers such as Synara, Codex, Claude, Cursor, Devin, OpenCode, AppSnap, MCP, CLI, Git, GitHub, and worktree.

Translate application-owned labels at the presentation boundary. Where a durable state or error is displayed, keep its stable identifier and localize the view; do not persist translated labels or classify events by translated text.

Settings search indexes semantic keys and searches both the active language and English. Every searchable row uses an explicit stable `target` and matching DOM `id`. Never derive anchors, persisted values, or action identifiers from translated text.

## Verification

```sh
bun run i18n:check
bun run i18n:extract --check
bun run i18n:coverage
```

These commands are deterministic and read-only. The catalog check verifies locale/namespace/key parity, interpolation, protected tokens, message markup, and referenced keys. Extraction detects untranslated application UI literals; its narrow exemptions document product names and technical examples. Coverage also reports unchanged translations for review. CI runs catalog and extraction checks.

Run the affected Vitest and browser suites when changing runtime behavior. Verify an explicit Chinese preference, System resolution, English fallback, live switching, reload persistence, settings search and anchors, rich messages, counts, and unchanged user/provider content. Native changes also need menu and cold-start checks with an isolated data home. A mocked dialog test does not prove a packaged app on another operating system.

This implementation adapts the broad UI/native coverage from [#1903](https://github.com/Emanuele-web04/synara/pull/1903), with Chinese terminology informed by [#308](https://github.com/Emanuele-web04/synara/pull/308), following the native localization requirements in [#977](https://github.com/Emanuele-web04/synara/issues/977).
