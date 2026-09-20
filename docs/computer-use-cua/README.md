# Computer Use: current implementation and qualification

This directory contains implementation notes and historical experiments. It is
not a release certification. Results belong to the exact application, driver
revision, platform and provider named in each report; an older passing fixture
does not qualify the current branch.

The current macOS driver is Cua 0.28.2 with Synara native revision 31. The
[release manifest](../../packages/shared/src/cuaDriverRelease.json) is the source
of truth for source, patch checksum and Rust version. Packaging must verify the
staged artifact against that manifest. The checked-in
[patch](../../apps/desktop/patches/cua-driver/0001-synara-native.patch) and
[upstream license](CUA-LICENSE.txt) preserve provenance. Linux provisioning uses
the upstream, unpatched driver and does not inherit macOS guarantees.

## Current behavior

- Synara owns provider capability, task consent, targeting and cancellation.
  The authenticated desktop host owns the native child process. A socket path
  or a claimed bundle identifier alone does not grant access.
- All nine provider adapters have Computer integration. Live task completion
  across all nine providers on the current packaged build remains unverified.
- Computer tools are conditional on the session's capability. Pi installs no
  Computer descriptors in disabled sessions and retains its existing specialist
  forwarders while enabled. Shared host guidance retains a short discovery sentence; this is
  not a claim of literally zero added context on every provider.
- Routine actions share task consent where the selected approval mode requires
  it. Full access does not authorize visible use. Foreground native actions and
  visible browser preparation require an explicit visible-use request in the
  latest user-authored message. Negative or ambiguous requests remain
  background. This is conservative text matching, not a general natural
  language authorization system.
- Browser work can use a driver-owned isolated Chromium profile. Reusing the
  same browser executable does not attach to the user's profile or cookies.
  Existing-profile attachment is unsupported in this embedding.
- The advertised computer_run tool batches known desktop steps. Exact-tool
  help provides schemas on demand. Specialists without batch steps require a
  direct gateway client or Pi's compatibility forwarders; a shared provider
  route remains missing. Help lookup does not install a provider tool.
- State reads default to bounded text/element data without an image. Actions
  still include a post-action screenshot by default; short batches can omit
  intermediate images and finish with fresh state or a screenshot. Internal
  text-field readback disables screenshot capture. Unknown dispatch
  remains unknown until there is action-specific evidence. Successful dispatch
  or a changed tree alone is not proof that the requested task succeeded.
- [Preview](native-preview.md) shows the addressed window or browser tab. It is
  view-only and has a native macOS stream plus a still-image fallback.
- The local audit log covers mutations, not every tool call. It has no
  user-facing history viewer. Recording/replay, durable per-app grants and
  manual re-arm APIs were removed; their documents are historical.

## Permissions and interruption

Computer and AppSnap reuse the same desktop permission service and native setup
guide. Computer setup requests Accessibility and Screen Recording. Passive
checks do not request grants; active setup rechecks in a fresh helper and
advances to the next missing permission. UI state refreshes on permission events
and return from System Settings. Rebuilds still require verification of the
running bundle's signing identity; permanent TCC persistence is not promised.

Physical Escape additionally depends on Input Monitoring for the native listener.
The current Computer setup does not establish that third grant. Without it,
Escape may be unavailable even when the two Computer setup checks are green.
The visible Stop path remains separate. Escape currently interrupts the host
transport and releases held input without retiring the native generation; no
manual re-arm is required. Native proof that a running input loop stops after
Escape is still required. Ordinary physical typing/clicking in a target app does
not yet implement a complete human-takeover and fresh-observation gate.

## Qualification still required

1. Current signed, packaged macOS artifact: background action plus readback,
   cancellation, recovery, permission revocation, focus and Dock/window checks.
2. Action-specific proof for browser/native mutations that still return
   dispatched-unknown, without reclassifying dispatch as verified success.
3. Nine fresh provider sessions with a small real task and cancellation/recovery.
4. Linux package provisioning/startup and real X11/Wayland tests. A manually
   connected standalone host is not proof of packaged Linux support. Validate
   the existing still preview before adding another capture implementation.
5. Model-facing space operations and ownership: currently absent. Existing
   cross-Space refusal tests do not certify an agent-owned space broker.
6. Browser-heavy performance benchmarks with fresh-thread and complete-evidence
   gates. The live SQLite database is exclusively owned by the application;
   collect through its diagnostic APIs or an owner-created coherent snapshot.
   Do not copy live DB/WAL files separately or infer zero usage from empty reads.
7. Audit history UI, first-run guidance, broader app playbooks, browser-call
   presentation and visible preview failure states.

## Historical references

The [initial qualification](qualification.md),
[integration record](integration-refresh.md),
[capability audit](capability-audit-2026-09-16.md) and files under evidence/
retain their original scope and dates. Treat descriptions of removed features
or earlier revisions as historical. Check current source and the release
manifest before following an old operational recipe.
