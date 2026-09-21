# rev-20 real-app Calculator.app certification, 2026-09-17 — notes

Provenance: driver 0.28.2 / native rev 20 / patch sha
a53aca2e440161a2776a255fa8a9c856ddb4dada69927fd5bab08fc6b936623b
(packages/shared/src/cuaDriverRelease.json). Packaged binary
apps/desktop/resources/cua-driver/cua-driver (sha256
601382877c7af04543a32959ddff31743425a8d4fdfc4d1d5529d5c1f03589c4) served
by the same external trusted host as the Notes run (capability ≥ 32
chars, endpoint synara-cua-cyREYK/host.sock).

Target: a fresh Calculator instance launched `open -g -n -a Calculator`
(pid 30509, window_id 775, "Calculator", 230x408 at 350,559,
is_on_screen=true — `-g` leaves it backgrounded but the window is
rendered). A second pre-existing Calculator instance (pid 20803, not
launched by this run) was left untouched throughout; per-pid exact
targeting kept the two instances unambiguous.

Method: identical wire protocol to the Notes run — see
rev20-realapp-notes-2026-09-17-notes.md. Calculator has no text field;
the write rung is exercised by AXPress on digit/operator buttons
(element tokens), a synthetic press_key digit, and a coordinate click,
with the display read back through the driver's tree_markdown
AXStaticText and through Edit->Copy -> clipboard_read.

Results (full transcript in the companion -report.json):

- Observation: get_window_state returned 127 elements (window chrome,
  24 buttons, toolbar, full menu bar) and a valid 230x408 screenshot.
  background_input.routes reported accessibility / window_pointer /
  pid_keyboard all available; exact_window status "matched".
- Exact targeting: every button resolved by label to a fresh
  element_token each snapshot.
- Semantic write equivalent: AXPress on "7","8","Add","5","Equals" —
  each honestly effect=unverifiable (a button press has no readback
  evidence), each confirmed by the display read-back: "78" -> "785" ->
  "785+5" -> clipboard "790".
- Synthetic input: press_key "5" landed via route synthetic_events in
  the background, non-frontmost window (display "785"). A window_points
  coordinate click on "9" refused stale_geometry until
  expected_window_bounds {x:350,y:559,w:230,h:408} was supplied, then
  delivered via synthetic_events (display appended 9 ->
  "7,777,799") — the documented fresh-geometry guard, not a defect.
- invoke_menu Edit->Copy: dispatched (honest unverifiable);
  clipboard_read {include_text:true} returned "790" with
  com.apple.Calculator.expression among the types — the menu dispatch
  provably landed and Calculator's Copy yields the computed result.
- verify_state: Equals exists+enabled => satisfied (225 ms); a
  nonexistent-button predicate => status "unknown" with
  unknown_reason observation_unavailable (matches:0, 31 samples, ~5 s) —
  correct tri-state behaviour; unknown never collapses to unsatisfied.
- Cancellation: All Clear, then force_synthetic type_text of 2000 '7'
  keystrokes with `{"method":"stop"}` after ~400 ms: stop returned in
  437 ms, the in-flight call replied native_input_cancelled, and the
  display showed "77,777" — 5 digits of 2000 requested, app-visible
  proof of mid-flight interruption (a completed run would pin the
  ~16-digit cap). Generation retired (58806 -> 63901); a subsequent
  AXPress on "9" worked on the fresh generation (display "777,779").
- Background delivery: frontmost "TextEdit" before and after the whole
  matrix — zero focus theft.
- Refusals (all clean non-dispatches): set_value on a button =>
  ax_action_refused; press_key "insert" => delivery_failed; invoke_menu
  ["View","No Such Item"] => menu_path_unavailable (segment 1 — "View"
  resolved, the leaf did not); forged element_token =>
  stale_element_token; kill_app on the foreign (not runtime-launched)
  pid => foreign_process_termination_denied.

Anomalies / findings:

1. AX index addressing (same family as the TextEdit rev-17 finding):
   System Events enumerates Calculator's scroll area and digit buttons
   nested under `group 1 of splitter group 1 of group 1 of window 1`,
   but direct addressing fails — `scroll area 1 of window 1` => error
   -1719 invalid index, `button "7" of window 1` unresolvable.
   Element-token targeting is unaffected; index-based external
   verification is fragile on this app.
2. The Calculator display is an AXStaticText with no frame; it is
   absent from the bounded `elements` list and appears only in
   `tree_markdown`. Readback paths that worked: tree_markdown parse and
   Edit->Copy + clipboard_read. verify_state element predicates cannot
   target it (no frame/label), which is why the missing-element probe
   above returned unknown rather than unsatisfied.
3. invoke_menu reports delivery.mode "foreground" for menu dispatch —
   a delivery class, not activation; frontmost stayed TextEdit.
4. Two refusal envelope shapes coexist in the driver:
   `effect:"refused"` + code (ax_action_refused, stale_geometry,
   delivery_failed) and `status:"refused"` + refusal{code,message}
   (menu_path_unavailable, stale_element_token,
   foreign_process_termination_denied). Both map to not-dispatched at
   the adapter; noted for completeness.

Cleanup: Calculator pid 30509 was terminated after the run (pre-existing
pid 20803 left running, as were unrelated cua-driver processes 8012 and
27831 owned by other live sessions).

Raw transcript: docs/computer-use-cua/evidence/rev20-realapp-calculator-2026-09-17-report.json
Screenshots: rev20-realapp-calculator-2026-09-17-before.png,
rev20-realapp-calculator-2026-09-17-after.png
