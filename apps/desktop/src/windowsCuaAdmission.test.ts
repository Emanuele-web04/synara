import { describe, expect, it } from "vitest";

import { shouldFailClosedOnUnacknowledgedRetire } from "./cuaDriverHost";
import { windowsCuaAdmissionRefusal } from "./windowsCuaAdmission";

describe("Windows CUA admission", () => {
  it("refuses the sustained-hold drag before anything is dispatched", () => {
    const refusal = windowsCuaAdmissionRefusal("drag");
    expect(refusal).toMatchObject({
      ok: true,
      effect: "not-dispatched",
      result: {
        isError: true,
        structuredContent: {
          effect: "refused",
          code: "windows_held_input_unavailable",
        },
      },
    });
    expect(
      refusal?.result?.structuredContent &&
        typeof refusal.result.structuredContent === "object" &&
        "message" in refusal.result.structuredContent,
    ).toBe(true);
  });

  it.each([
    "click",
    "move_cursor",
    "scroll",
    "type_text",
    "press_key",
    "hotkey",
    "set_value",
    "select_text",
    "clipboard_read",
    "clipboard_write",
    "launch_app",
    "bring_to_front",
    "invoke_menu",
    "set_window_frame",
    "set_window_minimized",
    "set_app_visibility",
    "kill_app",
    "check_permissions",
    "list_windows",
    "get_window_state",
    "get_screen_size",
    "browser_prepare",
    "browser_click",
  ])("leaves %s to the driver", (name) => {
    expect(windowsCuaAdmissionRefusal(name)).toBeUndefined();
  });
});

describe("Windows unacknowledged retire", () => {
  it("fails closed only for native input in flight without a cleanup route", () => {
    expect(
      shouldFailClosedOnUnacknowledgedRetire({
        platform: "win32",
        cancellationReady: false,
        nativeInputInFlight: true,
      }),
    ).toBe(true);
    // No native input in flight — idle or browser-only, which holds no OS
    // input — so terminating the generation clears instead of failing closed.
    expect(
      shouldFailClosedOnUnacknowledgedRetire({
        platform: "win32",
        cancellationReady: false,
        nativeInputInFlight: false,
      }),
    ).toBe(false);
    // A cleanup acknowledgement path means releases are verified, not assumed.
    expect(
      shouldFailClosedOnUnacknowledgedRetire({
        platform: "win32",
        cancellationReady: true,
        nativeInputInFlight: true,
      }),
    ).toBe(false);
  });

  it.each(["darwin", "linux"] as const)("never changes %s retire behavior", (platform) => {
    expect(
      shouldFailClosedOnUnacknowledgedRetire({
        platform,
        cancellationReady: false,
        nativeInputInFlight: true,
      }),
    ).toBe(false);
  });
});
