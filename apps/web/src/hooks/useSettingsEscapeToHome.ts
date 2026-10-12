// FILE: useSettingsEscapeToHome.ts
// Purpose: Leave Settings with a bare Escape, the same way the rail's Home item does.
// Layer: Web hook

import { useEffect, useEffectEvent } from "react";

import { isShortcutDispatchSuspended } from "../keybindings";
import { hasOpenDismissibleOverlay, isEditableEventTarget } from "../lib/editableEventTarget";

/** Whether nothing else owns this Escape: no text field, open overlay, or shortcut recorder. */
function isUnclaimedBareEscape(event: KeyboardEvent): boolean {
  return (
    event.key === "Escape" &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.shiftKey &&
    !event.repeat &&
    !event.isComposing &&
    !event.defaultPrevented &&
    !isEditableEventTarget(event) &&
    !isShortcutDispatchSuspended() &&
    !hasOpenDismissibleOverlay()
  );
}

export function useSettingsEscapeToHome(enabled: boolean, goHome: () => void): void {
  const onGoHome = useEffectEvent(goHome);
  useEffect(() => {
    if (!enabled) return;
    // Overlays close on this same Escape and may unmount before it bubbles, so ownership is
    // read in capture phase; the bubble listener only acts if no handler consumed the key.
    let unclaimed = false;
    const onKeyDownCapture = (event: KeyboardEvent) => {
      unclaimed = isUnclaimedBareEscape(event);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (!unclaimed || event.defaultPrevented) return;
      unclaimed = false;
      event.preventDefault();
      onGoHome();
    };
    window.addEventListener("keydown", onKeyDownCapture, { capture: true });
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDownCapture, { capture: true });
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [enabled]);
}
