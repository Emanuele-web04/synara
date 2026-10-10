# Retry effort draft: actual ChatView evidence

Retry remains unavailable until the server can verify the original turn and recovery baseline and consume that preparation atomically. These captures document the guarded draft and the retained local text pager; they do not demonstrate a successful provider retry.

## Before and after

| Evidence                                       | What it shows                                                                                                                             |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| [Before](before-main.png)                      | Exact upstream commit `1e77960843245c860265cda9b102e65db3c80fc4`, with no retry control.                                                  |
| [Unavailable retry](after-unavailable.png)     | The draft keeps the button disabled and explains: “The original model and recovery checkpoint could not be verified for this turn.”       |
| [Previous attempt](after-previous-attempt.png) | A fixture-seeded local attempt is selected through the actual pager.                                                                      |
| [Interaction recording](retry-interaction.mp4) | A 6.96-second native browser recording: hover the unavailable control, select the seeded previous attempt, and return to the live answer. |

The completed turn uses approval-required mode and mocked RPC data. The previous attempt is seeded directly into the existing local variant store by temporary capture instrumentation. The live answer receives no guessed model or effort badge. The selected browser case verifies that no settings, edit, or turn-start command is sent and that the composer draft remains unchanged. Both before and after cases pass, with no page errors recorded.

## Provenance and limits

The after source is stacked on the independent workspace-rescue repair `7fa64537d6ae0b6134167b6c0aadd92485df4e40` from PR #1770. Exact source blob and SHA-256 hashes, observations, timing, and asset hashes are recorded in [capture-provenance.json](capture-provenance.json).

Captures use the repository’s full `ChatView.browser.tsx` fixture and production components at 1280 × 720 in dark mode. Temporary capture commands and configuration were removed afterward; the fixture was verified byte-for-byte against the immutable upstream snapshot in both worktrees. No capture-only production behavior is included.

The local browser is Chromium 138.0.7204.0; CI uses Chromium 151, whose download was unavailable in this environment. The after run required a 4 GB Node heap to compile the full fixture. This is actual browser evidence with mocked RPC, not a live provider or workspace recovery exercise. No user-facing undo, native provider-history restore, or completion of issue #1092 is claimed.
