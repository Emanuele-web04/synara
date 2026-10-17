// FILE: subframeNavigationGuard.ts
// Purpose: Keeps embedded documents contained while allowing app-owned workspace frames to load.
// Layer: Desktop main-process window hardening
// Exports: isAllowedAppSubframeNavigation, attachAppSubframeNavigationGuard

import type { WebContents } from "electron";

/**
 * The app window embeds untrusted documents as `srcdoc` frames (inline
 * visuals). A page can still navigate its own frame - by script, a meta
 * refresh, or a link - and carry data out in the URL; content security policy
 * cannot stop that. Only the main app may initialize a fresh workspace frame;
 * an initialized workspace may reload that same shell to retry its connection.
 * The in-app browser uses `<webview>` guests, which are separate WebContents.
 */
export function isAllowedAppSubframeNavigation(url: string): boolean {
  return url === "about:srcdoc" || url === "about:blank";
}

export function attachAppSubframeNavigationGuard(
  webContents: Pick<WebContents, "on" | "mainFrame">,
): void {
  webContents.on("will-frame-navigate", (event) => {
    if (event.isMainFrame || isAllowedAppSubframeNavigation(event.url)) return;
    const main = webContents.mainFrame;
    // WorkspacePanels loads the shell into a fresh direct child, with identity
    // held in memory. Inline visuals cannot claim this exception or add URL data.
    if (event.frame?.parent === main) {
      const workspaceUrl = new URL(main.url);
      workspaceUrl.search = "";
      workspaceUrl.hash = "";
      if (workspaceUrl.protocol === "http:" || workspaceUrl.protocol === "https:")
        workspaceUrl.pathname = "/";
      const documentUrl = workspaceUrl.toString();
      const initialized = event.frame.url === documentUrl;
      const ownedNavigation =
        (event.initiator === main &&
          (initialized || event.frame.url === "" || event.frame.url === "about:blank")) ||
        (initialized && event.initiator === event.frame);
      if (ownedNavigation && event.url === documentUrl) return;
    }
    event.preventDefault();
  });
}
