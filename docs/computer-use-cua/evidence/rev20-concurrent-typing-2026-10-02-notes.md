# rev-20 concurrent typing cert — operator foreground + agent background, 2026-10-02

Provenance: driver 0.28.2 / native rev 20 (packaged binary
`apps/desktop/resources/cua-driver/cua-driver`), external trusted
`CuaDriverHost` (shell-ancestry TCC). Host socket
`/tmp/.../synara-cua-mWE552/host.sock`.

## Setup

- FRONT target: `open -n -a TextEdit` → pid 39737, frontmost, window
  "Untitled" (wid 801). Simulated operator typing: `/tmp/human-typer.swift`
  posting real `CGEvent` keystrokes at `.cghidEventTap` (~14 chars/s for 6s,
  51 keystrokes delivered — indistinguishable from physical typing to the OS).
- AGENT target: `open -g -n -a TextEdit` → pid 39784 (never frontmost),
  window "Untitled 2" (wid 815), `AXTextArea` token `s00000003:1`.
- Active Space: 1 (the fullscreen Space 53 was not involved this run).

## Run

Agent `type_text` (`delivery_mode:"background"`, element-scoped) fired while
the human simulator was mid-stream:

- Agent: `delivered_count:27` ("||CONCURRENT-AGENT-STREAM||"), `effect:
confirmed`, `route: accessibility`, wall 2539 ms — inside the 6 s human
  typing window.
- Human sim: 51 keystrokes completed during the overlap.

## Independent verification (System Events reads)

- Background doc (pid 39784 wid 815):
  `AGENT-BG-TYPES-WHILE-HUMAN-TYPES-FRONT||CONCURRENT-AGENT-STREAM||synara-live-e2e`
  — only agent text appended to prior residue; **zero human keystroke
  leakage**.
- Front doc (pid 39737 wid 801):
  `OFF-SPACE-92227\nasdfhgzxcvbnm×~4` — only sim characters; **zero agent
  text leakage**.
- `frontmost` stayed TextEdit (pid 39737) before, during, and after.

## What this certifies

Concurrent typing: a real (HID-level) operator keystroke stream into the
frontmost application while the agent performs a background write into an
unfocused window of a different process — no focus theft, no event
cross-contamination in either direction. The earlier
`rev17-realapp-3target` run covers concurrent writes into multiple
background targets; this run covers the operator+agent interleave.

## Scope notes

- The agent route chosen was `accessibility` (semantic AX insertion), which
  is the driver's preferred background route for a unique exact element.
  Keystroke-level background typing (`pid_keyboard`) is refused by policy
  when the target pid has multiple windows (`same_pid_keyboard_ambiguity`)
  and was not the route exercised here.
- The stray `synara-live-e2e` / `OFF-SPACE-92227` residue in the documents
  is TextEdit unsaved-document restoration from the earlier live sessions —
  not contamination; the newly appended segments are exactly disjoint.
