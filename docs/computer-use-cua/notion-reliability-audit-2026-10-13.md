# Computer Use reliability audit: Notion and Cua

## Decision and implementation plan

Keep Cua as the native actuator and retain Synara's task consent, exact-target,
ownership, interruption and cancellation boundaries. The app already executes
Cua's Rust driver; it is not an instructions-only implementation. Replacing the
integration with upstream defaults would discard these boundaries without a
measured speed benefit.

The implementation follows three independent units, then a shared verification
pass:

1. Correct approval expiry and listener readiness recovery.
2. Correct delivery evidence and progress accounting; do not replay uncertain
   input or treat a changed screenshot as proof of a requested effect.
3. Expose Cua's existing image/file clipboard inputs through native paste, with
   workspace containment, bounded preservation and cancellation-safe cleanup.

## Reported issues and findings

| Report                                                                  | Confirmed owner and diagnosis                                                                                                                                                                                                   | Change or retained boundary                                                                                                                                                                                                                                                   |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Foreground approval becomes unavailable                                 | `ComputerApprovalGate` cached unanswered timeouts as a declined task grant.                                                                                                                                                     | Expiry returns `approval_expired`, `not-dispatched`, `retryable:true`; a later request can present a new card. Explicit decline/cancellation remains declined for that turn.                                                                                                  |
| Two Notion windows produce `same_pid_keyboard_ambiguity`                | Revision 39 already filters accessory windows using native metadata. A 33 px height alone does not prove that a window cannot receive keyboard input.                                                                           | Keep exact keyboard destination validation. Use a proven semantic target or approved foreground operation. Do not close the user's windows or weaken targeting based on size.                                                                                                 |
| Text appears despite “delivered 0/379”                                  | Native AX value-length differences were interpreted as delivered character counts before checking whether the editor exposes reliable insertion evidence. Rich editors can split blocks, transform text and replace selections. | Backport upstream control-character handling and require insertion-prefix evidence for native partial delivery. Web-content readback cannot justify partial-count errors or suffix replay. Unverifiable delivery remains explicitly uncertain.                                |
| Repetition guard blocks useful actions                                  | Gateway ignored stable explicit verification and measured scroll travel; read-only batches also accumulated mutation history.                                                                                                   | Verified predicates clear the addressed window only; measured nonzero travel permits continued scrolling; read-only batches and batches whose conditional mutations all skip do not arm the input guard. Alternating actions is not a recovery mechanism.                     |
| Escape/human-input listener does not start                              | Native tap errors already retry. A helper that never emits readiness/error could leave the host waiting indefinitely.                                                                                                           | Add a bounded readiness watchdog using the existing restart backoff; ignore late events from retired helpers. Input remains paused until readiness and required observation are established.                                                                                  |
| Notion comments ignore `set_value`; Mac keys and automatic lists differ | Semantic AX writes do not necessarily trigger a web editor's keyboard/input handlers. Home/End and editor autoformat are application behavior.                                                                                  | Keep exact app-effect verification and explicit keyboard/paste routes. Never silently replay through another route after uncertain input. Re-observe after image/layout changes before coordinate actions.                                                                    |
| Scroll is slow and AX elements are incomplete                           | Scroll already supports image-based measurement. The displacement bound is half the current frame, not a constant 480 px. A partial AX tree cannot safely be treated as complete.                                               | Preserve overlap for correlation and coordinate accuracy; consume actual measured travel in the gateway. Reuse returned observations, short batches and semantic refs where present. Do not synthesize missing refs or claim an unmeasured speedup.                           |
| Images require AppleScript and destroy the clipboard                    | Upstream `clipboard_write` already accepts `image_path` and `file_path`; Synara exposed text only, and text paste could overwrite unsaved non-text clipboard contents.                                                          | Add image/file inputs to `computer_paste` and batch paste. Validate every batch file before any input. Preserve native clipboard formats without returning them to the model; restore only if the clipboard still belongs to that paste. No AppleScript workaround is needed. |

## Cua coverage and alternatives

The driver manifest and patch remain authoritative. This work advances native
revision 39 to 40 while retaining the pinned Cua 0.28.2 source. The relevant
upstream text correction is visible in
[upstream `type_text.rs`](https://github.com/trycua/cua/blob/97fea581e214dbec0a80132945886409aa5c3874/libs/cua-driver/rust/crates/platform-macos/src/tools/type_text.rs).
The existing file and image inputs are documented in
[Cua's MCP tools reference](https://github.com/trycua/cua/blob/main/docs/content/docs/reference/cua-driver/mcp-tools.mdx).

Synara already uses native semantic input, exact element tokens, state/settle
observations, screenshots, menus, selection, window management, scrolling and
the driver's CDP browser tools. Conditional settle and identical-image payload
reuse are enabled by default. The gateway exposes short batches and on-demand
specialist schemas rather than injecting the complete catalog into every turn.

Existing-profile CDP attachment remains unavailable because its upstream consent
receipt flow is not hosted by this embedding. An isolated browser is supported,
including file upload, but is not a transparent replacement for a logged-in
Notion desktop app or personal browser. Driver recording/replay, upgrades and
internal lifecycle tools are not missing native editing primitives.

Eager driver warming remains opt-in. There is no equal-workload live benchmark
proving that it, a larger scroll cap, or stock upstream defaults improve this
Notion task. None is enabled on that assumption.

## Clipboard boundaries

Native attachment paths must be absolute regular files inside the caller's
canonical workspace. Browser upload reuses the same containment helper. Native
code rechecks canonical identity before reading files; this is not a general
filesystem sandbox or a guarantee against every concurrent filesystem race.

Preservation uses opaque, single-use tokens and bounded in-memory data. The
token is allocated before dispatch so a lost acknowledgement does not lose the
cleanup handle. Restoration is tied to the owning task and native generation;
it cannot start a replacement driver or authorize new input after Stop.

Native paste reports `clipboardRestored`; a newer human copy must remain in
place. macOS has no cross-process compare-and-swap for the pasteboard, so change
tracking is guarded restoration, not an absolute atomicity guarantee. Driver
crashes, unavailable native cleanup and application-specific paste consumption
remain runtime qualification cases. A successful paste dispatch is not proof
that Notion finished uploading or saving the attachment.

## Verification record

Regression tests were first run against the unchanged owners for approval
expiry, stalled listeners, explicit verification, measured scrolling, read-only
batches and unreadable clipboard preservation. They failed at the intended
behavioral assertions. Negative verification controls continued to pass.

Source checks use Node 24.21.0 and Bun 1.4.2. The final broad run completed
after the AX-echo classification repair:

| Check                            | Result                                                                                                                                                                                  |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun run fmt:check`              | Passed.                                                                                                                                                                                 |
| `bun run lint`                   | Passed: zero errors, 910 repository-wide warnings; synchronous filesystem budget passed.                                                                                                |
| `bun run typecheck`              | Passed in all seven workspaces.                                                                                                                                                         |
| `bun run windows-runtime:check`  | Passed; source boundary validation, not packaged Windows execution.                                                                                                                     |
| `bun run test --continue`        | Exit 0: 16,739 passed, 39 skipped, six successful workspaces, no cache hits (8m 56.976s).                                                                                               |
| Gateway and progress-guard tests | All 247 cases passed, including conditional batches with no executed mutation. The new attribution cases first failed at three expected assertions while five negative controls passed. |
| `git diff --check`               | Passed.                                                                                                                                                                                 |

After the broad run, independent review corrected only the backend test
fixture to return explicit native `set_value` AX uncertainty, instead of the
generic fallback response. The complete backend file then passed all 162 tests
again (18.73s); production source stayed identical to the successful broad run.

The broad run includes all 155 desktop driver-host tests, 13 listener tests,
162 Cua backend tests, 154 manager tests and 42 browser-tool tests. Artifact
provenance (21) and cache-key tests (19) also passed. The build benchmark's
prepare-only regression exposed a working-tree/archived-input mismatch: its
comparison now reads the committed candidate manifest, retaining equal source,
version, native revision and Rust version checks for the two archived builds.

The follow-up review also corrected implicit-window and batch attribution.
Batches whose conditional mutations all skip no longer accumulate uncertain-input
history. The third such batch failed before repair; the final gateway and
progress suite passes all 247 cases. Audit delivery classification is unchanged.
Progress history retains a hashed actual-window association only while every
recorded mutation agrees. Missing or mixed identities remain unverified. Inline
batch verification counts only after the last mutation on the same known window;
it never upgrades the audit's delivery classification.

Native qualification used the final revision-40 patch: the macOS driver builds
with locked, offline Cargo dependencies and its executable reports Cua 0.28.2.
Twenty-one text tests, four core clipboard tests, four macOS clipboard/path tests
and one host-admission test passed. Two of the macOS tests use real AppKit
pasteboards with unique names. Fresh extraction plus the exact provisioning
patch command applies both patches without fuzz, offsets or rejected hunks;
all final edited native files match the tested source and both manifest patch
checksums match. Additional native tests cover exact document scoping (12),
web-tree collection (3), input targeting (57), exact targets (14), window
listing (4) and foreground admission (7). These focused sets are separate
from real Notion qualification.

The follow-up native review found two additional AX evidence gaps: interrupted
semantic typing bypassed the web-content trust boundary, and unreadable
progressive insertion could fabricate a zero-character delivery count. Both
regressions failed before repair. The shared semantic result classifier now
checks surface trust while the exact AX element remains valid, preserves
accepted-character counts as dispatch evidence, and withholds retry offsets
when delivered characters cannot be proven.

The live comment loss also exposed a legacy label-target verification defect:
`webSetValue` could override the native web-content uncertainty when a fresh
AX echo matched the requested value. That echo is not DOM or persistence
evidence. The final narrow correction preserves the native verdict; retained
element refs already followed that conservative path. Both label-based typing
and replacement regressions failed before repair; all 162 backend tests pass.
A live background label-based comment-editor write at 18:13:59 UTC then
returned `unverifiable` / `dispatched-unknown` despite the fresh AX echo.
The audit records exactly one mutation; nothing was submitted or retried.

The inherited assertion-free `terminal_flag_routes_past_ax_path` test hangs
against invalid PID -1 and was excluded after interruption. The CI test that
changes the general clipboard was also excluded; the isolated AppKit fixtures
provide clipboard evidence without replacing the user's clipboard.

## Local Notion qualification

A separate source-built **Synara Cua** instance uses a fresh home and Electron
profile under `/private/tmp/synara-notion-e2e-20261013`. Web, server, desktop and
native builds completed. The native artifact follows the pinned-source
provisioning path with validated provenance. Existing application grants,
databases and running production instances were not reset.

All writes are confined to the new private page **Synara Computer Use — E2E
test — 2026-10-13**. Existing pages, databases and tabs remain intact. The page
and initial synthetic paragraph were created through the operator's Computer
Use connection; setup alone is not Synara runtime qualification. Subsequent
editing tests use a real Codex / `gpt-6-astra` turn through Synara's normal
owner RPC, authenticated gateway, desktop bridge and native Cua driver. The
provider is the isolated UI's observed default, not a test-time substitution.

The operator granted Accessibility, Screen Recording and Input Monitoring,
and explicitly authorized sending Notion screenshots and accessibility data to
the configured Codex provider. The initial permission refusal and subsequent
automatic approval-review block are historical setup evidence, not outstanding
permission requests.

### Defects exposed by the real application

The first screenshot showed the test page, but accessibility traversal exposed
editable content from an inactive Notion tab. A repeated read eight minutes
later ruled out transient loading. A temporary metadata-only probe found the
inactive web document parked at the bottom-right corner of the owning window,
with only a 1 × 1 point intersection. The active test document was beyond that
large inactive subtree in the traversal budget.

The native collector now excludes unowned application-level document roots and
prunes fully clipped web-document subtrees. It retains normal native controls,
menus, sheets and background windows. Semantic dispatch also rechecks the
referenced element's document ancestry. The probe was removed. A real provider
read at 17:33 UTC showed the correct test-page document and editable paragraph;
the old editable body was absent. Legitimate tab and sidebar labels remain.

A separate native defect allowed Cua's non-keyable cursor overlay to become the
chosen foreground restoration target. Window enumeration now excludes only
the exact registered overlay window ID, retaining other windows owned by that
process. Native regression tests qualify this repair; foreground restoration
still needs a live run when the operator is not actively using the Mac.

Physical-input diagnostics record only a bounded event kind/type, source PID,
source-state identifier and tagged-input flag, plus a modifier-key boolean for
modifier events. They exclude typed keys, text and coordinates. The live trace
at 17:34 UTC identified physical keyboard input cancelling a foreground click;
the operator confirmed they were using the Mac. This is expected interruption,
not a reason to weaken the safety listener. The operator then requested
background-only testing.

### Background editing evidence

At 17:37 UTC a real `computer_type_text` call targeted the freshly observed
synthetic paragraph in `cua:720:71`, with `delivery_mode: background`. The
native accessibility lane completed in 1,082 ms without activating Notion.
A separate screenshot and accessibility read verified the complete 379-character
sample, including `SYNARA-E2E-379` and its final `END`; the title was unchanged.
There was one mutation and no retry. This proves background editing for that
paragraph, not every Notion control or persistence after application restart.

The result correctly withheld unproven delivery counts and reported
`dispatched-unknown`. However, its inline observation selected a small Notion
accessory window instead of the requested page. That separately reproduced
defect is repaired: text, value and selection operations retain their exact
target capture; click/key actions consider a newly opened dialog only when the original target
is proven byte-identical to its last delivered frame. Changed or previously
unseen target images remain primary.
Both narrow text regressions and the two subsequent general click regressions
failed before their repairs. The final gateway and manager files pass 383
cases, including preserved unchanged-frame dialog behavior. The explicit
follow-up read returned the correct page in 350 ms. The rebuilt text path was
verified live at 17:49 UTC with a 1536 × 964 screenshot of `cua:720:71`;
the generalized click path also passed live at 18:02 UTC: the inline image
after a background comment-field click remained `cua:720:71`, 1536 × 964,
and showed the test page rather than the accessory window.

The final native artifact was imported after graceful shutdown of the isolated
app. Its binary SHA-256 is
`0df4f53d9a7bf4f4c3ef78e9d1b513df41f26b0e2ecfceb72129610852791d82`,
with macOS patch SHA-256
`658e00ed0dd453f838f2b4f10b5f682c0b1f57839733581de8ecb796c5d6edfe`.
Provenance, strict signature verification and version checks passed for that
live artifact. PR CI subsequently exposed zero-context revision-40 patch hunks
that the production `patch` command accepted but `git apply --check` refused.
Only those hunks were regenerated with ordinary context; all earlier patch
bytes were retained. The current patch SHA-256 is
`ad4d1fc0b55e963d4430c386d37e3026476c2c5efcdf2e0587a9bd9ae34f653d`.
Both patch applicators now accept the native and Linux patches without fuzz,
offsets or rejected hunks. Comparison of all 501 native and 502 Linux source
files, including executable modes, confirms identical resulting code. The
live artifact above retains its original patch provenance; repackaged artifacts
must be rebuilt through the supported provisioner, not relabeled.

| Live case                | Result and limit                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Background text          | The 379-character sample and subsequent long synthetic text appeared after one exact-ref mutation each. Final text-path inline observation stayed on the requested page. No fabricated partial counts or replay.                                                                                                                                                                                                                                       |
| Background scroll        | First request of 180 logical pixels measured 264.38 pixels of travel. The second request returned `movement_not_measurable`; calls three and four were not attempted. Offline analysis of the delivered frames found competing matches from nearly identical fixture rows. This is evidence of ambiguity, not failed input; the private per-leg capture pair was not retained.                                                                         |
| Comment draft            | One semantic click and one exact-ref background text call put the unique marker in the test page's comment editor. A fresh AX value contained it, but a later click/focus removed it and exposed the placeholder again. This does **not** qualify persistent comment editing. Nothing was submitted or published. The click exposed the general screenshot bug repaired above; the final rebuilt click path and typing both returned the correct page. |
| Direct AX replacement    | One `set_value` on the synthetic body returned uncertainty and showed no replacement in the inline or follow-up read. A later Notion modal said the request was too large. The modal was dismissed once semantically and its disappearance verified; the draft remained. No replay or fabricated success.                                                                                                                                              |
| Image/file paste         | Not attempted: fresh state did not prove that the caret belonged to the synthetic body. No clipboard read/write occurred. Source and isolated native pasteboard tests qualify preservation, not Notion upload or save completion.                                                                                                                                                                                                                      |
| Exact text selection     | The provider stopped at the modal before selection; it also missed the existing help-to-batch discovery route. This is not evidence that Cua lacks selection. Native selection requires a settable plain AX range, which rich web editors may not expose.                                                                                                                                                                                              |
| Interruption and cleanup | Real physical keyboard input cancelled foreground work. Background tasks completed without a foreground fallback. Test chat control was revoked and owner connections drained before backend changes. Forced Escape and final-build foreground restoration remain unqualified.                                                                                                                                                                         |

The last local label-path turn completed at 18:14 UTC. Its Computer control
was revoked and the owner connection closed, without changing the global
Computer setting. The final server was rebuilt and loaded through the existing
supervisor while the same desktop process remained open. The restricted-sandbox
full-suite attempt encountered loopback/process `EPERM` failures; that test
runner was stopped and the unchanged suite rerun with the required local access.

The final desktop and native artifact were loaded after an explicitly approved
restart. Further server-only repair uses the existing supervisor's graceful
child restart, preserving the desktop window and avoiding another foreground
activation. Remaining image/file upload, save persistence after reopening,
persistent comment editing, third/fourth scroll admission and foreground restoration are **not claimed as
live passes**. Background-only constraints remain in force.

No signed packaged app, installed-app update, Linux or Windows runtime,
all-provider delivery or end-to-end speed benchmark was qualified. These
changes are source implementation and local validation, not a release
certification. No layout or styling changes were made; tool labels,
descriptions and error text changed within the requested Computer Use scope.

PR review exposed one additional desktop cleanup defect: the host consumed a
clipboard restoration receipt before receiving a terminal native reply. The
receipt now survives transport loss or native errors and is consumed only
after native confirms restoration or a deliberate skip for a newer human copy.
Two owner-boundary regression cases failed before this repair; all nine
clipboard host cases passed afterward. Task, stopped-input and driver-generation
guards remain enforced. This additional repair has automated coverage, not a
new live Notion clipboard test.
