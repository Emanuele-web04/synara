# OpenCode isolated sign-in evidence

Captured on Linux with OpenCode 2.1.4, disposable account homes, and an existing
default OpenCode background service. The images render recorded native PTY
output in xterm.js at 100 columns and 28 rows.

- [Before](before.png): `opencode auth login` tries to start the isolated
  account's background service on the occupied default port and fails.
- [After](after.png): `opencode auth login --standalone` displays the integration
  picker. A down-arrow key moves the selection to OpenCode Console.
- [Interaction](interaction.webm): replay of that recorded picker output and
  arrow-triggered redraw, with pauses added for readability.

The captures stop at integration selection. Authentication, browser consent,
and model inference were not performed.
