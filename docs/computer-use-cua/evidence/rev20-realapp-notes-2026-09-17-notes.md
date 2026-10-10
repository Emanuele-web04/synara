# rev-20 real-app Notes.app certification, 2026-09-17 — notes

Provenance: driver 0.28.2 / native rev 20 / patch sha
a53aca2e440161a2776a255fa8a9c856ddb4dada69927fd5bab08fc6b936623b
(packages/shared/src/cuaDriverRelease.json). Packaged binary
apps/desktop/resources/cua-driver/cua-driver (sha256
601382877c7af04543a32959ddff31743425a8d4fdfc4d1d5529d5c1f03589c4) served
by an external trusted host — `CuaDriverHost` spawned from a shell whose
ancestry holds TCC trust (the canary external-endpoint pattern documented
in belief-canary-runbook.md), capability ≥ 32 chars, endpoint
synara-cua-cyREYK/host.sock.

Target: a fresh Notes instance launched `open -g -j -n -a Notes`
(pid 30289). The app presented two first-run sheets while hidden — a
welcome sheet (AXSheet, "Continue") and a "Turn On iCloud" alert
(AXSheet, "Cancel") — both dismissed via driver `click` with
`{element_token, action:"press"}` (AXPress) while the app was still
hidden. Notes then self-unhid after onboarding. The main window
(window_id 774, "Notes", 1000x660) was the target throughout.

Method (mirrors the rev-17 TextEdit real-app run):

- `{"method":"call","name":"<tool>","args":{...},"capability":<cap>}` —
  one newline-delimited JSON request per unix-socket connection; reply
  envelope `{ok, result:{structuredContent,...}, error?, effect?,
desktopEpoch}` verified against
  apps/desktop/src/cuaDriverHost.ts.
- Operator front process sampled via
  `osascript -e 'tell application "System Events" to name of first
application process whose frontmost is true'` before and after.

Results (full transcript in the companion -report.json):

- Observation: get_window_state returned the bounded AX tree
  (elements_complete=false) plus a valid window screenshot once visible
  (screenshot_frame_valid=true, freshness captured_current_space).
  Element tokens are snapshot-scoped and rotate (s00000004:8 ->
  s0000000c:8 ...); a forged token refuses stale_element_token.
- Exact targeting: AXTextArea "Note Body Text View" resolved by
  element_token; toolbar "New Note" pressed via named AX action.
- Semantic write: set_value into the body returned effect=confirmed with
  value_readback evidence (1157 ms); independent get_window_state
  read-back matched exactly. Also confirmed while deliberately re-hidden
  via set_app_visibility{hidden:true} — hidden windows stay addressable
  for semantic writes, matching the documented hidden-workspaces
  contract.
- select_text {start:0,length:5}: confirmed via value_readback.
- invoke_menu Edit->Copy: dispatched (route accessibility, honest
  effect=unverifiable); clipboard_read {include_text:true} then returned
  "REV20" with com.apple.notes.richtext among the types — and so did
  `osascript 'the clipboard as string'`. On one of three attempts (select
  6..10 immediately followed by Copy, no settle) the copy did not land;
  the driver reported unverifiable, never a false confirmed.
- verify_state: value_equals matching predicate => satisfied (352 ms);
  mismatching => unsatisfied (5.1 s after 28 stability samples).
- Cancellation: with the window visible, a force_synthetic type_text of
  2000 'K' chars was interrupted by `{"method":"stop"}` after ~400 ms of
  streaming: stop returned in 425 ms, the in-flight call replied
  native_input_cancelled, and exactly 4 chars landed — a strict prefix of
  the request, visible in the note body. The generation retired
  (driver pid 57569 -> 58806) and the next call spawned a fresh
  handshaken generation; frontmost stayed TextEdit. An earlier stop sent
  while an accessibility-route type_text (4800 chars) was in flight
  could not interrupt the atomic AX write — the type completed
  (delivered_count 4800, confirmed) and the generation still retired
  cleanly (30101 -> 51735). Both behaviours are correct; only the
  synthetic route is interruptible mid-string.
- Background delivery: frontmost was "TextEdit" before and after every
  phase, including set_app_visibility show/hide — zero focus theft.
- Refusals (all clean non-dispatches): type_text force_synthetic on the
  hidden window => input_target_unavailable; type_text of 6000
  synthetic chars => type_text_synthesis_budget_exceeded (max chunk
  2578, delivered_chars 0, retryable); set_value on AXButton =>
  ax_action_refused; press_key "insert" => delivery_failed
  (Unknown key name); invoke_menu bogus path => menu_path_unavailable;
  forged element_token => stale_element_token; kill_app on a process not
  launched by this runtime => foreign_process_termination_denied; wrong
  capability => "Computer host authority is required."; unknown tool
  name => "Unsupported computer host request." (both not-dispatched).

Anomalies / findings:

1. AX index addressing (same family as the TextEdit rev-17 finding):
   `tell application "System Events" ... value of text area 1 of
window 1` fails with error -1719 invalid index — the note body lives
   at `text area 1 of scroll area 3 of splitter group 1 of window 1`, so
   direct class+index addressing cannot reach it. The deep path reads
   the written value correctly. The driver's element_token resolution
   is unaffected; only ad-hoc index lookups are fragile.
2. Notes' second listed window (id 773, empty, never on-screen) is
   visible to CGWindowList but has no AX content and is invisible to
   System Events `every window` — harmless enumeration divergence.
3. check_input_ready reported ready:true while the app was hidden —
   the flag reports driver admission readiness, not target visibility;
   synthetic input was still correctly refused input_target_unavailable.
4. invoke_menu delivery.mode reports "foreground" — it describes the
   menu-press delivery class, not app activation; frontmost stayed
   TextEdit and the app was never activated.
5. clipboard_read returns text:null unless include_text:true is passed
   (privacy default; CuaComputerBackend.readClipboard already passes
   include_text — verified in source, no integration gap).
6. Hidden-window type_text is adaptive: with no insertion point it
   refuses input_target_unavailable; once the note body held a
   selection/cursor the same call took the accessibility route and
   landed (delivered_count 16, confirmed). force_synthetic always
   refuses while hidden.

Cleanup: Notes pid 30289 was quit after the run; the external host and
its driver generations were stopped. Other cua-driver processes on the
machine (pid 8012 — the running Synara Dev app; pid 27831 — a separate
concurrent certification host, socket synara-cua-mWE552) were not
launched by this run and were left running.

Raw transcript: docs/computer-use-cua/evidence/rev20-realapp-notes-2026-09-17-report.json
Screenshots: rev20-realapp-notes-2026-09-17-observation.png,
rev20-realapp-notes-2026-09-17-after-unhide.png
