# PR #1137 file-manager label visual evidence

These matched Chromium captures show the file-action menu for `EditedFileRow` before and after the platform-aware file-manager label change. They are supplied for review context, not as native desktop validation.

## Source and fixture

- Candidate feature commit: `ccb40a0f0fe89eafee6650e7022f048895b5d42a`
- Candidate integration at capture/requalification: `678e6c2b391dd1e7b162bd051ab95aec10930855`
- Current main used for qualification: `f403a421e76a44b0eca785e1077f6768772f1bb0` (includes merged #1778 revert)
- Fixture: `apps/web/src/components/chat/EditedFileRow.browser.tsx`, Chromium browser test, fixed browser viewport and row fixture; screenshot taken from the menu in the test UI.
- Browser: Chromium in the repository's Vitest browser setup. The test uses `navigator.platform` to compute the label; this capture shows Linux wording.

## What is visible

Before, the menu item is labeled **Files**. After, the longer label is **File manager**. The capture's narrow menu/button truncates the after text to **“File man…”**. Do not read this evidence as proof that the entire label is visible at this width; it is included so reviewers can evaluate the actual clipping. The rest of the menu layout appears unchanged.

## Limits

- This is browser UI evidence, not a native Finder, Explorer, or Linux file-manager invocation test.
- The screenshot is a single fixture/viewport and does not establish that all labels fit in all layouts.
- This static label change does not alter interaction behavior; no interaction video is included.

Files: `before.png` and `after.png`.
