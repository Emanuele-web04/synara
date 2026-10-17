// Purpose: Verifies private IPC correlation and consumes updater authority before child launches.
// Layer: Server parent-channel boundary tests.
import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
});

async function fixture(connected = true) {
  vi.resetModules();
  const events = new EventEmitter();
  const messages: Array<Record<string, unknown>> = [];
  const environment = { SYNARA_DESKTOP_UPDATE_IPC: "1" };
  vi.stubGlobal("process", {
    ...process,
    platform: "darwin",
    env: environment,
    connected,
    send: connected
      ? (message: Record<string, unknown>, callback: (error: Error | null) => void) => {
          messages.push(message);
          callback(null);
        }
      : undefined,
    on: events.on.bind(events),
    once: events.once.bind(events),
  });
  const bridge = await import("./desktopUpdateBridge");
  bridge.initializeDesktopUpdateBridge();
  return { events, messages, environment, bridge };
}

describe("desktop updater parent channel", () => {
  it("consumes the marker and correlates only bounded responses with its pending request", async () => {
    const f = await fixture();
    expect(f.environment).not.toHaveProperty("SYNARA_DESKTOP_UPDATE_IPC");
    const result = f.bridge.requestDesktopUpdate({ action: "status", authority: "owner:session" });
    const response = {
      accepted: true,
      status: { supported: true, state: null, busy: false, message: null },
    };
    f.events.emit("message", {
      type: "synara:desktop-update:response",
      id: "unrelated",
      result: response,
    });
    f.events.emit("message", {
      type: "synara:desktop-update:response",
      id: f.messages[0]?.id,
      result: response,
    });
    await expect(result).resolves.toEqual(response);
  });

  it("rejects pending requests when its owned parent channel disconnects", async () => {
    const f = await fixture();
    const result = f.bridge.requestDesktopUpdate({ action: "status", authority: "owner:session" });
    f.events.emit("disconnect");
    await expect(result).rejects.toThrow("connection closed");
  });

  it("does not accept an inherited marker without a private IPC channel", async () => {
    const f = await fixture(false);
    expect(f.environment).not.toHaveProperty("SYNARA_DESKTOP_UPDATE_IPC");
    expect(f.bridge.desktopUpdateBridgeAvailable()).toBe(false);
    await expect(
      f.bridge.requestDesktopUpdate({ action: "status", authority: "owner:session" }),
    ).rejects.toThrow("unavailable");
    expect(f.messages).toHaveLength(0);
  });
});
