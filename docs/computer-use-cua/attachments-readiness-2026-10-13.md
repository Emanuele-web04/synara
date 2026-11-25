# Evidence-based waits and workspace attachments

Follow-up to PR #1911. No new native actuator, foreground bypass, dependency, UI,
or binary clipboard path is introduced.

## Research and scope

These are individual public user reports, not a prevalence survey or independent
reproduction of another product's defect. Reviewed on 13 October 2026.

| Signal                                                                    | Source                                                                                                 | Decision                                                                                                                                      |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Upload reported successful despite missing files and no processing        | [browser-use/web-ui #677](https://github.com/browser-use/web-ui/issues/677), 12 August 2025            | Add metadata preflight and distinguish file-input evidence from application acceptance.                                                       |
| Requested file count and application limits/previews disagree             | [browser-use/browser-use #4670](https://github.com/browser-use/browser-use/issues/4670), 13 April 2026 | Read back actual input names, sizes, and count; still inspect application previews/errors.                                                    |
| An authorized upload waits roughly 49 minutes before a permission failure | [openai/codex #50734](https://github.com/openai/codex/issues/50734), 3 October 2026                    | Preserve existing bounded approval/cancellation; improve observation waits, never bypass security or race live input with an unrelated timer. |
| Independent concurrent computer-use sessions                              | [openai/codex #20852](https://github.com/openai/codex/issues/20852), 3 May 2026                        | Synara already has background per-app ownership and exclusive foreground input. Do not weaken leases or add a competing scheduler.            |

Priorities reflect demonstrated Synara gaps and bounded verification: false
negative accessibility evidence and unverified selection precede native pickers.

## Conditional waits

`computer_wait` and `computer_run` wait steps accept `absent: true` for a control
to disappear, `value_equals` for an exact accessibility value (including empty
text), and `stable_ms` for matching observations spanning an interval within
`duration_ms`. Absence and value equality are mutually exclusive.

A label/window (or batch-resolved ref) identifies a live semantic condition, not
retained coordinates. Stability is sampled evidence, not continuous monitoring.
Unreadable values are unavailable, not empty. A truncated root or nested branch
cannot prove disappearance. Closed windows are explicit and are not screenshotted.

An unmet conditional wait stops a batch before subsequent input even with
`continue_on_error: true`. Layout-settle barriers retain the same rule. A failed
accessibility read or settle observer also stops the batch and preserves the
error; an exception cannot establish readiness. Fixed delays are still available
but are not readiness evidence.

Polling backs off from 100 to 200 to 400 to 500 milliseconds, bounded by remaining
time and the stability deadline. A deterministic two-second test with immediate
reads performs seven observations instead of the old 100-millisecond schedule's 21. This is not an end-to-end throughput benchmark. An in-flight accessibility
read remains cooperatively cancellable and can finish after the polling deadline.
Expected values are logged as character counts, never raw text.

## Generic browser attachment entry point

Discover `computer_attach_files` with `computer_help`, topic `attachments`. It is
callable by exact name but withheld from the always-advertised tool list.

Metadata only:

```json
{ "action": "inspect", "files": ["assets/photo.png", "report.pdf"] }
```

Synara's integrated browser:

```json
{
  "action": "attach",
  "surface": "integrated_browser",
  "tab_id": "<observed integrated tab ID>",
  "selector": "<observed file-input CSS selector>",
  "files": ["assets/photo.png"]
}
```

A bound desktop-driver browser:

```json
{
  "action": "attach",
  "surface": "computer_browser",
  "target_id": "<observed bound browser target>",
  "tab_id": "<observed driver tab ID>",
  "ref": "<observed file-input ref>",
  "files": ["report.pdf"]
}
```

The adapter requires computer control and an active caller turn. The integrated
route additionally requires `browser:control`. Delegation preserves each engine's
approval, cancellation, idempotency, audit and workspace checks.

Neither mode guesses a tab, launches a browser, switches profiles, pastes bytes
or filenames, or sends a separate form-submission action. File selection itself
can trigger automatic uploading; existing upload approvals still apply. Consent
to attach is not consent to arbitrary subsequent submission or sharing.

Preflight accepts 1–32 regular files within the active workspace and at most
256 MiB total. Paths may be absolute or workspace-relative. It rejects directories,
devices, duplicate canonical paths, symlink components, missing files, and escapes.
It returns names/sizes, not contents or absolute paths. It is not a file
reservation. The host still revalidates immediately before input. The integrated
host retains private staged copies and document-lifetime cleanup. The driver
route does not gain a new file-staging transaction through the adapter.

## What success proves

The integrated host reads the actual input `FileList` after `setInputFiles`.
Matching count, names, and sizes produces optional `selectionVerified: true`.
This is neither a byte-content checksum nor a remote upload acknowledgement.
The adapter also checks the host's returned names/sizes against its preflight
before giving its receipt the `verified-file-input` label.

A cleared/replaced/detached input, unreadable result, or mismatch yields
`BrowserAmbiguousResult`, `effectMayHaveCommitted: true`, `retryable: false`.
Staged files remain alive until navigation/destruction because page code may
already be consuming them. No automatic replay occurs.

Older hosts omit the flag; metadata alone never upgrades them to verified.
Driver-browser success remains selection-unverified until that engine supplies
comparable evidence. Existing error/refusal results pass through unchanged,
without fallback.

Always inspect the application's preview, count, progress, error or completion
state. A FileList can match while the site later rejects a file, or the site can
accept/upload it while immediately clearing the input. Application acceptance is
explicitly unverified in every generic attachment receipt.

## Native attachment boundary

There is still no generic OS-native file-picker actuator. The current driver has
input and accessibility operations but no capability proving the live open-panel
owner, exact selection target, selected URLs and resulting attachment.
[Apple documents](https://developer.apple.com/documentation/appkit/nsopenpanel)
that modern open panels run in a separate process. A process-scoped key sequence,
a pasted filename, or panel-title matching cannot supply the missing proof.

Native apps still require their observed Attach/Upload control and picker through
approved tools, followed by preview verification. Arbitrary binary clipboard
formats, drag-and-drop-only targets, and inaccessible controls are not silently
supported by this change.

## Verification boundary

Focused tests cover wait evidence/stability/cancellation, batch barriers, route
and capability isolation, metadata preflight, older hosts, and staging retention
after uncertain input. The desktop tests execute the generated readback snippet
against a controlled DOM-like target; they are not live Electron/website or
native Notion end-to-end qualification.
