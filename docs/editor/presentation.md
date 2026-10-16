# Native editor presentation

The optional Code-OSS integration keeps Synara's interface. Editor and diff scrollbars use rounded, neutral thumb indicators with a wider drag target, transparent tracks, and no scroll shadows. The shared theme colors apply to both appearances; forced-colors uses system colors. Wheel, trackpad, keyboard and drag handling remain Monaco's; scrolling and caret movement are not given extra animations.

Opening a writable preview prepares the lazy editor while keeping the original preview visible. The existing Edit button shows preparation and can cancel it; changing files cancels the handoff. No content is copied into a competing save buffer. The syntax source preview transfers its visible line, fractional line offset, horizontal offset and available selection into the shared Monaco model before paint. Closing the editor restores the corresponding source viewport. Rendered Markdown, images and PDFs do not pretend to have a one-to-one code-line mapping.

There is no artificial delay or transform animation when entering editing. Reduced-motion mode suppresses the preparation indicator's spin and retains the existing editor reduced-motion policy. The pre-existing session writer, save conflicts, undo/redo and extension authorization remain authoritative.

## Design references

- [Apple HIG: Scroll views](https://developer.apple.com/design/human-interface-guidelines/scroll-views): familiar scrolling behavior and indicators without competing nested scrollers.
- [Apple HIG: Motion](https://developer.apple.com/design/human-interface-guidelines/motion): avoid unnecessary movement in frequent interactions; do not make people wait for animation.
- [Apple HIG: Accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility): preserve keyboard operation and respect reduced motion.

These principles are adapted to Synara, not a claim of native AppKit widgets, OS scrollbar-preference synchronization, VoiceOver certification, or universal extension compatibility.

## Acceptance repairs

The previous Prettier and local VSIX UI runs were intercepted by the post-startup feature tour. Their traces showed the tour over Settings before extension operations. The shared acceptance fixture now waits for the real announcement coordinator to settle and dismisses the feature tour using its visible Skip tour control. No app state is forged and no onboarding feature is disabled. File-chooser waits are bounded and awaited alongside the click so failures identify the blocked action rather than masking it with test teardown errors.

The editor keeps its component identity when a lazy import resolves. It measures long lines before restoring horizontal scroll and retains explicit handoff intent through React Strict Mode's temporary setup/cleanup cycle. The surviving editor completes focus once, without taking focus from another control. The tests leave Strict Mode and the browser's native EditContext enabled.

## Verified scope — 16 October 2026

[Final application acceptance](https://github.com/Emanuele-web04/synara/actions/runs/38897693468) passed on candidate `84c7dfa5da5aa3de4887d7dfcc09af29adffcd26`. Both light and dark journeys verified exact text, the original visible line, horizontal position, selection, focused input, one live editor, return to the source preview, reopening, actual disk autosave and native undo. The dark journey enabled reduced motion. A single keystroke verifies undo without imposing a different undo grouping policy on multiword input.

The same final candidate passed all three actual extension application journeys: marketplace installation and Prettier formatting with save/undo/redo, local VSIX validation/approval/configuration/replacement/removal, and the contributed Native Debug debugger. These tests use Synara, the real registry, actual extension packages and the production Linux sandbox, not mocked native APIs.

[Static and focused browser checks](https://github.com/Emanuele-web04/synara/actions/runs/38896884689) passed formatting, lint, web typechecking and all four focused browser files on the identical production implementation `ffdc2c80dc5b7bbc94cc4cd537ca75cbf2b5e4b0`. Its presentation test still contained the incorrect multiword undo-unit assumption, recorded as a failure rather than hidden. The final candidate changes only that test input and passed the corrected strict journey.

[Earlier integrated verification](https://github.com/Emanuele-web04/synara/actions/runs/38893543561) passed full workspace typechecking, native session/handoff/typography boundaries, and six real host tests including markdownlint, YAML language-server completion/diagnostics, debugger and OS isolation. [Native rail acceptance](https://github.com/Emanuele-web04/synara/actions/runs/38894723865) passed after selecting the specifically named debugger dialog rather than matching both it and a closing picker.

## Original screenshots and recordings

The before captures use `bdd2f92f4b1dbcd70aec1d5b0771b7a570cea545` with the same isolated fixture. The after captures use the final candidate above. Only original Playwright PNGs are checked in; they have not been retouched or replaced by rendered mockups. The long-line fixture deliberately tests both scroll axes. The provider-not-installed banner belongs to the isolated test environment and is retained in the images.

- Light appearance: [before](evidence/presentation-before-light-editor-scrollbar.png) and [after](evidence/presentation-after-light-editor-scrollbar.png).
- Dark appearance: [before](evidence/presentation-before-dark-editor-scrollbar.png) and [after](evidence/presentation-after-dark-editor-scrollbar.png).
- [Before recordings](https://github.com/Emanuele-web04/synara/actions/runs/38893890004/artifacts/12042733027), [after screenshots and recordings](https://github.com/Emanuele-web04/synara/actions/runs/38897693468/artifacts/12044786373), and [real extension UI evidence](https://github.com/Emanuele-web04/synara/actions/runs/38897693468/artifacts/12045350444).

The permanent `editor-presentation-acceptance.yml` workflow reproduces the presentation journey. Artifact retention is finite. This evidence does not certify all PR checks, macOS/Windows extension execution, packaged Electron extension lifecycle, a VoiceOver audit, or numerical scrollbar contrast compliance. PR 1 and main were not changed.
