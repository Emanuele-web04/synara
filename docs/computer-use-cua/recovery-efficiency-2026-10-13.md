# Computer-use recovery and efficiency — October 13, 2026

This follow-up extends the approval-expiry and input-listener recovery in PR 1911. It changes the engine and agent-facing API, not the visual interface.

## New behavior

| Area                 | Behavior                                                                                                                                                                                                                                   | Boundary                                                                                                                                                                                                                                                       |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rich-editor text     | `computer_type_text` accepts `typing_mode:"keyboard"`, including in `computer_run`. It chooses native keyboard events before dispatch, with a 10 ms requested delay.                                                                       | macOS only, exact `window_id`, approved `delivery_mode:"foreground"`, and the window's already focused field. A ref or label cannot silently aim process-scoped keys. Unsupported backends refuse. Never replay an uncertain semantic edit through this route. |
| Native text evidence | Revision 41 combines upstream text, clipboard and AX-root safeguards with removal of untrusted web/Electron AX character counts before partial-result classification and skips AX drain polling after keyboard dispatch to those surfaces. | The result stays unverified. Dispatch, visible text, saved state and submission are distinct facts; no fabricated renderer success.                                                                                                                            |
| Error recovery       | An uncertain native action can return its exact window's recovery screenshot in the original error response.                                                                                                                               | No replay, no promotion to verified, no human-resume authority. `include_screenshot:false` opts out; failed recovery capture preserves the original error.                                                                                                     |
| Scroll navigation    | Default `scroll_mode:"read"` preserves half-viewport overlap. Explicit `"navigate"` accepts up to three viewports, bounded to 6000 desktop pixels per axis. Both direct and batch routes enforce it.                                       | It may skip content or lose pixel correlation. Actual traveled distance is never inferred from requested distance. Gearing cannot exceed the native event budget.                                                                                              |
| Progress guard       | Measured nonzero scroll travel clears history only for that scroll action and exact target.                                                                                                                                                | Earlier uncertain paste/typing stays guarded. A fresh screenshot, unknown travel or a changed error code is not proof of progress.                                                                                                                             |
| Settling             | `computer_run` accepts a `wait` step with `settle:true`. An unsettled result stops before the next input. Standalone settle can return a requested screenshot without settling twice.                                                      | A fixed fallback is labeled `mode:"fixed"`; AX quiet does not prove image loading or upload completion. Inspect current state before relying on layout.                                                                                                        |
| Accessibility        | Unnamed actionable controls with retained native identities now receive exact refs.                                                                                                                                                        | Unbound, offscreen and omitted controls are not invented. Incomplete AX remains explicitly incomplete.                                                                                                                                                         |
| App guidance         | The first exact-window Notion observation includes the on-demand Notion playbook. Shared descriptions are compacted rather than increasing the model-context budget.                                                                       | Instructions do not override admission or repair an application's behavior.                                                                                                                                                                                    |
| Clipboard            | Text paste validates its target first, refuses an unsaveable clipboard, and does not restore old text over a newer visible clipboard value.                                                                                                | Read/compare/write is not an atomic pasteboard-generation transaction and cannot preserve arbitrary binary formats.                                                                                                                                            |

## File attachments

`computer_browser_upload` already exists for a bound browser page. It accepts
an observed file-input ref and 1–32 canonical files within the active workspace,
with the existing approval and browser-target checks. The attachments playbook
now points to this actual API rather than claiming no upload route exists.
It does not use the clipboard.

A native Notion window is not a CDP browser target. This change does **not** add a
generic native binary attachment API, attach to a personal browser without
consent, or silently substitute a fresh isolated browser/profile. Native apps
still need their observed Attach/Upload control and file picker. Verify the
attachment preview and completion before any separately authorized submission.

## Remaining limits and validation

The original seven symptoms are not all universally eliminated. Unknown native
keyboard destinations still refuse; a 33-pixel window is not evidence that it
cannot receive keys. Driver revision 39's proven accessory-window exclusions
remain intact. Missing accessibility data and unknown application-renderer
state cannot be converted into reliable evidence by changing a verdict.

Focused tests cover routing, consent, error observations, clipboard preservation,
scroll bounds/progress, settle sequencing and retained native identities.
Native text tests cover zero, partial, complete and absent web read-back counts.
Unit tests and builds do not qualify a live Notion session, human takeover,
Focus/Spaces restoration, signed distribution or arbitrary file pickers.
