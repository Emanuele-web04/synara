# Browser surface — driver `browser_*` family through Synara

> Historical wiring and runtime record for the revisions named below. Current
> browser profile, authorization, effect and cancellation boundaries are in the
> [implementation overview](README.md). Earlier successful protocol runs do not
> qualify the current packaged driver.

Status: wired. Verified against the pinned driver (0.28.2, native rev 17)
schemas on 2026-09-17, and end-to-end against the shipped driver binary the
same day through the exact protocol path `cuaDriverHost.ts` implements:
control `session_begin` accepted on a persistent connection, `browser_prepare`
launched a driver-owned isolated Chromium (`prepared_pid`), `get_browser_state`
bound `binding_quality:"exact"` via `native_cdp_window` and minted
`target_id`/`tab_id`, `browser_navigate` landed a real navigation with
`refs_invalidated`, a snapshot returned a `p1` snapshot id, non-CDP windows
refused verbatim with a structured `browser_route_unavailable` refusal (a
Chromium-family mismatch maps to `browser_wrong_target_refused`), and
`end_session` ran the lifecycle teardown. Exposed to the agent as
`computer_browser_*` (see the wiring map below).

## Why this exists

The OS-level CGEvent path is dead on inactive Chromium-family renderers
(verified: keys, moves, wheel via `CGEventPostToPid` never reach an inactive
Electron — see `input-matrix-2026-09-17.md`). The driver's browser family uses
CDP `Input.dispatch*` on an exactly-bound tab instead: trusted, hardware-like
input that **works in the background** and is refused only when standalone
background posture cannot be preserved. This is the honest path for browser
automation and the real answer to "background pointer on web content."

## Driver surface (9 tools + legacy)

| Tool                      | What it does                                                                                                                                                                                                                                                                                                                                | Class                |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| `browser_prepare`         | Mint an owned DevTools endpoint: detect existing, attach existing-profile (grant-gated), or launch isolated profile (`allow_launch`). Per-instance checkbox toggle on the browser's remote-debugging page; every visible effect reported; ambiguity refused.                                                                                | setup                |
| `get_browser_state`       | Mode 1 bind: native window pid+window_id → classify → correlate to CDP target (exact-or-refuse) → session-scoped `target_id` + `tab_id`s. Mode 2 snapshot: `target_id`+`tab_id` → `semantic_v2` outline with typed action refs / content refs / scoped reads / continuation. Never does setup; missing endpoint → `browser_requires_setup`. | read                 |
| `browser_navigate`        | Navigate one bound tab to http/https/about URL. Heuristic bindings refused. Invalidates `p<snapshot>:<index>` refs.                                                                                                                                                                                                                         | mutation             |
| `browser_click`           | Click by ref or viewport coords. Default trusted `Input.dispatchMouseEvent`, refuses if background posture can't be preserved. `input_route="dom_event"` (synthetic `el.click()`) only when explicitly requested — proves dispatch, not activation.                                                                                         | mutation             |
| `browser_type`            | `Input.insertText` (default) or per-char keystrokes into a ref. Appends at caret; `replace=true` sets/clears. Ref required.                                                                                                                                                                                                                 | mutation             |
| `browser_pointer`         | hover / right-click / double-click / scroll / drag on a bound tab. Refs must declare `pointer` capability (scroll accepts `scroll` or `pointer`). Trusted CDP route; `dom_event` explicit-only. Never foregrounds.                                                                                                                          | mutation             |
| `browser_dialog`          | Inspect/accept/dismiss page-owned JS alert/confirm/prompt/beforeunload by exact `dialog_id`. Background by default; Linux needs explicit foreground.                                                                                                                                                                                        | mutation             |
| `browser_download`        | Trigger one download via exact ref into an explicitly approved dir. Needs destructive-tool approval; never returns URL/filename/path.                                                                                                                                                                                                       | mutation (sensitive) |
| `browser_set_input_files` | Assign explicit absolute files to a live `<input type=file>` ref via CDP. Rejects symlinks/non-regular; never returns paths.                                                                                                                                                                                                                | mutation (sensitive) |
| `page`                    | Legacy compat. Read-only `get_text`/`query_dom` by default; mutations need `CUA_DRIVER_ENABLE_LEGACY_PAGE_MUTATIONS=1` at daemon start. Prefer the typed tools.                                                                                                                                                                             | legacy               |

## Consent model — separate from computer-use

The computer-use approval gate is per-action against a window target. Browser
tools add a second axis: the **endpoint grant**.

- `browser_prepare` with `allow_launch` or existing-profile attachment is the
  consent moment — it follows the driver's own immutable permission mode
  (`standard` needs an explicit grant or embedding authorization host;
  `bounded` needs a launch-approved manifest; `unrestricted` needs trusted
  startup acceptance). Ordinary MCP/tool approval never proves profile
  authorization — Synara must NOT auto-grant.
- Bound `target_id`/`tab_id` refs are session-scoped and exact-or-refuse;
  they become the target of record (like `element_token`/`window_id` today).
- Mutations (`navigate`, `click`, `type`, `pointer`, `dialog` resolve) are
  approval-gated by `computerBrowserToolRequiresApproval` in
  `computerBrowserTools.ts` — the same task-scoped computer approval the
  desktop `COMPUTER_APPROVAL_REQUIRED_TOOLS` names ride.
- `browser_download` and `browser_set_input_files` are sensitive mutations —
  approval plus a per-call destination/file policy; never echo paths.
- `get_browser_state` bind is a read but mints refs; snapshot is pure read.

## Wiring map (as built)

- `packages/shared/src/cuaDriverProtocol.ts`: `CUA_BROWSER_TOOLS` +
  `CUA_BROWSER_MUTATION_TOOLS` — a separate family, not folded into
  `CUA_ACTION_TOOLS`: targets are `target_id`/`tab_id`/refs, not window ids,
  and refusals arrive as `status:"refused"` results rather than errors.
- `apps/desktop/src/cuaDriverHost.ts`: admits each name; requires task
  attribution; injects a deterministic per-thread lifecycle label
  (`synara-browser-<threadId>`) as `session` and the persistent control
  connection's `session_id`; revives ended labels via `start_session`;
  `end_browser_thread` maps to `end_session`; control-socket EOF is the
  driver's own reaper for everything a transport owned.
- `ComputerBackend.ts` + `CuaComputerBackend.ts`: a `browser` member with one
  `call` — the backend forwards replies verbatim so `status:"refused"`
  reaches the model as a result instead of a thrown error, and `endThread`
  for thread teardown. An absent member means "no browser surface"; the
  gateway then does not advertise the tools at all.
- `ComputerManager.ts`: `browserCall` serializes per thread on a scoped
  browser lane, marks `get_browser_state` as the family's only non-mutation,
  and calls `browser.endThread` from `handleThreadRemoved`.
- `computerBrowserTools.ts`: the nine `computer_browser_*` tools with the
  same `computer:control` capability and approval gate as the desktop tools;
  `computer_browser_state` and `browser_dialog` `inspect` are the only
  reads. Upload/download paths are canonicalized and refused outside the
  caller thread's workspace root before dispatch.
- `packages/contracts/src/computerBrowser.ts`: gateway ↔ driver name map,
  the closed refusal-code vocabulary, and the state/ref shapes Synara reads.

## Open decisions

- Whether the existing CDP/Chrome-extension path (deferred by decision in the
  parity matrix) is superseded by `browser_prepare`'s existing-profile grant.
- `page` legacy: not exposed — the typed tools cover its read surface.
  Revisit only if a driver version ships a `get_text`/`query_dom` behavior
  the semantic snapshot cannot express.
- Download/file-pick policy surface beyond the workspace boundary (approved
  directories outside the thread workspace) — currently refused by policy,
  not by the driver.
