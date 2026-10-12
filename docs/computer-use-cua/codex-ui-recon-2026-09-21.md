# Codex Computer Use — UI/service recon, 21 September 2026

Read-only inspection of the installed stack: `/Applications/ChatGPT.app`
(Electron `app.asar` + `Codex Framework.framework`) and
`~/.codex/computer-use/Codex Computer Use.app` (`SkyComputerUseService`,
23 MB arm64, full ObjC/Swift symbol table preserved). Nothing was modified or
executed beyond `nm`, `strings`, `otool`, `sips`, and private `CUICatalog`
reads. This document records the architecture Codex ships so Synara parity
work is designed from evidence, not guesses. Every Synara-side implementation
referenced here is independently written; no Codex source, assets, artwork, or
prompt text is copied into this repository.

## Process layout

- `SkyComputerUseService` — the driver/daemon. Hosts the Computer Use MCP
  server, a Messages MCP server, a stub Calendar MCP server, the app-approval
  store, the org-policy cache, an Appshot capture store, the agent cursor, and
  all overlay UI. It is a full `NSApplication` (`CUAServiceApplication`) with a
  menu-bar status item (`CUAServiceStatusItemView`).
- `SkyComputerUseClient.app` — `LSUIElement` background CLI client; the
  renderer-facing side of the client protocol.
- `CUALockScreenGuardian.app` — watchdog for locked-screen safety; the service
  talks to it through `CUALockScreenGuardianClientCallbackReceiver`.
- `Codex Computer Use Installer.app` — authorization-plugin installer.
- `Package_ComputerUse.bundle` — assets: `Assets.car` (cursor artwork, lens
  frames references, app icons, status glyphs), `LensSequence/Lens_frame_00-44.png`
  (45 × 48 px frames), `Appshot.wav`, `SkysightSummarizer.md`,
  `SkysightMemoryInstructions.md`, `AppInstructions/{Slack,Notion,Spotify,
iPhone Mirroring,AppleMusic,Numbers,Clock}.md`.

## Tool vocabulary (service-side MCP)

Exactly ten tools:

| Tool                       | Contract highlights                                                                                                                                   |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_apps`                | Running apps + anything used in last 14 days, with usage frequency                                                                                    |
| `get_app_state`            | Starts an app session if needed; returns key-window screenshot + AX tree; the contract requires calling it once per assistant turn before interacting |
| `click`                    | Click by element index or by pixel coordinates from the screenshot; button defaults left                                                              |
| `perform_secondary_action` | Invokes a secondary AX action an element exposes                                                                                                      |
| `set_value`                | Set value on a settable AX element                                                                                                                    |
| `select_text`              | Select text or place cursor before/after it; exact AX text incl. Markdown; prefix/suffix disambiguation                                               |
| `scroll`                   | Direction × number of _pages_                                                                                                                         |
| `drag`                     | Pixel-coordinate drag                                                                                                                                 |
| `press_key`                | xdotool `key` syntax: `a`, `Return`, `super+c`, `KP_0`                                                                                                |
| `type_text`                | Literal keyboard input                                                                                                                                |

Notable contract choices: per-observation element _indices_ (not durable
refs), a mandatory once-per-turn `get_app_state` freshness rule, `tool_search`
as the deferred-discovery escape hatch, and turn metrics
(`computer_use_mcp_time_to_first_get_app_state`, `..._to_first_write`,
`..._from_end_of_first_successful_get_app_state_to_first_write`).

Approvals: `AppApprovalStore` keeps `sessionApprovedBundleIdentifiers`,
`persistentApprovals`, `approvedBundleIdentifiers`; an org-policy cache gates
`allowComputerUse`, `allowPersistentApproval`, `defaultAppAccess`, and
per-bundle allow/deny lists; denial can arrive via MCP elicitation naming the
denied app.

## Agent cursor (`ComputerUse` module)

`ComputerUseCursor` + inner `Window` (borderless overlay; handles
`constrainFrameRect:toScreen:`, `activeSpaceDidChange:`,
`windowDidChangeOcclusionState:`, `windowDidChangeScreen:`) + `AppMonitor`
(AX observer on the target app: active state, open menus, pet launch).

Two render styles behind `SoftwareCursorStyle`:

- PNG arrow (`SoftwareCursor` in `Assets.car`: 200×230 black arrow, white
  outline, floppy-disk badge). Our compact cursor is an independent vector
  arrow — same generic pointer shape, hand-drawn path, no badge, none of the
  source artwork.
- `FogCursorStyle` — a SwiftUI `CursorView`/`FogCursorViewModel` drawing the
  pointer procedurally (`cursorRadius`, `fogRadius`, `cursorScaleAnchorPoint`,
  `fogScaleAnchorPoint`, `animatedAngleOffsetDegrees`, `loadingAnimationToken`).

Motion is a real animation system, not a teleport:

- `CursorMotionPath` builds bezier travel paths (`arcIn`, `arcOut`,
  `startControl`, `endControl`, `control1`, `control2`, `arcSize`, `arcFlow`,
  `straightPathDistanceThreshold`, `boundsMargin`, `candidateCount`,
  `clickAngle`, `rotatesAlongPath`, `angleChangeEnergy`, `maxAngleChange`,
  `totalTurn`, `staysInBounds`, `segments`, `length`).
- Per-channel spring physics: `springResponseScaler/Min/Max`,
  `springDampingFraction`, plus scoot channels — position, axis, base
  rotation, stretch (X scale, scale, pivot-X, min, squash-Y), rotation — each
  with `Response`/`DampingFraction` (`scootPositionSettleVelocity`,
  `scootDistanceThreshold`, `scootStretchMin`, `scootStretchXAmount`,
  `scootRotationMax`, `scootTiltAngle`, `terminalTangentBlendStart`).
- Early-ack: `CursorNextInteractionTiming` +
  `cursorMotionDidSatisfyNextInteractionTiming` — the next input fires once
  motion is committed far enough (`progressThreshold`, `distanceThreshold`,
  `closeEnough`), not when the animation finishes.
- States: `activityState` (`idle`/`loading`/`paused`), `isMoving`, `isPressed`,
  `isAttached`, `shouldFadeOut`, `wantsToBeVisible`, `velocityX/Y`,
  `currentInterpolatedOrigin`.
- The real cursor is composited out: `CursorCaptureConfiguration`,
  `CursorLayerGeometry`, `cursorDisplayLayer`, `cursorCaptureStream`
  (ScreenCaptureKit), `cursorObserver`, `cursorWindowID`,
  `cursorCaptureGeneration`, `cursorPositionInScaledCoordinates`.
- Delegate notifications: `computerUseCursorDidHide`,
  `computerUseCursorLocationDidChange`, `computerUseCursorDidFinishMove`;
  XPC `setComputerUseCursorLocationWithX:y:isActive:withReply:`.
- Feature flags: `feature/computerUseCursor`,
  `feature/detachComputerUseCursor` (detaches the cursor from the command
  palette).

User-interrupt detection: `userInteractionMonitor`,
`userInteractionDebounceDuration`, `userInterruptedControlledApp`,
`stoppedByUser`, `interventionReasonByTargetIdentifier`,
`userInterruptionDebounceTaskByTargetIdentifier` → `requiresRequery` (the
agent must refresh state via `get_app_state` before sending more actions).
Synara's input-stop path covers the same contract.

## Working indicator

`SkyLensView` (`SkyLensViewRepresentable` for SwiftUI): a 48 px CALayer
frame-sequence animation over `Lens_frame_00-44.png`, with `imageCache`,
`animationDriver`, `animationStartTime`, `currentFrameIndex`,
`imageLoadingTasks`, `isAnimating`, `isResettingToIdle`, `isTinted`,
`resetStartFrameIndex`. The lens is the glossy blue "agent is working" orb
seen in chat UI.

## Preview (Electron side)

The chat surface shows a live PiP. Locale keys:
`codex.remoteHostedPip.computerUsePreview` ("Computer Use preview"),
`browserUsePreview`, `localConversation.remoteHostedPip.{computerUse,
pictureInPicture,moveToFloatingWindow,moveToSidebar,sendToPet,show,hide,
hideForTask,hideForAllActiveTasks,showPictureInPicture,hidePictureInPicture}`.

Component (in `local-conversation-thread-*.js`): a `<video>` fed by
`videoStreams` (`MediaStream`s — real video for remote-hosted sessions) plus a
`pendingFrames` queue for pre-video frames; multiple presentations stack
vertically with per-presentation `maxHeight`.

Renderer → shell bridge (`window.remoteHostedPIP`):

- `interactWithPresentation(presentationID, interaction, isPrimary)` — user
  input forwarded into the presentation.
- `setNativeVideoReady(presentationID, ready)` — readiness handshake.
- `setPlacement(presentationID, placement)` — placement values observed:
  `home` (inline rail), `side`/`pinned`, `pet` (the ambient avatar), floating
  window.

Shell → renderer channels:
`remote-hosted-pip-{active-thread,browser-frame-state,content-layout-state,
host-layout,task-state}-changed`, `remote-hosted-pip-video-frame`,
`remote-hosted-pip-video-error`. The main process also runs a
`remoteHostedPIPContentHost` publisher that anchors the PiP to the
avatar-overlay mascot with spring motion (`animationSpring`,
`presentationScope: "all"`), and honors a `alwaysHidePictureInPicture` setting
and the `cuaPIP` feature flag.

Approval card keys: `composer.computerUseAppApproval.{action.approve,
action.alwaysApprove,disclosure,title.chatgpt}` — Approve / Always-approve /
disclosure copy, per target app.

## Recording/replay

`RecordAndReplayOverlayPanel` + `RecordAndReplayOverlay{Content,Container}View`
private classes in the service app module; `AppshotCaptureTransitionOverlayWindow`
(plus `NonanimatedTextLayer`/`NonanimatedGradientLayer`) for the screenshot
transition; `AppshotCaptureStore` (`captures`, `missing`, `waiting`,
`captureNotFound`, `beforeDelivery`) for the capture pipeline. Recording
controls exist in the service UI independent of the agent.

## Skysight (passive memory)

`SkysightSummarizer.md` is the memory-writer prompt: 10-min and 6-h rollups of
the event stream into YAML-frontmatter memories (`title`, `description`,
`applications`, optional `suggestion` of `skill`/`automation`). Heavy
prompt-injection hardening: observed content is untrusted, sticky taint, no
directives in output, no URLs/links, local-path citations only, sensitive
content minimized, authority-boundary claims reduced to generic wording.

## Per-app playbooks

`AppInstructions/*.md` — short per-app operation notes shipped to the agent
(Slack: `set_value` vs `type_text` send semantics; Notion: block model and
`<Return>` rules; Clock: timer/alarm flows). This is the same idea as
`computer_help`'s situational chapters; a per-app variant is a reasonable
follow-up (fetch by frontmost bundle id).

## Delta vs Synara (as of `agent/computer-use-preview`)

Already ahead of Codex: stable identity-keyed refs (vs per-observation
indices), `computer_run` v2 (conditionals, observation steps, absent waits),
honest delivery verdicts, richer approval grants (per-class + TTL + scope),
the native frame tap, the ambient popover session machine.

Gaps worth closing (in priority order; 1–3 landed 2026-09-18):

1. ~~Cursor motion~~ — done: the compact cursor glides between dispatches and
   pulses on press, visual-only (native rev 21).
2. ~~Working indicator~~ — done: sonar-ping status orb while the agent is
   active, plus the cursor halo glide in the preview.
3. ~~Preview placement~~ — done: the card detaches into a draggable floating
   window with per-thread positions and re-dock.
4. Preview interactivity — their PiP forwards input; ours is view-only.
   Click-to-activate-the-window is the safe first interaction.
5. Per-app playbooks — their `AppInstructions` bundle; `computer_help` already
   has the retrieval shape.
6. Approval card app icon — theirs shows the target app's icon.
