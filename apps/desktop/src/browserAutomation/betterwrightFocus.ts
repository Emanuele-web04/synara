import type { WebContents } from "electron";
import { BrowserAutomationHostError } from "./hostErrors";

export function assertBackgroundBrowserInput(contents: WebContents): void {
  if (contents.isDestroyed()) throw new Error("Browser target is unavailable.");
  // Chromium routes guest keyboard input through the embedder's focused widget.
  // Page focus emulation does not isolate a <webview> from the user's composer.
  // Preserve the live guest and reject before input instead of replacing it.
  if (contents.getType() === "webview") {
    throw new BrowserAutomationHostError({ code: "BrowserBackgroundInputUnavailable" });
  }
  if (contents.isFocused()) {
    throw new BrowserAutomationHostError({
      code: "BrowserInterruptedByHuman",
      retryable: true,
      phase: "input",
      effectMayHaveCommitted: false,
    });
  }
}

/** Page focus for the worker's lifetime, without touching native or host DOM focus. */
export async function withBrowserPageFocus<T>(
  contents: WebContents,
  operation: () => Promise<T>,
): Promise<T> {
  assertBackgroundBrowserInput(contents);
  if (!contents.debugger.isAttached()) contents.debugger.attach("1.3");
  let succeeded = false;
  try {
    await contents.debugger.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: true });
    assertBackgroundBrowserInput(contents);
    const result = await operation();
    succeeded = true;
    return result;
  } finally {
    if (!contents.isDestroyed() && contents.debugger.isAttached()) {
      try {
        await contents.debugger.sendCommand("Emulation.setFocusEmulationEnabled", {
          enabled: false,
        });
      } catch (error) {
        // Keep the original cancellation/error, but never report a successful
        // operation when restoring the page's focus policy failed.
        if (succeeded) throw error;
      }
    }
  }
}
