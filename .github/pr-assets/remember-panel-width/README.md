# Remember right dock width

Captured in Chromium on Linux with the real `RightDock` and `Sidebar` components
in an isolated test fixture. Terminal content is a placeholder; no provider or
shell session is involved.

Both screenshots show thread A after resizing its dock from 640 px to 760 px,
switching to thread B, and returning to thread A. The fixture remounts the dock
on each thread change.

- `before.png`: the `main` implementation resets the dock to 640 px.
- `after.png`: the fix restores the saved 760 px width.
- `interaction.webm`: Chromium recording of the fixed resize and A/B/A navigation.
  Recorder startup is trimmed; the interaction runs at its original speed.

Automated browser regressions also cover independent widths in a reused dock,
pane kind changes, collapse/reopen, maximize/restore, and remounting.
Packaged Electron behavior on macOS and Windows was not tested.
