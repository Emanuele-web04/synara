# Multilingual interface

Synara's own interface supports English and Spanish. Settings offers System, English and Español; System chooses a supported browser language and otherwise English. The preference stays in the existing local app settings, separate for each app origin. Language changes update mounted UI without reloading, losing drafts, or restarting providers.

Use bundled i18next/react-i18next resources with English source messages as stable keys, disabled key/namespace separators, English fallback, React-safe interpolation and locale-aware plurals. React consumers subscribe with useTranslation; event handlers and imperative menus use the same translator. Translate application-owned literals and explicitly identified built-in labels only. User messages, project/file names, source code, terminal output, model/provider names, tool payloads and provider error text remain intact.

Synchronize the renderer preference to native desktop menus/dialogs via validated main-frame IPC; persist it in the existing flavor-isolated state directory. Native roles/action IDs/accelerators and backend details remain intact.

Translate navigation, settings, chat controls and statuses, menus, dialogs, onboarding, workspace/browser/device controls and accessibility strings. English identifiers used for settings anchors, commands, storage or protocols remain stable. Dates and numbers use the selected locale; System preserves browser regional conventions.

Tests cover preference resolution/persistence, fallback, interpolation, plural handling, live changes without remounting, stable settings anchors/search and catalog coverage. Verify relevant existing tests and browser fixtures, then run formatter, lint and workspace typecheck once at the end. This changes the application interface only; no publishing, release rebuilding or provider calls.
