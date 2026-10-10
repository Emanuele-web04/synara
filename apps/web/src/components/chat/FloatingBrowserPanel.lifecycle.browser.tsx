import "../../index.css";

import { ThreadId } from "@synara/contracts";
import { useState } from "react";
import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const { disposeGuest } = vi.hoisted(() => ({ disposeGuest: vi.fn() }));

vi.mock("../../env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../env")>()),
  isElectron: true,
}));

vi.mock("../BrowserPanel", async () => {
  const { useLayoutEffect } = await import("react");
  const { browserPanelRendererHandoff, getBrowserRendererGuestSlot } =
    await import("../BrowserPanel.logic");
  return {
    default: function Guest({ threadId }: { threadId: ThreadId }) {
      useLayoutEffect(() => {
        const slot = getBrowserRendererGuestSlot(threadId);
        const stage = document.createElement("div");
        const webview = document.createElement("webview");
        stage.append(webview);
        slot.append(stage);
        // Match BrowserPanel's real layout teardown so the parent is tested
        // against React's parent-before-child layout cleanup order.
        return () => {
          browserPanelRendererHandoff.parkGuest(threadId, {
            tabId: "tab-lifecycle",
            webContentsId: 41,
            stage,
            webview,
            dispose: () => {
              disposeGuest(threadId);
              slot.remove();
            },
          });
        };
      }, [threadId]);
      return <div>Browser guest fixture</div>;
    },
  };
});

import {
  browserPanelRendererHandoff,
  findFloatingBrowserChromeSlot,
  floatingBrowserChromePark,
} from "../BrowserPanel.logic";
import { FloatingBrowserPanel } from "./FloatingBrowserPanel";
import { useFloatingBrowserRequestStore } from "./floatingBrowserRequestStore";

function Harness({ threadId }: { threadId: ThreadId }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="relative h-[600px] w-[900px] overflow-hidden">
      {open && (
        <FloatingBrowserPanel
          threadId={threadId}
          onClose={() => setOpen(false)}
          onPopToSidebar={() => setOpen(false)}
        />
      )}
    </div>
  );
}

it.each(["close", "pop"] as const)(
  "finishes the %s intent after child guest layout teardown",
  async (intent) => {
    disposeGuest.mockClear();
    const threadId = ThreadId.makeUnsafe(`floating-lifecycle-${intent}`);
    const mounted = await render(<Harness threadId={threadId} />);
    try {
      await expect.element(mounted.getByText("Browser guest fixture")).toBeVisible();
      const chrome = findFloatingBrowserChromeSlot(threadId)?.querySelector("webview");
      if (!chrome) throw new Error("Floating browser chrome is missing");
      chrome.dispatchEvent(Object.assign(new Event("ipc-message"), { channel: intent, args: [] }));
      await vi.waitFor(() => {
        expect(document.querySelector("[data-floating-browser-panel]")).toBeNull();
      });
      if (intent === "close") {
        await vi.waitFor(() => expect(disposeGuest).toHaveBeenCalledExactlyOnceWith(threadId));
        expect(browserPanelRendererHandoff.takeParkedGuest(threadId)).toBeNull();
        expect(findFloatingBrowserChromeSlot(threadId)).toBeNull();
      } else {
        expect(disposeGuest).not.toHaveBeenCalled();
        const guest = browserPanelRendererHandoff.takeParkedGuest(threadId);
        expect(guest?.webContentsId).toBe(41);
        guest?.dispose();
      }
    } finally {
      await mounted.unmount();
      browserPanelRendererHandoff.flushParkedGuest(threadId);
      floatingBrowserChromePark.flush(threadId);
      useFloatingBrowserRequestStore.getState().dismiss(threadId);
    }
  },
);
