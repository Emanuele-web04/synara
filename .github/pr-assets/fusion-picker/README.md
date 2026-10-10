# Devin Fusion picker evidence provenance

This directory documents local evidence for PR #1419. It is not a claim of full UI or live-Devin qualification.

## Source revisions and captures

- **Actual pre-feature baseline:** `main-before.png` captured at exact clean source SHA `3e3e41c3b312ad95f62c33b155354b099bf36e2e` (current main; baseline worktree was detached at this commit). The screenshot came from a component browser test added only in the disposable baseline worktree, not committed to the candidate. That test rendered the unmodified `ComposerModelPicker` from main with the common fixture (Devin provider ready; Fusion model option; no runtime pairing descriptor). Temporary test SHA-256: `3ea823bd5916620ece5da962d9d9053c1cc92f27cbe6ab37fcf71d32ace3c41d`. The captured image shows the Fusion row without Lead/Effort/Speed/Sidekick controls.
- **Candidate pre-Fast image:** `before-fast-selection.png` captured at feature commit `1069467946793ae587d1771e76c4b6ec17ef843f`, before changing speed from Standard to Fast. This is not the pre-feature baseline; `main-before.png` is.
- **Candidate post-selection images:** `after.png`, `speed-menu.png`, and `starred.png` captured by the Devin Fusion browser scenario at feature commit `1069467946793ae587d1771e76c4b6ec17ef843f`, after a test-only overlay to that commit's browser test. Overlay SHA-256: `8d7ea009d0285f42fcf5930c6c394e2fcec000d3e29ff6781d780fde0c3ec6cf`. The overlay adds synthetic runtime descriptor data so the fixture can display pairing controls. It changed only the test harness; it did not alter the picker implementation. The picker test source blob at feature commit `1069467` is `8ded0fd3ac0b0c12e795df38576527619a084277`; its final-source blob is identical. These captures are component-harness output, not a live Devin catalog.
- **Interaction video:** `interaction.webm` (6.96 seconds) recorded by Playwright while running the same feature browser test at feature commit `1069467946793ae587d1771e76c4b6ec17ef843f`, before later main movement. It shows the Fast-selection and starring flow. It was not recorded at latest-main source and does not represent a full application viewport.
- All PNGs in this directory use the same **333 × 720 px** browser screenshot viewport. The component appears with substantial blank space because this is a focused component test.

## Qualification provenance

- Broad `fmt:check`, lint, server-sync-fs, workspace typecheck, and focused web/server/shared tests passed at candidate merge commit `629bfb97a095c9ac05dbd61c0abc6e6f9361052f`, whose parents are feature `1069467946793ae587d1771e76c4b6ec17ef843f` and then-main `f403a421e76a44b0eca785e1077f6768772f1bb0`. Full output: `/tmp/synara-cleanup-20261010/logs/fusion-picker-final-checks-latest-main.log`.
- Current main later advanced to `3e3e41c3b312ad95f62c33b155354b099bf36e2e`, merged into the feature at `b20a883f678d299f045a9302582278afdfdc029f`. Its 71-path turn-claim/projection, subagent, and queued-turn delta was inspected; no Fusion picker files overlap. **The broad static and focused suites above are not qualified against this later main.**
- The `ComposerModelPicker` browser suite separately passed 31/31 at final source HEAD `1a5d64964bbb205351b6a1319c5e03a22a3de1bc` (latest main included); output: `/tmp/synara-cleanup-20261010/logs/fusion-picker-browser-current-head.log`.
- Final HEAD's direct parent is evidence commit `b20a883f678d299f045a9302582278afdfdc029f`. The current main SHA `3e3e41c3...` is the merge-base and a parent of `b20a883f`.

## Limits

No live Devin process was started. No full application viewport was captured. The model label in the narrow starred row is visibly truncated, while its star and pairing controls remain visible; this requires review and is not described as polished. No push, publication, PR update, or merge to main was performed. PR #1419 remains open at its original remote head. #1301 remains separate.
