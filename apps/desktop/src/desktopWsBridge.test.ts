// FILE: desktopWsBridge.test.ts
// Purpose: Verifies desktop WebSocket URL resolution prefers DP Code env names with legacy fallback.

import { describe, expect, it } from "vitest";

import { normalizeDesktopWsUrl, resolveDesktopWsUrlFromEnv } from "./desktopWsBridge";

describe("desktopWsBridge", () => {
  it("normalizes non-empty WebSocket URL strings", () => {
    expect(normalizeDesktopWsUrl(" ws://127.0.0.1:1234/?token=test ")).toBe(
      "ws://127.0.0.1:1234/?token=test",
    );
  });

  it("rejects empty or non-string values", () => {
    expect(normalizeDesktopWsUrl("   ")).toBeNull();
    expect(normalizeDesktopWsUrl(null)).toBeNull();
  });

  it("prefers DPCODE_DESKTOP_WS_URL over legacy T3CODE_DESKTOP_WS_URL", () => {
    expect(
      resolveDesktopWsUrlFromEnv({
        DPCODE_DESKTOP_WS_URL: "ws://127.0.0.1:5000/?token=dp",
        T3CODE_DESKTOP_WS_URL: "ws://127.0.0.1:3773/?token=legacy",
      } as NodeJS.ProcessEnv),
    ).toBe("ws://127.0.0.1:5000/?token=dp");
  });

  it("falls back to T3CODE_DESKTOP_WS_URL for older launchers", () => {
    expect(
      resolveDesktopWsUrlFromEnv({
        T3CODE_DESKTOP_WS_URL: "ws://127.0.0.1:3773/?token=legacy",
      } as NodeJS.ProcessEnv),
    ).toBe("ws://127.0.0.1:3773/?token=legacy");
  });
});
