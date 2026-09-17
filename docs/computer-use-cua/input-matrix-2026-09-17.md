# Decisive input matrix — Electron/Chromium on macOS (VM-verified, 2026-09-17)

Ground truth = DOM read-back via `executeJavaScript` in a live probe app
(`Electron.app/Contents/MacOS/Electron probe-app`), driven through the pinned
`cua-driver` 0.28.2 native rev 15 embedded socket. "Background" = TextEdit held
the real front process; probe never frontmost unless stated.

## Results

| Need             | Driver call                                              | Route                                         | Landed?                | Operator front preserved   | Notes                                                                                                                                        |
| ---------------- | -------------------------------------------------------- | --------------------------------------------- | ---------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Set field text   | `set_value`                                              | `accessibility` (AXValue write)               | **YES**                | YES — front never moved    | `input` DOM event fires (`changes:1`); React/controlled inputs see it. Driver reports `effect:unverifiable` — read-back bug, write DID land. |
| Real keystroke   | `press_key` `delivery_mode=foreground`                   | `global_input` (short-lived activate+restore) | **YES**                | YES — restored to TextEdit | `lastkey:"a"` observed in renderer keydown.                                                                                                  |
| Type text        | `type_text` `delivery_mode=foreground`                   | `global_input`                                | **YES**                | YES — restored             | `delivered_count:2`, per-char keydowns. Driver escalates verify to `pixel`.                                                                  |
| Insert at cursor | `type_text` `semantic_only`                              | `accessibility` (AXSelectedText)              | **NO**                 | —                          | Even with app frontmost + DOM-focused field. Chromium does not honour AXSelectedText writes into web content.                                |
| Background keys  | `press_key` (background)                                 | process-scoped CGEvent                        | **NO**                 | —                          | Multi-window pid: `same_pid_keyboard_ambiguity` refusal (correct). Single-window inactive: silently dropped, `hasFocus:false`.               |
| Focus belief     | probe stages 1–5 (AppKit/CPS posts)                      | —                                             | no key window created  | —                          | front process unchanged; `focusedWindow` destroyed to null in some stages.                                                                   |
| Front flip       | stage 6 `_SLPSSetFrontProcessWithOptions` + focus record | —                                             | front process DID flip | n/a                        | Still no key window; renderer still received no keys.                                                                                        |

## Conclusions

1. **Synthetic focus belief is empirically dead** for unlocking background
   keyboard input into Electron. Six stages, including a real front-process
   flip, cannot manufacture a usable key window. The Option-C "belief" premise
   does not survive contact with the hardware.

2. **Text insertion into Electron needs no belief at all**: `AXValue` writes
   land in the DOM, fire `input` events, and never touch the operator's front
   app. This single mechanism resolves the G5 three-window failure — the
   failing case routed to `type_text` semantic (AXSelectedText), the wrong tool.

3. **Real keystrokes are already solved by the driver**: `delivery_mode=
foreground` performs a short-lived front-process switch and restores the
   previous front app transparently. This is the "masked activation" rung —
   implemented natively, verified working, operator-invisible.

4. **Driver `effect:unverifiable` on landed `set_value`** is a read-back defect:
   the write is real (DOM proves it) but the driver's AX read-back misses it —
   likely stale snapshot/token or wrong attribute. Needs a patch fix so
   `verified` is reported truthfully; until then Synara must not treat
   `unverifiable` as failure for AXValue writes — it must re-read independently.

## Revised architecture

- **Text:** route insert/type into web-content text fields through `set_value`
  (read current value, compose, write) or `type_text` foreground for real
  typing. Never `semantic_only` on Electron.
- **Keys:** `delivery_mode=foreground` for real key events; driver's admission
  gate already refuses ambiguous process-scoped delivery.
- **Sidecar:** repurpose to theft-sampling + per-agent cursor only. Belief
  stages removed — empirically disproven. Short-lived activation already lives
  in the driver.
- **Fixture:** three-window semantic-text case should route `set_value`; rerun
  to confirm G5 closes.

Evidence: probe app `/private/tmp/cua-exp/probe-app`, driver client
`/private/tmp/cua-exp/driverctl*.py`, DOM logs in `/private/tmp/cua-exp/out.ndjson`.
