// FILE: subframeNavigationGuard.ts
// Purpose: Keeps every subframe in the app window on the document the app wrote into it.
// Layer: Desktop main-process window hardening
// Exports: isAllowedAppSubframeNavigation, attachAppSubframeNavigationGuard

import type { WebContents } from "electron";

/**
 * The app window embeds untrusted documents only as `srcdoc` frames (inline
 * visuals). A page can still navigate its own frame - by script, a meta
 * refresh, or a link - and carry data out in the URL; content security policy
 * cannot stop that. Here it can: a subframe may load only its inline document.
 * The in-app browser uses `<webview>` guests, which are separate WebContents.
 */
export function isAllowedAppSubframeNavigation(url: string): boolean {
  return url === "about:srcdoc" || url === "about:blank";
}

export function attachAppSubframeNavigationGuard(webContents: Pick<WebContents, "on">): void {
  webContents.on("will-frame-navigate", (event) => {
    if (!event.isMainFrame && !isAllowedAppSubframeNavigation(event.url)) {
      event.preventDefault();
    }
  });
}
