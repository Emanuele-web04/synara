# native-keymap.diff — driver keymap extension notes (LANDED native rev 19)

Companion to the Synara-side `cuaKey` expansion. **Applied 2026-09-23**: the
keyboard.rs and press_key.rs hunks were applied to `/Users/devin/repos/cua-src`
on top of the staged rev-18 tree and `serve.rs` was bumped to
`synara_native_revision` 19 by hand (the rev-18 stream had already landed the
17→18 bump, exactly the concurrency case predicted below). The folded patch
`0001-synara-native.patch` regenerates at sha
`6d9a8c9e50a596cde34b01f337d640e172cf2a9e669d2b261c76be810093a91c` and
`cuaDriverRelease.json` pins `nativeRevision: 19`. This file remains as the
authored record of the change; the diff itself is retained beside it.

Original apply-time notes: verified `git apply --check`-clean against the
rev-17 checkout at `/Users/devin/repos/cua-src` when authored. The serve.rs
hunk required the "bump to current+1" treatment documented here.

## What it does

One commit's worth of driver changes, five hunks:

1. `platform-macos/src/input/keyboard.rs` — `key_name_to_code`:
   - underscore spellings on existing arms: `caps_lock`, `page_up`/`pgup`/`prior`,
     `page_down`/`pgdn`/`next` (Synara already maps these itself, but direct
     driver callers benefit).
   - `f13`-`f20` → 105/107/113/106/64/79/80/90.
   - `help` → 114 (kVK_Help — the physical key PC Insert produces on macOS;
     deliberately NOT named `insert`, whose semantics macOS lacks).
   - `menu`/`context_menu`/`application` → 110 (0x6E; the Application/Context-
     Menu keycode Chromium maps `VKEY_APPS` to on macOS).
   - ANSI keypad: `kp_decimal` 65, `kp_multiply` 67, `kp_add` 69, `kp_clear` 71
     (also `numlock`/`num_lock` — PC Num Lock maps to KeypadClear on macOS),
     `kp_divide` 75, `kp_enter` 76, `kp_subtract` 78, `kp_equals` 81,
     `kp_0`-`kp_9` 82-89/91/92. Apple-style `keypad_*` spellings ride the same
     arms, `kp_plus`/`kp_minus`/`kp_equal` accepted as aliases.
   - a unit test pinning every added name to its keycode.
2. `platform-macos/src/tools/press_key.rs` — tool description: `f1-f12` → the
   new vocabulary so `tools/list` advertises honestly. (`hotkey.rs` needs no
   edit — its def already defers to the press_key vocabulary.)
3. `cua-driver/src/serve.rs` — `synara_native_revision` 17 → 18.

`key_name_to_code` is the only keyname→keycode table in the driver; it backs
`press_key`, `hotkey`, `interactive` input, and `type_text`'s physical path, so
all four surfaces inherit the names at once. No tool registration or input
schema changes are needed — the schemas take `key`/`keys` as free strings.

## Registration / revision needs

- `serve.rs` bump is **required**, not optional: the desktop host handshake
  (`apps/desktop/src/cuaDriverHost.ts:944`) rejects a driver whose
  `synara_native_revision` differs from the pin.
- `packages/shared/src/cuaDriverRelease.json` must then carry
  `"nativeRevision": 18` plus the rebuilt binary's `sha256` and `patchSha256`.
  That pin update is serialized through the normal driver release pipeline —
  the numbers can't be filled in here because they hash a build that doesn't
  exist yet.
- Synara-side needs nothing for the new names: `cuaKey` passes them through
  untouched and the driver refusal was the only gate.

## Deliberately not added

- `insert` — macOS has no Insert key. `help` (114) is the honest physical key;
  Synara keeps refusing `insert`/`ins` with `unsupported_operation`.
- Keypad navigation names (`kp_home`, `kp_insert`, `kp_delete`, `kp_begin`,
  `kp_tab`, `kp_space`, `kp_f1`-`kp_f4`, `kp_separator`, `kp_page_up`,
  `kp_page_down`, `kp_left/right/up/down`) — no macOS keycodes exist; macOS
  keypads are always in the "digit" state.
- Right-side modifiers (`shift_r`, `ctrl_r`, `alt_r`, `cmd_r`, `super_r`,
  `option_r`, `control_r`) — codes exist (60/62/61/54) but wiring them as
  held modifiers also needs `is_modifier`, `modifier_key_code_and_flag` and
  `modifier_flags` updates plus Synara's chord set; a left-spelling→generic
  map covers the common xdotool spellings meanwhile. Follow-up candidate.
- Volume/brightness/media keys — outside the Codex parity list.
- `print_screen`, `scroll_lock`, `pause`, `num_lock` as toggle — no macOS
  equivalents (`numlock`/`num_lock` → kp_clear is included as the physical-
  key equivalent only).

## Verification status

- All keycodes are Apple kVK\_\* constants (verified against the public Events.h
  enumeration and Chromium's macOS keycode table for the 0x6E context-menu
  code).
- UNVERIFIED until a live run: actual delivery of kp\_\*/f13-f20/menu/help events
  to a target window (post path is shared with proven keys, but no live
  fixture has pressed them); whether `menu` (110) reaches an app's
  context-menu handling on this macOS build.
