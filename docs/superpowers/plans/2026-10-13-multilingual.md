# Multilingual Interface Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans for integration and superpowers:dispatching-parallel-agents for independent catalog work. Track each task below.

**Goal:** Ship an extensible multilingual interface with complete application-owned Spanish copy and an English fallback.
**Architecture:** Bundled i18next resources, English source keys, reactive React hooks and a non-React translator. Persist System/en/es in existing app settings and retain stable UI/protocol identifiers.
**Tech Stack:** React, TypeScript, i18next, react-i18next, existing Effect settings codec and Vitest/browser fixtures.
**Spec:** ../specs/2026-10-13-multilingual-design.md

## Global Constraints

- Stay on upstream/main b4bdc7362 in the existing isolated t3/multilingual-support worktree.
- Reuse settings controls/storage and browser fixtures; no global DOM translation or transcript mutation.
- No provider calls, publishing, unrelated refactors or fixed typography sizes.
- Changing language must preserve mounted state, settings anchors and technical command identifiers.

## Review Focus

- Stored unsupported or malformed language values recover safely.
- Memoized components/options update immediately when language changes.
- Interpolated user content is preserved as data, never looked up as a translation key.
- Spanish search finds translated settings while English anchors stay stable.
- Every extracted message has a Spanish translation and matching interpolation tokens.

### Task 1: Language runtime and settings

**Files:** apps/web/src/i18n/{index,locale}.ts and tests; appSettings.ts; main.tsx; settings route/navigation/search/primitives.
**Interfaces:** export t(message, values?) -> string, useTranslation() -> {t, locale}; pure preference/locale resolution; a getFormatLocale() accessor.

- [x] Write and run failing locale/runtime/settings tests.
- [x] Add bundled runtime, validated persistent preference, initial language/document lang and reactive settings selector.
- [x] Localize settings navigation/search with stable anchors and verify focused tests.

### Task 2: Interface extraction and Spanish catalogs

**Files:** application-owned web UI sources, apps/web/src/i18n/locales/es.json; extraction/coverage tests and docs/internationalization.md.
**Interfaces:** Task 1's t/useTranslation, English message keys with {{named}} interpolation.

- [x] Extract owned visible literals and accessibility copy using source-aware transformations, leaving arbitrary content untouched.
- [x] Translate independent catalog partitions and merge them, including dynamic built-in labels and plurals.
- [x] Subscribe affected components, include translator in memo dependencies and verify catalog/placeholders and UI tests.

### Task 3: Native desktop language

**Files:** native desktop preferences/runtime/menu/dialogs/preload/IPC, bridge schema in contracts, renderer language synchronization.

- [x] Persist a flavor-isolated native preference and synchronize through a validated main-frame IPC setter.
- [x] Translate authored native menu/dialog labels while keeping roles/actions/accelerators and backend details intact.
- [x] Verify native startup preference, EN/ES labels and bridge validation with focused tests.

### Task 4: Verification and review

**Files:** affected runtime/formatting/UI tests and existing browser fixtures.

- [x] Verify language switching, persistence, regional formatting, no draft loss and stable search links in a browser.
- [x] Run affected Vitest tests, bun run fmt:check, bun run lint and bun run typecheck; run full workspace tests and windows-runtime:check for the new desktop bridge.
- [x] Request one independent final review, resolve material findings, update docs and report actual results and remaining gaps.
