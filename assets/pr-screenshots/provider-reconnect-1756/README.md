# Provider reconnect UI evidence

These are actual browser captures of the existing full-application `ChatView.browser.tsx` fixture, with production components, styles, and React compiler enabled. The fixture represents an established Codex conversation with a completed assistant reply.

| Artifact                    | Observed behavior                                                                                                                                                                                                     |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `before-main.png`           | Main displays **Starting Codex…** during the returning session's `starting` phase. The composer has `contenteditable="false"`.                                                                                        |
| `after-pr-1756.png`         | The PR displays **Reconnecting to Codex…** after the debounce settles. The composer stays editable, and real keyboard input enters **Keep the recovery plan concise.** while the session is still reconnecting.       |
| `reconnect-interaction.mp4` | 9.42-second recording: ready conversation → starting/reconnecting → type the draft → ready again, with the draft preserved. 1280 × 720, H.264, 24 fps; native browser screencast frames retain their recorded timing. |

## Source revisions

- Before: immutable main commit `6f54f53c66348a9a19c65779daaabd96113773eb`, rendered from a separate temporary branch. Main was never modified.
- After: PR #1756 production source at `2cf1b157f529be5d8e21cb4b4679bfbb7b908ec7`, rendered from local verification commit `aaa3bc8bc85703d2c78f7605e74427b7d25e2daa`. The production web/shared/contracts files changed by the PR were checked against its remote blobs and match exactly. The local and remote commits differ only in commit lineage and the separately published browser fixture repairs.
- After `ChatView.tsx` blob: `ed1664387c72a93e6ca09d3dacec3f5862dfaa1a`; after `ChatView.logic.ts` blob: `4067ad439145e8316b2ea4db50462ae7f2fefe6a`.

## Validation and limits

One temporary capture case passed on each source revision; all unrelated browser cases were skipped. It asserted the visible label and actual composer editability, used keyboard input during reconnect, and asserted that the same draft remained after readiness returned. Temporary fixture instrumentation and the capture-only Vitest configuration were removed afterward; this directory is the complete permanent change.

The fixture supplies controlled server read-model transitions (`ready` → `starting` → `ready`). These captures demonstrate the rendered reconnect behavior; they do not represent a real provider/SDK restart, network reconnect, or backend runtime reconciliation. Initial-session behavior and sub-400 ms reconnects are outside this capture's scope.

Captured with Chromium **138.0.7204.0** because the configured Playwright Chromium 151 download was unavailable in the execution environment. This is local visual/interaction evidence, not a claim that the CI browser revision was exercised. The screenshots are unmodified PNG captures; the video encodes the recorded browser frames without overlays.
