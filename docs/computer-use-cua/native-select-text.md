# Native `select_text` design note

Parity matrix item 13 adds `computer_select_text` to Synara. The agent-facing
layers live in this repository (contracts, manager, gateway, WebSocket); the
actual range write lives in the native Cua driver, whose source checkout is
not edited by Synara workstreams. This note documents the ready-to-apply
native diff at
the `select_text` hunks inside [`apps/desktop/patches/cua-driver/0001-synara-native.patch`](../../apps/desktop/patches/cua-driver/0001-synara-native.patch)
and the invariants it preserves.

## Supported operation

`select_text` writes a `CFRange` to the element's `AXSelectedTextRange`
attribute through `AXUIElementSetAttributeValue`, then reads the same
attribute back with `AXUIElementCopyAttributeValue` and compares it to the
request. `start` and `length` are zero-based UTF-16 code-unit counts — the
same indexing `AXSelectedTextRange`, Swift `String`, and JavaScript string
offsets share. `length: 0` places a collapsed caret at `start`.

New bindings in `platform-macos/src/ax/bindings.rs`:

- `set_range_attr(element, attr, location, length)` — wraps the pair in an
  `AXValue` of `kAXValueCFRangeType` (4) and sets the attribute.
- `copy_range_attr(element, attr)` — returns `Some((location, length))` only
  when the attribute exists and is a CFRange-typed `AXValue`; `None`
  otherwise.

The tool accepts `element_token` or `element_index` + `window_id` (plus
`pid`, `snapshot_id`, `session`) — never coordinates. There is no
`delivery_mode` argument: like `set_value`, selection is an always-background
semantic AX write, not a pointer/keyboard delivery.

## Effect semantics

The emitted legacy payload carries `path: "ax"`, a `verified` flag, and an
`effect` string; `action_record.rs` normalizes it into the closed
`ActionResult` contract exactly as it does for `set_value`.

- `verified: true` + `effect: "confirmed"` + `evidence: value_readback` —
  only when the post-write read-back reports exactly the requested range.
  The record publishes `AccessibilityReadback` evidence, so `Confirmed`
  survives projection; Synara maps this to `effect: "verified"`.
- `effect: "unconfirmed"` — a read-back ran and returned a different range
  (the app clamped or ignored the write). Projects to `Unverifiable` →
  Synara `dispatched-unknown`. Never replayed automatically.
- `effect: "unverifiable"` — the attribute could not be read back at all,
  or the write returned a non-success `AXError` after dispatch. Same
  projection, same "observe fresh state; do not replay" guidance.
- Refusals go through `AxActionFailure::refused` → `effect: "refused"` →
  Synara `not-dispatched`.

A successful `AXUIElementSetAttributeValue` return code alone is never
reported as confirmed — the same trap `set_value` documents for AXValue
echoes.

## Refusal cases (pre-dispatch)

- **`AXSelectedTextRange` not settable** — checked with
  `AXUIElementIsAttributeSettable` before any write. This is also the
  marker-range boundary below.
- **Range past the element's readable value** — when `AXValue` reads as a
  string, `start > units` or `start + length > units` is refused rather than
  clamped. When `AXValue` is unreadable the write proceeds and the
  read-back is the sole arbiter; a clamped result reports unconfirmed.
- **`start + length` exceeds CFIndex width** — refused instead of
  truncating a `u64` into a different `i64` range.
- **Stale element token / missing window** — `resolve_element_args` and the
  `gate_background_window_action` (`BackgroundAction::AxSemantic`) mutation
  lease re-prove the retained element still belongs to the exact window
  immediately before dispatch.
- **Disabled element** — `ensure_ax_action_enabled` runs inside the
  pre-dispatch gate with the cancellation check
  (`cancellation::gate().check_target()`).
- **Ambiguous target** — the manager's semantic resolution refuses before
  the native call is ever reached.

## `AXSelectedTextMarkerRange` — explicitly unsupported

Chromium- and WebKit-backed content typically exposes selection through
`AXSelectedTextMarkerRange`, an `AXValue` payload of text markers, not a
`CFRange`. This patch adds no text-marker bindings: the settability check
fails on such elements and the call refuses before dispatch with a message
naming the marker-range limitation. There is no triple-click, select-all,
key-event, or pointer-drag fallback — an approximate selection would violate
the exactness contract the tool advertises.

Web surfaces get one more guard consistent with `type_text`/`set_value`:
`target_in_web_area` downgrades a technically-successful read-back inside an
`AXWebArea` to unverified (`observation_required`), because an AX echo is
not proof the renderer selected anything.

## Registration inventory (what the diff touches)

- `platform-macos/src/tools/select_text.rs` — new tool implementation.
- `platform-macos/src/tools/mod.rs` — `mod select_text;` and
  `pid_window_guarded` registration next to `set_value`.
- `platform-macos/src/ax/bindings.rs` — `CFRangeValue`, `set_range_attr`,
  `copy_range_attr`.
- `cua-driver-contract/src/lib.rs` — `ACTION_RESULT_TOOLS` (advertises and
  validates the closed `ActionResult` output schema).
- `cua-driver-contract/src/cursor.rs` — `CursorAction::Text` classification.
- `cua-driver-core/src/tool.rs` — capability tokens
  (`accessibility.text.selection`, `accessibility.element_tokens`),
  `is_physical_desktop_action`, the tool-summary formatter, and the two
  pinned capability test lists.
- `cua-driver-core/src/action_record.rs` — value-readback tools, the `"ax"`
  transport arm (all three platform branches) and the pathless-`""` arm so
  legacy normalization cannot strand the tool.
- `cua-driver-core/src/authorization.rs` — desktop-input scope list, the
  `RiskClass::R1` match, and the process-targeting list.
- `cua-driver-core/src/capture_scope.rs` — window-scoped input list.
- `cua-driver-core/src/session_manifest.rs` — `ORIGIN_BYPASS_TOOLS`.
- `cua-driver/src/sdk_adapter.rs` — `uses_stable_space_membership`
  (element-addressed → `prepare_exact_semantic` + concurrent semantic
  lease), the `native_target` prepare list, the `_native_input` lease list,
  and the membership test vectors.
- `cua-driver/src/serve.rs` — `synara_native_revision` literal `18 → 19`
  (authored intent; actually applied `19 → 20` — see "As applied" below).

The tool is deliberately absent from `cua-driver-contract/src/desktop.rs`
(portable contract manifest) and `libs/cua-driver/contract/manifest.json`:
like `set_value` it is a runtime-only macOS tool; the portable manifest is
regenerated only when a portable contract is added.

## Base and application

- Authored base: native revision 18 — the `wait_for_settle` /
  `InputGeneration` working tree at upstream `fc188250` (`d2c9c68` in the
  Synara checkout). Hunks anchor on rev-18 symbols (`mod wait_for_settle;`,
  `InputGeneration` call sites) and fail loudly on a revision 17 tree
  rather than silently misapplying.
- Apply: the `select_text.rs` new-file hunk plus registration hunks are carried inside `apps/desktop/patches/cua-driver/0001-synara-native.patch` (folded during the `7fe7c33f` rebase — the former standalone `0002-select-text.patch` was retired)
  at the driver source root.
- **As applied 2026-09-23**: the rev-19 keymap stream had already landed
  by the time this patch was staged, so it was applied on top of the
  staged rev-19 tree — every hunk except the `synara_native_revision`
  literal applied clean, and the literal was bumped `19 → 20` by hand
  (exactly the concurrency case `native-keymap-notes.md` documents). The
  change is folded into `0001-synara-native.patch` (sha
  `7a2698bbd3b2cf49dd07e1fe0f06db84c4d7a5009d82469f9f24b10887f88919`);
  `cuaDriverRelease.json` pins `nativeRevision: 20` and the packaged
  binary is the rev-20 arm64 build. This file remains the authored record;
  the `select_text` portion of `0001` is the readable delta the
  same way `native-keymap.diff` records the rev-19 change.

## Verified

- `cargo check -p platform-macos -p cua-driver` on the patched tree: clean.
- `cargo test -p cua-driver-contract -p cua-driver-core -p platform-macos
-p cua-driver`: all unit and protocol suites pass except two
  `protocol_session_test` cursor-session cases
  (`session_owned_cursor_state_is_independent`,
  `concurrent_multi_driver_isolation`), which fail identically on the
  unpatched revision-18 base — pre-existing, unrelated.
- `git apply --check` on a fresh revision-18 tree: clean.
- `cargo fmt --check`: the new/changed hunks are rustfmt-clean (the rev-18
  files `set_app_visibility.rs`/`wait_for_settle.rs` already carry their
  own diffs).

Live GUI qualification on the rev-20 packaged driver (2026-09-23, trusted
host against a hidden TextEdit document, operator front `ghostty`
throughout): `select_text {5,3}` on `"0123456789ABCDEF"` returned
`effect:"confirmed"` with `evidence:[{kind:"value_readback"}]` via
`route:"accessibility"`, and an independent System Events read of
`AXSelectedText` on the exact target window reported `"567"` — the
selected string matches the requested range; sibling windows showed empty
selections. `{8,0}` collapsed-caret also confirmed. An out-of-bounds range
(`{0,9999}` on a 23-unit value) was refused `ax_action_refused` before
dispatch — never clamped. Still unverified: Chrome/Electron AXWebArea
content (expected marker-range refusal), Safari, and selection on a
foreground/key window.
