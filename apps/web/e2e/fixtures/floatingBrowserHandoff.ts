import type { WebviewTag } from "electron";

import {
  applyBrowserRendererGuestSlotStyle,
  applyBrowserWebviewPageZoom,
  applyBrowserWebviewPresentation,
  applyFloatingBrowserChromeSlotStyle,
  applyFloatingBrowserGuestSlotFrame,
  browserPanelRendererHandoff,
  ensureFloatingBrowserChromeWebview,
  floatingBrowserChromePark,
  getBrowserRendererGuestSlot,
  handoffBrowserGuestToDockedSurface,
  resolveBrowserRuntimePresentation,
  setFloatingBrowserChromeMenuOpen,
  type BrowserRendererGuestSlotBox,
} from "../../src/components/BrowserPanel.logic";

const FLOATING_RECT = { left: 600, top: 100, width: 320, height: 200 };
const SIDEBAR_RECT = { left: 510, top: 70, width: 460, height: 650 };

function box(element: HTMLElement): BrowserRendererGuestSlotBox {
  const rect = element.getBoundingClientRect();
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
}

// The production slot, park/take, presentation and chrome-preload paths run
// against real Electron guests here. React's cleanup ordering is covered by
// FloatingBrowserPanel.lifecycle.browser.tsx; this fixture owns native behavior.
export function createFloatingBrowserHandoffFixture(threadId: string) {
  let guest: WebviewTag | null = null;
  let tabId: string | null = null;
  let stage: HTMLElement | null = null;
  let chrome: WebviewTag | null = null;
  let chromeReady = false;
  let mode: "floating" | "sidebar" | "closed" = "floating";
  let navigations = 0;
  let parkKeptGuest = false;
  const messages: string[] = [];

  function showFloating() {
    if (!guest || !stage) throw new Error("Expected the mounted renderer guest.");
    mode = "floating";
    applyFloatingBrowserGuestSlotFrame(threadId, {
      rect: FLOATING_RECT,
      borderRadius: "16px",
      border: "1px solid #71717a",
      boxShadow: "0 12px 24px rgb(0 0 0 / 0.3)",
    });
    applyBrowserWebviewPresentation(stage, {
      floating: true,
      slotWidth: FLOATING_RECT.width,
      slotHeight: FLOATING_RECT.height,
      borderRadius: "16px",
    });
    const presentation = resolveBrowserRuntimePresentation({
      native: false,
      floating: true,
      desktopZoom: 1,
      rect: {
        x: FLOATING_RECT.left,
        y: FLOATING_RECT.top,
        width: FLOATING_RECT.width,
        height: FLOATING_RECT.height,
      },
    });
    applyBrowserWebviewPageZoom(guest, presentation.pageZoomFactor);
    const chromeSlot = floatingBrowserChromePark.take(threadId);
    chrome = ensureFloatingBrowserChromeWebview(chromeSlot) as WebviewTag;
    applyFloatingBrowserChromeSlotStyle(chromeSlot, FLOATING_RECT, { expanded: false });
    return presentation;
  }

  function showSidebar() {
    if (!guest || !stage || !tabId) throw new Error("Expected the mounted renderer guest.");
    const slot = getBrowserRendererGuestSlot(threadId);
    const parked = {
      tabId,
      webContentsId: guest.getWebContentsId(),
      stage,
      webview: guest,
      dispose: () => {
        guest?.remove();
        slot.remove();
      },
    };
    applyBrowserRendererGuestSlotStyle(slot, null);
    browserPanelRendererHandoff.parkGuest(threadId, parked);
    const taken = browserPanelRendererHandoff.takeParkedGuest(threadId);
    parkKeptGuest = taken === parked && taken.webview === guest && guest.isConnected;
    if (!parkKeptGuest) throw new Error("Handoff replaced the parked renderer guest.");
    handoffBrowserGuestToDockedSurface({ slot, host: SIDEBAR_RECT, stage, webview: guest });
    floatingBrowserChromePark.park(threadId);
    mode = "sidebar";
  }

  function close() {
    if (!guest || !stage || !tabId) throw new Error("Expected the mounted renderer guest.");
    const slot = getBrowserRendererGuestSlot(threadId);
    browserPanelRendererHandoff.parkGuest(threadId, {
      tabId,
      webContentsId: guest.getWebContentsId(),
      stage,
      webview: guest,
      dispose: () => {
        guest?.remove();
        slot.remove();
      },
    });
    browserPanelRendererHandoff.flushParkedGuest(threadId);
    floatingBrowserChromePark.flush(threadId);
    mode = "closed";
  }

  function mount(webview: WebviewTag, mountedTabId: string) {
    guest = webview;
    tabId = mountedTabId;
    stage = document.createElement("div");
    stage.dataset.floatingBrowserStage = "true";
    stage.append(webview);
    const slot = getBrowserRendererGuestSlot(threadId);
    // The real renderer's global stylesheet supplies this border-box sizing.
    slot.style.boxSizing = "border-box";
    slot.append(stage);
    webview.addEventListener("did-navigate", () => {
      navigations += 1;
    });
    webview.addEventListener("dom-ready", () => {
      if (mode === "floating") showFloating();
    });
    showFloating();
    chrome!.addEventListener("dom-ready", () => {
      chromeReady = true;
    });
    chrome!.addEventListener("ipc-message", (event) => {
      messages.push(event.channel);
      if (event.channel === "drag") {
        const slot = floatingBrowserChromePark.take(threadId);
        applyFloatingBrowserChromeSlotStyle(slot, FLOATING_RECT, { expanded: true });
        setFloatingBrowserChromeMenuOpen(chrome!, true);
      } else if (event.channel === "pop") {
        showSidebar();
      } else if (event.channel === "close") {
        close();
      }
    });
  }

  function snapshot() {
    if (!guest || !chrome || !stage) throw new Error("Expected both real Electron guests.");
    const slot = guest.parentElement?.parentElement;
    return {
      mode,
      navigations,
      parkKeptGuest,
      messages: [...messages],
      connected: guest.isConnected,
      guestId: guest.isConnected ? guest.getWebContentsId() : null,
      chromeId: chrome.isConnected && chromeReady ? chrome.getWebContentsId() : null,
      zoom: guest.isConnected ? guest.getZoomFactor() : null,
      slot: slot ? box(slot) : null,
      clipPath: stage.style.clipPath,
      guestClipPath: guest.style.clipPath,
      guestBorderRadius: guest.style.borderRadius,
      boxShadow: slot?.style.boxShadow ?? "",
    };
  }

  return { mount, showFloating, showSidebar, close, snapshot };
}

export type FloatingBrowserHandoffFixture = ReturnType<typeof createFloatingBrowserHandoffFixture>;
