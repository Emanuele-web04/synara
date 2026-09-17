# Browser surface — driver `browser_*` family through Synara

Status: spec. Verified against the pinned driver (0.28.2, rev 15) schemas on
2026-09-17. Not yet wired.

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
- Mutations (`navigate`, `click`, `type`, `pointer`, `dialog` resolve) go in
  `COMPUTER_APPROVAL_REQUIRED_TOOLS`.
- `browser_download` and `browser_set_input_files` are sensitive mutations —
  approval plus a per-call destination/file policy; never echo paths.
- `get_browser_state` bind is a read but mints refs; snapshot is pure read.

## Wiring map (mirrors milestone-1 pattern)

- `packages/shared/src/cuaDriverProtocol.ts`: `browser_prepare` +
  `get_browser_state` + mutating `browser_*` into `CUA_ACTION_TOOLS`;
  `get_browser_state` also reads — classify by mutation-ness.
- `apps/desktop/src/cuaDriverHost.ts`: admit each name; session injection is
  automatic (`session: generation.session`).
- `ComputerBackend.ts` + `CuaComputerBackend.ts`: `browserPrepare`,
  `browserGetState`, `browserNavigate`, `browserClick`, `browserType`,
  `browserPointer`, `browserDialog`, `browserDownload`, `browserSetInputFiles`.
  Refs (`target_id`, `tab_id`, `ref`, `dialog_id`) are opaque strings passed
  through; the driver enforces exactness.
- `ComputerManager.ts`: route; browser mutations still honour
  cancellation/`desktopEpoch` fencing where the window target applies.
- `computerTools.ts`: `computer_browser_*` tools + approval set.
- `packages/contracts/src/computer.ts`: result types for state/refs.

## Open decisions

- Whether `computer_browser_*` tools live alongside `computer_*` or under a
  separate tool namespace — they target tabs, not windows.
- Whether the existing CDP/Chrome-extension path (deferred by decision in the
  parity matrix) is superseded by `browser_prepare`'s existing-profile grant.
- `page` legacy: expose read-only `get_text`/`query_dom` or skip entirely.
- Download/file-pick policy surface: which directories are approvable.
