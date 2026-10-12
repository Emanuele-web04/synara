# PR #1137 file-manager label visual evidence

These matched Chromium captures show the `EditedFileRow` file-action menu with the old and new generic-platform labels. They are review context only, not native desktop validation.

## Capture provenance

- **Git HEAD when both screenshots were captured:** `ddf2b86378c90ea2fd9c30cc92927413d94bff79`.
- Both captures came from that same commit base. The checkout had the #1137 feature work present and temporary, uncommitted capture edits; neither screenshot was captured from `f403a421e76a44b0eca785e1077f6768772f1bb0`, `3e3e41c3b312ad95f62c33b155354b099bf36e2e`, nor the later qualification tree.
- For **before.png**, the capture-only edit temporarily changed the generic manager name in `apps/web/src/lib/fileManagerNaming.ts` from `File manager` to `Files`.
- For **after.png**, the generic manager name was restored to `File manager`.
- Both captures also used a temporary `page.screenshot(...)` line in `apps/web/src/components/chat/EditedFileRow.browser.tsx`; it was removed after capture. Neither temporary edit is in the committed candidate.
- Capture runner: Chromium through the repository's Vitest browser setup, using `apps/web/src/components/chat/EditedFileRow.browser.tsx`, Linux `navigator.platform`, and the same row/menu fixture and viewport.

This capture SHA is distinct from the later source/test qualification. **Qualification tree:** `4110ffad7e2d8eafc985ae346d904de3a4683092` (feature plus latest integrated main `3e3e41c3b312ad95f62c33b155354b099bf36e2e` and the shared group-folder-reveal cleanup). Capture assets predate and are not represented as a rendering of that qualification tree.

## What is visible

Before, the menu item reads **Files**. After, it is visibly truncated to **“File man…”** at this narrow fixture width. Do not claim the complete label is visible here; reviewers should assess the clipping. The remaining menu layout appears unchanged.

## Limits

- These are browser screenshots, not native Finder, Explorer, or Linux file-manager invocation tests.
- This one fixture/viewport does not establish that the label fits in every layout.
- This is a static label change with no interaction behavior change, so no interaction video is included.

Files: `before.png` and `after.png`.
