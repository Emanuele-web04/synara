# rev-17 real-app 3-target concurrency run, 2026-09-22 — notes

Provenance: driver 0.28.2 / native rev 17 / patch sha
388f1693f94c32218d8a7b6c31c5280c6bae95341a64676b232b82dff7573259
(packages/shared/src/cuaDriverRelease.json). Packaged binary
apps/desktop/resources/cua-driver/cua-driver served by an external trusted
host (CuaDriverHost spawned from a shell whose ancestry holds TCC trust —
the canary/fixture external-endpoint pattern documented in
belief-canary-runbook.md).

Targets: three SEPARATE TextEdit instances launched `open -g -n -a
TextEdit` — three distinct real AppKit pids (38638, 38642, 38640), each
with an on-screen "Untitled" document window. These are real apps, not
fixture-owned windows; this exercises the concurrent-semantic-lanes path
across process boundaries, complementing the same-pid 3-window fixture
case (three-window-focus-neutral-semantic-text).

Method:

- Resolved each window's AXTextArea via get_window_state element tokens.
- Fired three set_value writes CONCURRENTLY (Promise.all) — distinct text
  per target (REAL-APP-{A,B,C}-CONCURRENT).
- Operator front process sampled via AppleScript before and after.

Results:

- Wall time 3371 ms for all three writes.
- All three: effect="confirmed", route="accessibility",
  evidence=["value_readback"].
- Independent read-back via get_window_state: all three document values
  exactly matched the written strings.
- Front process: "ghostty" before AND after — zero focus theft; the
  operator's real foreground app was untouched while three real
  background apps received writes.

What this certifies: the "3 concurrent real-app targets + human
foreground isolation" certification rung at the semantic (AX) input level
for identical real AppKit apps. Distinct app families (e.g. TextEdit +
Notes + Stickies) and pointer-path concurrency in real apps remain
additional rungs; the fixture already covers same-pid 3-window
concurrency and focus-neutrality.

Raw transcript: docs/computer-use-cua/evidence/rev17-realapp-3target-2026-09-22-report.json
