# Background browser input

Browser tools keep their provider-session tab assignment separate from the user's selected
browser tab. Opening, navigating and acquiring an agent page does not activate a chat, pane,
browser tab or window. The legacy `show` tool argument is accepted for compatibility; presentation
is controlled by the user. Agent popups are added to the tab list without selecting them. OAuth
popups retain their original contents and opener, and ask the user to open the popup tab manually.

Native pages receive CDP input without `WebContents.focus()` or host-renderer focus changes.
The worker's page focus is emulated until its execution and transport have drained. Page focus
emulation is not proof of input isolation: the runtime test also checks both destination fields,
trusted click outcomes, unexpected composer blur events and native focus calls.

Human focus or input on the target page interrupts its active automation. Events on another tab
do not cancel the action or clear its download/credential attribution. An already focused
page rejects new automation until the user leaves it. Typing in the composer or changing chats
does not transfer focus to the agent page. Closing a background agent tab preserves the selected
tab. Existing input provenance, download guards, upload scope and cancellation remain in effect.

Electron's renderer-owned `<webview>` shares keyboard routing with its embedder. With page
focus emulation alone, a real Electron probe delivered guest text to the composer. These live
guests return `BrowserBackgroundInputUnavailable` before tool execution. They are not replaced,
reloaded, or converted. Manual browsing remains available; `browser_open` with `reuse: false`
creates a separate native page. This is an explicit limitation for legacy live guests.

## Automated verification

```sh
bun run --cwd apps/desktop smoke:browser-background
```

This uses Electron and the actual BetterWright worker, a temporary profile, a loopback server
on an ephemeral port, and synthetic pages. It checks visible/hidden native views, simultaneous
composer input, switching to another chat or selecting another tab and hiding its panel during execution, page identity/state, popup opener,
cancellation and simulated manual takeover. The default test window stays hidden. “Visible” in
this test means an attached native view; it does not mean the OS window is foreground.

CI runs it under Linux/Xvfb. The default test injects composer input through Chromium and simulates
takeover through the manager's manual tab-selection path. It is not evidence of physical
keyboard/IME behavior or OS foreground routing on every platform.

## Physical keyboard check

Build the fixture with the command above, then run:

```sh
cd apps/desktop
node_modules/.bin/electron .smoke/browser-background-input.mjs --interactive
```

The interactive fixture deliberately opens its own window. Keep typing in either composer while
the agent fills its field and clicks. Switch chats using the fixture buttons, and voluntarily
click the agent page to interrupt it. Check that no characters are lost or redirected, no window
is activated by agent actions, and manual input still works after cancellation. This fixture is
separate from the user's Synara data. A full Synara UI check should also cover a visible browser
beside the real composer, another chat/pane, IME composition, and manual OAuth completion.

Do not claim that a passing hidden-window test completes this interactive/platform gate.
