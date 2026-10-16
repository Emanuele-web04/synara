# Native extension marketplace

The user-authorized marketplace lives in **Settings → Extensions**, reached from the existing editor rail. It replaces the earlier plain search form rather than adding another marketplace window, Activity Bar or workbench. PR #1936 remains independently usable.

## Browse and manage

- **Marketplace** loads live Open VSX listings on entry. Search updates after a short pause or immediately on submission. Category and sorting are sent to the registry; results are paged in groups of 24, never an unbounded client-side catalog download. Exact publisher IDs use validated metadata instead of depending on search indexing.
- Each card displays publisher identity, description and downloads when the registry provides them. The native details dialog resolves an API-compatible stable package, with its version, license, categories and API requirement. No ratings, endorsements or safety badges are invented. Package icons use Synara glyphs, not remote tracking images.
- **Installed** retains the existing enable/disable, update, configuration and remove controls. Installing leaves the package disabled. Enabling still requires explicit approval of its digest and every dependency.
- **Permissions** retains explicit workspace trust. Browsing, inspecting details, switching tabs and installing never start an extension host or grant trust.
- Network errors are visible with a retry action. Catalog requests have cancellation and deadlines and do not own the mutation queue, so browsing cannot block trust revocation behind a slow registry search. A cancelled mutation refreshes authoritative installed state instead of assuming that cancellation rolled back a committed installation.

The read-only catalog and details are new optional fields/operations in the existing authenticated extension RPC. Existing search/lifecycle operations remain intact. No dependencies or persistence migrations were added. All state remains scoped to Synara's existing server/channel directory.

## Apple guidance and Synara components

This is a React/Electron interface, not a claim to be an AppKit app or Apple-certified. Apple guidance is adapted to Synara's established visual language:

| Apple source                                                                                                                               | Applied behavior                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Search fields](https://developer.apple.com/design/human-interface-guidelines/search-fields)                                               | Search next to its catalog, explicit scope/categories, responsive results and clear search terms.                                                                                            |
| [Loading](https://developer.apple.com/design/human-interface-guidelines/loading)                                                           | Skeletons instead of a blank initial page, nonblocking navigation and truthful progress without invented percentages.                                                                        |
| [Feedback](https://developer.apple.com/design/human-interface-guidelines/feedback)                                                         | Installation status beside the affected card; explicit installed-but-disabled outcome; alerts reserved for approvals and errors.                                                             |
| [Focus and selection](https://developer.apple.com/design/human-interface-guidelines/focus-and-selection)                                   | Existing keyboard-operable segmented controls, visible focus, native dialog focus containment and return to the originating card. Pagination moves focus only after an explicit page action. |
| [Sufficient contrast](https://developer.apple.com/help/app-store-connect/manage-app-accessibility/sufficient-contrast-evaluation-criteria) | Existing semantic theme colors, no color-only state, scalable `text-ui` typography and light/dark verification.                                                                              |

Reused components: `SettingsCard`, `SettingsEmptyState`, `SettingsSelectPopup`, `SegmentedPicker`, `Button`, `Input`, `Skeleton`, `Select`, `Dialog` and existing approval dialogs. The new catalog component composes these primitives around the extension-specific data model; it is not a second UI kit.

## Verification and limits

`registryCatalog.test.ts` protects filter encoding, bounded pagination, exact identity, details, invalid responses and cancellation. `ExtensionMarketplace.browser.tsx` protects discovery, category/query changes, unavailable-registry recovery, native details/focus and approval separation. `editorMarketplace.e2e.ts` runs actual Open VSX discovery, detail resolution, disabled installation, removal, theme and compact-layout journeys inside isolated Synara. Read the corresponding Actions results before claiming these checks passed.

A marketplace listing or API-version match is not a promise of full VS Code compatibility. Extension execution remains subject to the existing [compatibility and sandbox matrix](./extensions.md), including the current macOS/Windows execution limits. Screen-reader behavior and native macOS accessibility settings require platform-specific checks beyond browser tests. Registry ordering/counts are live and can change. The 10,000-result browse window is bounded; narrow the search beyond it.
