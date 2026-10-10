import type { BrowserToolName } from "@synara/contracts";
import type { WebContents } from "electron";
import { describe, expect, it, vi } from "vitest";

import type { BrowserAutomationVisibleRuntime } from "../browserManager";
import { withBrowserToolPageFocus } from "./browserToolPageFocus";

function fixture(visible = false) {
  const debuggerApi = {
    isAttached: vi.fn(() => true),
    attach: vi.fn(),
    sendCommand: vi.fn(async () => ({})),
  };
  const contents = {
    debugger: debuggerApi,
    focus: vi.fn(),
    isDestroyed: vi.fn(() => false),
  } as unknown as WebContents;
  const runtime = {
    webContents: contents,
    retainFocusAfterInput: () => visible,
  } as BrowserAutomationVisibleRuntime;
  return { contents, debuggerApi, runtime };
}

describe("browser tool page focus", () => {
  it.each<BrowserToolName>(["browser_run", "browser_screenshot"])(
    "emulates focus around background %s without taking native focus",
    async (toolName) => {
      const f = fixture();
      const operation = vi.fn(async () => {
        expect(f.debuggerApi.sendCommand.mock.calls).toEqual([
          ["Emulation.setFocusEmulationEnabled", { enabled: true }],
        ]);
        expect(f.contents.focus).not.toHaveBeenCalled();
        return "focused result";
      });

      await expect(withBrowserToolPageFocus(f.runtime, toolName, operation)).resolves.toBe(
        "focused result",
      );
      expect(f.debuggerApi.sendCommand.mock.calls).toEqual([
        ["Emulation.setFocusEmulationEnabled", { enabled: true }],
        ["Emulation.setFocusEmulationEnabled", { enabled: false }],
      ]);
    },
  );

  it("attaches the shared debugger before emulating focus", async () => {
    const f = fixture();
    f.debuggerApi.isAttached.mockReturnValue(false);
    f.debuggerApi.attach.mockImplementation(() => {
      f.debuggerApi.isAttached.mockReturnValue(true);
    });

    await withBrowserToolPageFocus(f.runtime, "browser_run", async () => {});

    expect(f.debuggerApi.attach).toHaveBeenCalledWith("1.3");
    expect(f.debuggerApi.sendCommand).toHaveBeenCalledTimes(2);
  });

  it("restores emulation after failure without masking the operation error", async () => {
    const f = fixture();

    await expect(
      withBrowserToolPageFocus(f.runtime, "browser_run", async () => {
        throw new Error("operation failed");
      }),
    ).rejects.toThrow("operation failed");
    expect(f.debuggerApi.sendCommand).toHaveBeenLastCalledWith(
      "Emulation.setFocusEmulationEnabled",
      { enabled: false },
    );
  });

  it.each([
    ["browser_run" as const, true],
    ["browser_logs" as const, false],
  ])("keeps %s on the native path when visible=%s", async (toolName, visible) => {
    const f = fixture(visible);

    await withBrowserToolPageFocus(f.runtime, toolName, async () => {});

    expect(f.debuggerApi.attach).not.toHaveBeenCalled();
    expect(f.debuggerApi.sendCommand).not.toHaveBeenCalled();
  });
});
