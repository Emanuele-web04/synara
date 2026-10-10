import { describe, expect, it } from "vitest";

import {
  CUA_ACTION_TOOLS,
  CUA_BROWSER_TOOLS,
  CUA_READ_TOOLS,
} from "@synara/shared/cuaDriverProtocol";

import { linuxBrowserCallIsReadOnly, linuxCuaAdmissionRefusal } from "./linuxCuaAdmission";

const FOCUS_NEUTRAL_ACTIONS = new Set([
  "clipboard_read",
  "clipboard_write",
  "kill_app",
  "move_cursor",
]);

describe("Linux native admission", () => {
  it("identifies only passive browser routes for the Escape admission gate", () => {
    expect(linuxBrowserCallIsReadOnly("get_browser_state", {})).toBe(true);
    expect(linuxBrowserCallIsReadOnly("browser_dialog", { action: "inspect" })).toBe(true);
    expect(linuxBrowserCallIsReadOnly("browser_prepare", {})).toBe(true);
    expect(
      linuxBrowserCallIsReadOnly("browser_prepare", { allow_launch: false, strategy: null }),
    ).toBe(true);
    for (const name of CUA_BROWSER_TOOLS) {
      if (name === "get_browser_state") continue;
      expect(linuxBrowserCallIsReadOnly(name, { allow_launch: true, action: "accept" }), name).toBe(
        false,
      );
    }
    expect(
      linuxBrowserCallIsReadOnly("browser_prepare", {
        allow_launch: false,
        strategy: { kind: "existing_profile" },
      }),
    ).toBe(false);
    expect(linuxBrowserCallIsReadOnly("browser_prepare", { allow_launch: "false" })).toBe(false);
    expect(linuxBrowserCallIsReadOnly("unsupported_browser_call", {})).toBe(false);
  });

  it("keeps native observations and browser state available", () => {
    for (const name of [...CUA_READ_TOOLS, "get_browser_state"]) {
      expect(linuxCuaAdmissionRefusal(name, {}, undefined), name).toBeUndefined();
    }
  });

  it("allows only passive browser endpoint detection and dialog inspection", () => {
    for (const allow_launch of [undefined, false]) {
      expect(
        linuxCuaAdmissionRefusal(
          "browser_prepare",
          {
            pid: 123,
            window_id: 456,
            allow_launch,
          },
          undefined,
        ),
      ).toBeUndefined();
    }
    expect(linuxCuaAdmissionRefusal("browser_prepare", {}, undefined)).toBeUndefined();
    expect(
      linuxCuaAdmissionRefusal(
        "browser_dialog",
        {
          target_id: "owned-endpoint",
          action: "inspect",
        },
        undefined,
      ),
    ).toBeUndefined();
    expect(
      linuxCuaAdmissionRefusal(
        "browser_prepare",
        {
          pid: 123,
          window_id: 456,
          allow_launch: false,
          strategy: { kind: "existing_profile" },
        },
        "foreground",
      )?.result?.structuredContent?.code,
    ).toBe("linux_browser_cleanup_unavailable");
  });

  it("refuses every mutating browser route even with explicit foreground consent", () => {
    for (const name of CUA_BROWSER_TOOLS) {
      if (name === "get_browser_state") continue;
      for (const deliveryMode of [undefined, "background", "foreground", "full-access"]) {
        const args =
          name === "browser_prepare"
            ? { allow_launch: true, windowed: true }
            : { target_id: "owned-endpoint", action: "accept", delivery_mode: "foreground" };
        const result = linuxCuaAdmissionRefusal(name, args, deliveryMode);
        expect(result?.effect, `${name} ${deliveryMode}`).toBe("not-dispatched");
        expect(result?.result?.structuredContent?.code, `${name} ${deliveryMode}`).toBe(
          "linux_browser_cleanup_unavailable",
        );
      }
    }
  });

  it("does not accept a model-supplied browser cancellation capability", () => {
    const result = linuxCuaAdmissionRefusal(
      "browser_type",
      {
        target_id: "owned-endpoint",
        text: "must not type",
        browserInputControlVerified: true,
        synara_browser_input_control: 1,
        synara_native_revision: 32,
      },
      "foreground",
    );
    expect(result?.result?.structuredContent?.code).toBe("linux_browser_cleanup_unavailable");
  });

  it("admits browser-only mutations after the host verifies native browser cancellation", () => {
    for (const name of CUA_BROWSER_TOOLS) {
      const args =
        name === "browser_prepare"
          ? { allow_launch: true, windowed: false, profile: { mode: "isolated_new" } }
          : { target_id: "driver-owned-headless", action: "accept" };
      expect(linuxCuaAdmissionRefusal(name, args, "background", true), name).toBeUndefined();
    }
    expect(
      linuxCuaAdmissionRefusal(
        "click",
        {
          pid: 123,
          window_id: 456,
          delivery_mode: "foreground",
        },
        "foreground",
        true,
      )?.result?.structuredContent?.code,
    ).toBe("linux_input_cleanup_unavailable");
    expect(
      linuxCuaAdmissionRefusal(
        "launch_app",
        {
          name: "fixture",
          hidden: false,
        },
        "foreground",
        true,
      )?.result?.structuredContent?.code,
    ).toBe("linux_input_cleanup_unavailable");
  });

  it("does not widen the browser-only port to visible launch or personal profiles", () => {
    expect(
      linuxCuaAdmissionRefusal(
        "browser_prepare",
        {
          allow_launch: true,
          windowed: true,
          profile: { mode: "isolated_new" },
        },
        "foreground",
        true,
      )?.result?.structuredContent?.code,
    ).toBe("linux_windowed_browser_unavailable");
    expect(
      linuxCuaAdmissionRefusal(
        "browser_prepare",
        {
          pid: 123,
          allow_launch: false,
          strategy: { kind: "existing_profile" },
        },
        "foreground",
        true,
      )?.result?.structuredContent?.code,
    ).toBe("linux_browser_profile_unavailable");
    expect(
      linuxCuaAdmissionRefusal(
        "browser_dialog",
        {
          action: "accept",
          delivery_mode: "foreground",
        },
        "background",
        true,
      )?.result?.structuredContent?.code,
    ).toBe("linux_background_unavailable");
  });

  it("does not silently launch a visible Linux browser for a headless request", () => {
    for (const windowed of [undefined, false]) {
      expect(
        linuxCuaAdmissionRefusal(
          "browser_prepare",
          {
            allow_launch: true,
            windowed,
            profile: { mode: "isolated_new" },
          },
          "foreground",
        )?.result?.structuredContent?.code,
      ).toBe("linux_headless_browser_unavailable");
    }
    expect(
      linuxCuaAdmissionRefusal(
        "browser_prepare",
        {
          allow_launch: true,
          windowed: true,
        },
        "background",
      )?.effect,
    ).toBe("not-dispatched");
    expect(
      linuxCuaAdmissionRefusal(
        "browser_prepare",
        {
          allow_launch: true,
          windowed: true,
        },
        "foreground",
      )?.result?.structuredContent?.code,
    ).toBe("linux_browser_cleanup_unavailable");
  });

  it("does not accept a model-supplied foreground browser dialog override", () => {
    expect(
      linuxCuaAdmissionRefusal(
        "browser_dialog",
        {
          action: "accept",
          delivery_mode: "foreground",
        },
        "background",
      )?.effect,
    ).toBe("not-dispatched");
    expect(
      linuxCuaAdmissionRefusal(
        "browser_dialog",
        {
          action: "inspect",
          delivery_mode: "foreground",
        },
        "background",
      ),
    ).toBeUndefined();
  });

  it("refuses every unqualified background input route before dispatch", () => {
    for (const name of CUA_ACTION_TOOLS) {
      if (FOCUS_NEUTRAL_ACTIONS.has(name)) continue;
      const result = linuxCuaAdmissionRefusal(name, { pid: 123, window_id: 456 }, "background");
      expect(result?.effect, name).toBe("not-dispatched");
      expect(result?.result?.structuredContent?.effect, name).toBe("refused");
    }
  });

  it("does not treat a native argument, missing authority, or full access as visible consent", () => {
    for (const deliveryMode of [undefined, null, "background", "full-access", true]) {
      expect(
        linuxCuaAdmissionRefusal(
          "click",
          {
            pid: 123,
            window_id: 456,
            delivery_mode: "foreground",
          },
          deliveryMode,
        )?.result?.structuredContent?.code,
      ).toBe("linux_background_unavailable");
    }
  });

  it("refuses native app and window mutations until cancellation checkpoints exist", () => {
    for (const name of ["invoke_menu", "bring_to_front", "set_window_frame", "launch_app"]) {
      for (const deliveryMode of [undefined, "background", "foreground", "full-access"]) {
        const result = linuxCuaAdmissionRefusal(
          name,
          {
            pid: 123,
            window_id: 456,
            delivery_mode: "foreground",
            hidden: false,
          },
          deliveryMode,
        );
        expect(result?.effect, `${name} ${deliveryMode}`).toBe("not-dispatched");
        expect(result?.result?.structuredContent?.code, `${name} ${deliveryMode}`).toBe(
          "linux_input_cleanup_unavailable",
        );
      }
    }
  });

  it("refuses native synthetic input even with foreground consent until cleanup is supported", () => {
    for (const name of ["click", "type_text", "press_key", "hotkey", "scroll", "drag"]) {
      expect(
        linuxCuaAdmissionRefusal(
          name,
          {
            pid: 123,
            window_id: 456,
            delivery_mode: "foreground",
          },
          "foreground",
        )?.result?.structuredContent?.code,
      ).toBe("linux_input_cleanup_unavailable");
    }
  });

  it("distinguishes agent-overlay movement from global pointer movement", () => {
    expect(linuxCuaAdmissionRefusal("move_cursor", { x: 5, y: 5 }, "background")).toBeUndefined();
    expect(
      linuxCuaAdmissionRefusal("move_cursor", { scope: "window" }, "background"),
    ).toBeUndefined();
    expect(
      linuxCuaAdmissionRefusal("move_cursor", { scope: "desktop" }, "background")?.effect,
    ).toBe("not-dispatched");
    expect(
      linuxCuaAdmissionRefusal("move_cursor", { scope: "desktop" }, "foreground")?.result
        ?.structuredContent?.code,
    ).toBe("linux_input_cleanup_unavailable");
  });

  it("does not admit an unstable semantic target even with visible consent", () => {
    expect(
      linuxCuaAdmissionRefusal(
        "set_value",
        {
          pid: 123,
          window_id: 456,
          element_token: "snapshot:3",
          value: "new value",
        },
        "foreground",
      )?.result?.structuredContent?.code,
    ).toBe("linux_semantic_target_unproven");
    for (const name of ["click", "type_text", "press_key", "hotkey", "scroll"]) {
      expect(
        linuxCuaAdmissionRefusal(
          name,
          {
            pid: 123,
            window_id: 456,
            element_token: "snapshot:3",
          },
          "foreground",
        )?.result?.structuredContent?.code,
      ).toBe("linux_semantic_target_unproven");
    }
  });

  it("keeps clipboard/process policy separate and refuses unsupported native operations", () => {
    for (const name of ["clipboard_read", "clipboard_write", "kill_app"]) {
      expect(linuxCuaAdmissionRefusal(name, {}, "background"), name).toBeUndefined();
    }
    for (const name of ["select_text", "set_window_minimized", "set_app_visibility"]) {
      expect(
        linuxCuaAdmissionRefusal(name, {}, "foreground")?.result?.structuredContent?.code,
      ).toBe("unsupported_linux_operation");
    }
  });
});
