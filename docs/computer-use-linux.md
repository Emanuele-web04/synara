# Computer use on Linux

How the server chooses and hosts a Linux desktop backend. The Cua host (the
macOS beta, and observation-only on Linux) is described in
[computer-use-cua](computer-use-cua/README.md); the native Linux backends share
Synara's computer-use core with it and are documented here, one section per
backend.

## Seat policy

One rule outranks every other decision here: the agent never drives the seat
the human is sitting at. A Linux backend gives the agent a cursor and an input
path of its own and leaves the human's pointer, keyboard focus and active
window untouched, or it does not exist. No shared-seat backend is in the tree,
so none can be selected, forced or fallen back to.

## Core seams

The core is shared with the macOS Cua backend and lives in
`apps/server/src/computer/`. The seams a Linux backend plugs into:

- `ComputerBackend.statusAvailability()`: the passive status read for a
  backend whose desktop boots on demand. `ComputerManager.getStatus` uses it
  for every status read when the backend has one, so the settings screen's
  poll never boots or respawns a desktop; the desktop starts again on the next
  real use or from Set up. Backends without it keep the existing behaviour
  (the passive probe before engagement, the establishing read after).
- `ComputerBackend.resetInputDelivery()`: the full seat hand-back the manager
  runs on every desktop lease change and release, where `clearFocusWindow`
  alone would clear only the aim. A compositor seat outlives the thread that
  drove it.
- `ComputerBackend.dedicatedSeat`: the opt-in a backend sets when the agent
  drives the desktop through a seat of its own. The computer service registers
  the manager's `ComputerGuidanceProfile` (dialect plus this flag) for the
  process, because the session-start guidance is rendered by provider adapters
  that never see the backend. A backend that sets nothing keeps the Cua host's
  wording unchanged.
- `ComputerBackend.textRangeSelection`: `false` refuses `computer_select_text`
  in the manager before the lease is claimed and the window restacked and
  aimed for a dispatch the backend would refuse anyway.

Optional performance and reliability hooks. Each is absent on the Cua backend,
which keeps its behaviour exactly:

- `launchApp` results may name `appId` (the desktop or flatpak id windows
  report as `appName`) beside `pid`. Window readiness then accepts a window of
  that app, or of the launch name, when none carries the pid, because a
  flatpak or `gio launch` wrapper hands the window to another process. Without
  `appId` the pid rule stays exact.
- `writeClipboardForPaste(text)`: a single-use clipboard offer
  (`wl-copy --paste-once`) whose `consumed` promise settles once the paste
  target read it. Paste restores the human's clipboard then, bounded at
  `COMPUTER_PASTE_CONSUME_TIMEOUT_MS` (2 s), instead of after the fixed 250 ms.
- `captureLuma(request)`: raw 8-bit luma for the scroll-measurement baseline
  nobody looks at. Same geometry and scale as `captureScreenshot(request)`,
  luma as `decodePngLuma` computes it; a failure falls back to the PNG
  baseline.
- `defaultObservationRegion()`: the output an untargeted model observation
  photographs when no window holds the agent's focus, instead of the whole
  multi-monitor workspace. The backend's own `getState` screenshot should
  scope the same way.
- `ComputerStreamFrame.mimeType`: a preview frame may be `image/jpeg`; the
  frame envelope carries the type and the pane decodes it as such. Model
  screenshots stay PNG. `StillFramePublisher` capture callbacks return
  `{ data, mimeType }` for a non-PNG still.
- The `desktop-gone` backend event: the desktop the backend was bound to has
  ended for good (its compositor exited). The service re-runs selection
  and swaps in a different tier; an explicit override is never re-selected.

## Backend selection

`Layers/ComputerService.ts` resolves the backend at startup, with no
fallback in any direction once a choice is made. On Linux selection asks the
session bus, so it runs off the startup path: the service waits at most
`COMPUTER_SELECTION_STARTUP_BUDGET_MS` (1.5 s, shared with the passive probe),
and past that starts the manager on a slot (`switchableComputerBackend.ts`)
that reports `checking` availability and takes the selected backend when
selection answers. The guidance profile is registered again when it does.

1. `SYNARA_COMPUTER_BACKEND`, when set. `fake` and `cua` are platform-neutral;
   the Linux tiers are refused off Linux. An unknown value is not ignored: it
   becomes an unavailable backend whose message lists the names that exist, so
   a typo never boots a different backend and looks like the variable does
   nothing. A forced backend that fails stays failed and says why.
2. The Linux detection tiers in `linuxBackendSelection.ts`, best desktop first.
   `LINUX_BACKEND_CHOICES` and the service layer's `LINUX_BACKENDS` factory
   table are filled by the backend layers; each backend registers its choice,
   its detection tier and its constructor together, so the three cannot drift.
3. The Cua host, on macOS or wherever `SYNARA_CUA_HOST_SOCKET` names an
   endpoint. It comes after the Linux tiers on purpose: the desktop app
   configures its host socket on Linux too, so socket presence cannot be what
   decides between a compositor backend and the observation-only Cua host.
4. Otherwise an unavailable backend that says why.
