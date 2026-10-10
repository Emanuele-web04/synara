# Devin Fusion picker evidence provenance

This directory records evidence for local PR #1419 work. It does not claim full-viewport or live-Devin qualification.

## Captures and source state

- **Pre-feature baseline — `main-before.png`:** 333×720 PNG captured from exact clean main source `3e3e41c3b312ad95f62c33b155354b099bf36e2e` in a detached baseline worktree. The unmodified `ComposerModelPicker` rendered with a temporary test-only fixture: Devin status ready and Fusion option, no runtime-pairing descriptor (baseline did not support it). The throwaway test file's SHA-256 was `3ea823bd5916620ece5da962d9d9053c1cc92f27cbe6ab37fcf71d32ace3c41d`; its worktree was removed after capture. Screenshot shows Fusion row and no Lead/Effort/Speed/Sidekick controls.
- **Feature before speed selection — `before-fast-selection.png`:** 333×720 PNG from the feature test run at 19:54 on 2026-10-10, source commit `1069467946793ae587d1771e76c4b6ec17ef843f` (then-main `f403a421` was not yet merged). It shows the feature picker with Standard speed, before choosing Fast. It is not the pre-feature baseline.
- **Feature after/menu/star screenshots — `after.png`, `speed-menu.png`, `starred.png`:** 333×720 PNGs captured in the browser run at 20:07 on 2026-10-10, source HEAD `1a5d64964bbb205351b6a1319c5e03a22a3de1bc` (latest main `3e3e41c3b312ad95f62c33b155354b099bf36e2e` included). No dirty source overlay; the browser test supplies a synthetic `ProviderModelDescriptor` fixture (the runtime pairing list), not a live Devin catalog. The browser-test blob is `8ded0fd3ac0b0c12e795df38576527619a084277` at screenshot capture HEAD and final application source.
- **Interaction video — `interaction.webm`:** 6.96s Playwright video, file timestamp 19:46 on 2026-10-10. Product/source base at capture was feature worktree HEAD `c443a6611e941a1c2f16d2aeff65b83059c01fd7` (then-main `70e93512907f943d1ce2dc31ae14bfb3abdd745b`); its browser scenario was an uncommitted, dirty test-only overlay. The exact dirty tree was not saved. That scenario was later committed in `1069467946793ae587d1771e76c4b6ec17ef843f`, but that later commit is not the video capture SHA. It embeds a synthetic runtime pairing descriptor and records Fast selection/star interaction; it predates later main updates and is component-level, not full viewport.

The 333×720 captures show substantial blank area because this is a focused component test. In `starred.png`, the long pairing name is ellipsized in the narrow starred-model row; the star and pairing controls remain visible. Treat this as an open layout review point, not polished-layout qualification.

## Qualification, separated by source

- Broad `fmt:check`, lint, server-sync-fs check, workspace typecheck, and focused web/server/shared tests passed at merge commit `629bfb97a095c9ac05dbd61c0abc6e6f9361052f`, parents feature `1069467946793ae587d1771e76c4b6ec17ef843f` + then-main `f403a421e76a44b0eca785e1077f6768772f1bb0`. Log: `/tmp/synara-cleanup-20261010/logs/fusion-picker-final-checks-latest-main.log`. **These broad results do not qualify later main `3e3e41c3b312ad95f62c33b155354b099bf36e2e`.**
- Main `3e3e41c3b312ad95f62c33b155354b099bf36e2e` was merged locally at `b20a883f678d299f045a9302582278afdfdc029f`; the 71-path turn-claim/projection, subagent, and queued-turn delta was inspected, with no picker-file overlap. No broad suite was rerun afterward.
- The ComposerModelPicker browser suite separately passed 31/31 at source HEAD `1a5d64964bbb205351b6a1319c5e03a22a3de1bc` with latest main included. Log: `/tmp/synara-cleanup-20261010/logs/fusion-picker-browser-current-head.log`. Final application source remains identical; later commits only update evidence documentation.
- At static-gate source HEAD `bc96bb71ed28b89674c2e787d2eaf4b909107580` (current main `3e3e41c3b312ad95f62c33b155354b099bf36e2e` included), `bun run fmt:check`, `bun run lint`, `bun run server-sync-fs:check`, and `bun run typecheck` passed: 877 lint warnings / 0 errors and 7/7 typecheck tasks. Log: `/tmp/synara-cleanup-20261010/logs/fusion-picker-current-main-static-gates.log`. These current-main static gates do not change the earlier focused web/server/shared suite scope above.

## Boundaries

No live Devin process or full application viewport was used. No push, publication, PR update, GitHub write, or merge to main was performed. Latest original PR #1419 head `a63c17b04fba1a3886c5db6b74f31744a8bb720a` is an ancestor of the local branch. #1301 remains separate.
