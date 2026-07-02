// FILE: browserShortcuts.ts
// Purpose: Shared key-chord matching for in-app browser shortcuts so the renderer and
//   desktop main process agree on the same bindings without duplicating modifier logic.
// Layer: Shared runtime utility
// Depends on: nothing

export const BROWSER_COPY_LINK_TOAST_TITLE = "Link copied";

// Normalized chord shape both Electron `Input` events and DOM KeyboardEvents map onto.
export interface BrowserShortcutChord {
  readonly meta: boolean;
  readonly ctrl: boolean;
  readonly shift: boolean;
  readonly alt: boolean;
  readonly key: string;
}

// Copy-link chord: Cmd+Shift+C on macOS, Ctrl+Shift+C elsewhere.
export function isBrowserCopyLinkChord(chord: BrowserShortcutChord, isMac: boolean): boolean {
  if (chord.key.toLowerCase() !== "c") {
    return false;
  }
  if (!chord.shift || chord.alt) {
    return false;
  }
  return isMac ? chord.meta && !chord.ctrl : chord.ctrl && !chord.meta;
}
