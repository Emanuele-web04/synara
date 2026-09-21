// FILE: agentCursorDesktopSync.test.ts
// Purpose: Guards the renderer → desktop mirror of the agent cursor colors:
//          exact payload, null for stock, no-op without the bridge, and a
//          failed send never escaping.

import { afterEach, describe, expect, it, vi } from "vitest";

import { pushAgentCursorStyleToDesktop } from "./agentCursorDesktopSync";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("pushAgentCursorStyleToDesktop", () => {
  it("forwards the resolved style to the desktop bridge", () => {
    const setCursorStyle = vi.fn(async () => undefined);
    vi.stubGlobal("window", { desktopBridge: { computer: { setCursorStyle } } });

    pushAgentCursorStyleToDesktop({ fill: "#aabbcc" });
    expect(setCursorStyle).toHaveBeenCalledWith({ fill: "#aabbcc" });

    pushAgentCursorStyleToDesktop(null);
    expect(setCursorStyle).toHaveBeenLastCalledWith(null);
  });

  it("is a no-op in a plain browser", () => {
    vi.stubGlobal("window", {});
    expect(() => pushAgentCursorStyleToDesktop({ fill: "#aabbcc" })).not.toThrow();

    // A desktop build from before this bridge existed also stays a no-op.
    vi.stubGlobal("window", { desktopBridge: {} });
    expect(() => pushAgentCursorStyleToDesktop({ fill: "#aabbcc" })).not.toThrow();
  });

  it("swallows a failed send instead of surfacing it", async () => {
    const setCursorStyle = vi.fn(async () => {
      throw new Error("host unavailable");
    });
    vi.stubGlobal("window", { desktopBridge: { computer: { setCursorStyle } } });

    expect(() => pushAgentCursorStyleToDesktop({ rim: "#112233" })).not.toThrow();
    // The rejection is consumed by the helper itself, not by the caller.
    await Promise.resolve();
    expect(setCursorStyle).toHaveBeenCalledTimes(1);
  });
});
