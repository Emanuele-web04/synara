import type { BrowserToolName } from "@synara/contracts";

import type { BrowserAutomationVisibleRuntime } from "../browserManager";

const FOCUS_SENSITIVE_TOOLS = new Set<BrowserToolName>(["browser_run", "browser_screenshot"]);

/** Keep background page focus observable without stealing Synara's native focus. */
export async function withBrowserToolPageFocus<T>(
  runtime: BrowserAutomationVisibleRuntime,
  toolName: BrowserToolName,
  operation: () => Promise<T>,
): Promise<T> {
  const emulateFocus =
    FOCUS_SENSITIVE_TOOLS.has(toolName) && runtime.retainFocusAfterInput?.() === false;
  if (!emulateFocus) return operation();

  const contents = runtime.webContents;
  if (contents.isDestroyed()) throw new Error("Browser focus unavailable.");
  if (!contents.debugger.isAttached()) contents.debugger.attach("1.3");
  await contents.debugger.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: true });
  try {
    return await operation();
  } finally {
    if (!contents.isDestroyed() && contents.debugger.isAttached()) {
      // Cleanup must never mask the operation's own result or error.
      await contents.debugger
        .sendCommand("Emulation.setFocusEmulationEnabled", { enabled: false })
        .catch(() => {});
    }
  }
}
