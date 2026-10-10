# File Explorer (#154) visual evidence

Before/after captures compare the identical disposable Chromium fixture at two exact commits:

- **Before:** `2a99dc8767ba8f012fad5001af43ff001557d6fb` (the Explorer PR's original main base, before #1721)
- **After:** `a57340026e90ea5f7a2732b7f7c84e7a02824de1` (the published #1721 head, integrated with that same base)

These are deliberately a feature-only visual comparison, not screenshots of the latest main. Later current main `70e93512907f943d1ce2dc31ae14bfb3abdd745b` was integrated into the final candidate separately; it adds migration 135 and does not change Explorer UI. Both runs used the same 1440×900 Chromium viewport and mocked workspace root `/workspace/quiet-labs`, with `src/components/ui`, `docs`, `README.md`, and a mocked Git change on `src/components/ui/Button.tsx`. No Synara server, production state, provider, account, or real project files were used. The right-click menu uses Synara's actual browser fallback and the actual `contextMenu.show` item list; it is a mocked filesystem/Git fixture, not a live desktop-native menu.

- `before-initial.png` / `after-initial.png`: initial tree.
- `before-expanded.png` / `after-expanded.png`: opened source chain and file rows.
- `before-copy-menu.png` / `after-copy-menu.png`: browser context-menu rendering.
- `before-interaction.webm` / `after-interaction.webm`: expand/compact and context-menu interaction.

The before version shows nested directory rows and only the old copy-path action. The after version shows the compact `src/components/ui` path, amber Git status, and a **Copy** flyout with relative path, absolute path, and file content. The after status is a mocked file-level change; the directory amber dot summarizes its changed descendant.

The temporary evidence-only Vitest/Playwright harness was not retained in the product source. Both temporary visual tests passed (1/1 each). Four static screenshots and two browser recordings are evidence of fixture rendering only; they do not claim full product, native desktop, or live workspace qualification.
