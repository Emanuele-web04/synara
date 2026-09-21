import type { WebContents } from "electron";
import { describe, expect, it, vi } from "vitest";
import { withBrowserPageFocus } from "./betterwrightFocus";

function fixture() {
  const contents = {
    getType: vi.fn(() => "browserView"),
    isDestroyed: vi.fn(() => false),
    isFocused: vi.fn(() => false),
    focus: vi.fn(),
    hostWebContents: { executeJavaScript: vi.fn() },
    debugger: {
      isAttached: vi.fn(() => true),
      attach: vi.fn(),
      sendCommand: vi.fn(async (_method: string, _params: { enabled: boolean }) => ({})),
    },
  };
  const run = <T>(operation: () => Promise<T>) =>
    withBrowserPageFocus(contents as unknown as WebContents, operation);
  return { contents, run };
}

describe("background page focus", () => {
  it("emulates only page focus without touching the user control or native focus", async () => {
    const f = fixture();
    expect(
      await f.run(async () => {
        expect(f.contents.debugger.sendCommand).toHaveBeenLastCalledWith(
          "Emulation.setFocusEmulationEnabled",
          { enabled: true },
        );
        expect(f.contents.focus).not.toHaveBeenCalled();
        expect(f.contents.hostWebContents.executeJavaScript).not.toHaveBeenCalled();
        return "page result";
      }),
    ).toBe("page result");
    expect(f.contents.debugger.sendCommand).toHaveBeenLastCalledWith(
      "Emulation.setFocusEmulationEnabled",
      { enabled: false },
    );
    expect(f.contents.focus).not.toHaveBeenCalled();
  });

  it.each(["guest", "human focused", "destroyed"])(
    "rejects %s before executing",
    async (reason) => {
      const f = fixture();
      if (reason === "guest") f.contents.getType.mockReturnValue("webview");
      if (reason === "human focused") f.contents.isFocused.mockReturnValue(true);
      if (reason === "destroyed") f.contents.isDestroyed.mockReturnValue(true);
      const operation = vi.fn();
      await expect(f.run(operation)).rejects.toThrow();
      expect(operation).not.toHaveBeenCalled();
      expect(f.contents.debugger.sendCommand).not.toHaveBeenCalled();
      expect(f.contents.focus).not.toHaveBeenCalled();
    },
  );

  it("clears emulation after an operation fails without moving user focus", async () => {
    const f = fixture();
    await expect(
      f.run(async () => {
        throw new Error("operation failed");
      }),
    ).rejects.toThrow("operation failed");
    expect(f.contents.debugger.sendCommand).toHaveBeenLastCalledWith(
      "Emulation.setFocusEmulationEnabled",
      { enabled: false },
    );
    expect(f.contents.focus).not.toHaveBeenCalled();
  });

  it("lets manual takeover during initialization win", async () => {
    const f = fixture();
    f.contents.debugger.sendCommand.mockImplementationOnce(async () => {
      f.contents.isFocused.mockReturnValue(true);
      return {};
    });
    const operation = vi.fn();
    await expect(f.run(operation)).rejects.toMatchObject({
      browserError: { code: "BrowserInterruptedByHuman" },
    });
    expect(operation).not.toHaveBeenCalled();
    expect(f.contents.debugger.sendCommand).toHaveBeenLastCalledWith(
      "Emulation.setFocusEmulationEnabled",
      { enabled: false },
    );
  });

  it("restores focus policy even when initialization rejects after applying it", async () => {
    const f = fixture();
    f.contents.debugger.sendCommand.mockRejectedValueOnce(new Error("initialization failed"));
    const operation = vi.fn();
    await expect(f.run(operation)).rejects.toThrow("initialization failed");
    expect(operation).not.toHaveBeenCalled();
    expect(f.contents.debugger.sendCommand).toHaveBeenLastCalledWith(
      "Emulation.setFocusEmulationEnabled",
      { enabled: false },
    );
  });
});
