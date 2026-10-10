import {
  CUA_ACTION_TOOLS,
  CUA_BROWSER_TOOLS,
  type CuaReply,
} from "@synara/shared/cuaDriverProtocol";

const UNSUPPORTED_NATIVE_TOOLS = new Set([
  "select_text",
  "set_window_minimized",
  "set_app_visibility",
]);
const UNCANCELLABLE_WINDOW_TOOLS = new Set([
  "launch_app",
  "bring_to_front",
  "set_window_frame",
  "invoke_menu",
]);

/** These pinned routes observe an existing endpoint without changing a browser or profile. */
export function linuxBrowserCallIsReadOnly(name: string, input: unknown): boolean {
  if (name === "get_browser_state") return true;
  const args =
    input && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  if (name === "browser_dialog") return args.action === "inspect";
  return (
    name === "browser_prepare" &&
    (args.allow_launch === undefined || args.allow_launch === false) &&
    (args.strategy === undefined || args.strategy === null)
  );
}

/**
 * The upstream Linux artifact does not implement the patched macOS delivery
 * contract. Its background keyboard paths can call AT-SPI GrabFocus, menu
 * invocation activates a window, and desktop input uses the global pointer.
 * Keep these routes closed until their compositor/target isolation is proven.
 * `deliveryMode` is trusted host-envelope metadata from the server's existing
 * visible-use authorizer, never a native argument or a model-supplied override.
 * Browser mutation support may open only after the host verifies the pinned
 * browser cancellation revision and capability on its own driver generation.
 */
export function linuxCuaAdmissionRefusal(
  name: string,
  input: unknown,
  deliveryMode: unknown,
  browserInputControlVerified = false,
): CuaReply | undefined {
  const args =
    input && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  if (CUA_BROWSER_TOOLS.has(name)) {
    if (
      linuxBrowserCallIsReadOnly(name, args) &&
      (name !== "browser_prepare" || !browserInputControlVerified)
    )
      return undefined;
    if (name === "browser_prepare") {
      // Headless/windowed is a Synara patch extension. The current Linux
      // artifact ignores windowed:false and would open a visible Chromium.
      if (!browserInputControlVerified && args.allow_launch === true && args.windowed !== true)
        return refusal(
          "linux_headless_browser_unavailable",
          "This Linux driver cannot launch a headless browser, and browser launches are unavailable until cancellation cleanup is supported. Only observation of an existing debuggable browser is available.",
        );
    }
    if (browserInputControlVerified) {
      // The browser-only Linux port qualifies isolated, driver-owned headless
      // bindings. Its native boundary independently checks binding ownership;
      // neither visible Chromium nor personal-profile setup is part of it.
      if (name === "browser_prepare" && args.windowed === true)
        return refusal(
          "linux_windowed_browser_unavailable",
          "The Linux browser runtime supports isolated headless browsers only. Visible browser launches are unavailable; keep windowed false.",
        );
      if (name === "browser_prepare" && args.strategy !== undefined && args.strategy !== null)
        return refusal(
          "linux_browser_profile_unavailable",
          "The Linux browser runtime cannot change or attach a personal browser profile for automation. Use an isolated_new or isolated_named headless profile; passive endpoint detection remains available.",
        );
      if (
        name === "browser_dialog" &&
        args.delivery_mode === "foreground" &&
        deliveryMode !== "foreground"
      )
        return refusal(
          "linux_background_unavailable",
          "A model-supplied foreground dialog mode cannot authorize visible computer use. Keep the headless background route.",
        );
      return undefined;
    }
    return refusal(
      "linux_browser_cleanup_unavailable",
      "This Linux driver cannot stop an in-flight browser mutation or launch reliably. Browser actions are unavailable until native cancellation cleanup is supported, even with foreground consent. Only browser observation, endpoint detection, and dialog inspection are available; nothing was changed.",
    );
  }
  if (!CUA_ACTION_TOOLS.has(name)) return undefined;
  if (UNSUPPORTED_NATIVE_TOOLS.has(name)) {
    return refusal(
      "unsupported_linux_operation",
      "This native operation is not implemented by the Linux driver. Observe the current window and use an available route.",
    );
  }
  if (
    name === "set_value" ||
    args.semantic_only === true ||
    args.element_token !== undefined ||
    args.element_index !== undefined
  ) {
    return refusal(
      "linux_semantic_target_unproven",
      "This Linux route does not prove the observed element's exact window/object identity. Native pointer and keyboard input are also unavailable until cancellation cleanup is supported. Use observation or an existing debuggable browser when appropriate.",
    );
  }
  // Clipboard and process-control approval remain the server's responsibility;
  // these operations do not synthesize desktop input or implicitly activate a
  // window. The ordinary agent cursor is an overlay, not the human pointer.
  if (
    name === "clipboard_read" ||
    name === "clipboard_write" ||
    name === "kill_app" ||
    (name === "move_cursor" && (args.scope === undefined || args.scope === "window"))
  )
    return undefined;
  if (UNCANCELLABLE_WINDOW_TOOLS.has(name))
    return refusal(
      "linux_input_cleanup_unavailable",
      "This Linux driver cannot stop an in-flight native app or window operation reliably. Launching apps, invoking menus, activating windows, and changing window frames are unavailable until native cancellation checkpoints are supported, even with foreground consent. No action was dispatched.",
    );
  if (deliveryMode === "foreground") {
    return refusal(
      "linux_input_cleanup_unavailable",
      "This Linux driver cannot acknowledge release of native input when Computer is stopped. Native pointer and keyboard input are unavailable until cancellation cleanup is supported; no input was sent.",
    );
  }
  return refusal(
    "linux_background_unavailable",
    "This Linux native route cannot guarantee background input without moving desktop focus or the human pointer. Foreground input is also unavailable until cancellation cleanup is supported. No input was sent; use observation or an existing debuggable browser when appropriate.",
  );
}

function refusal(code: string, message: string): CuaReply {
  return {
    ok: true,
    effect: "not-dispatched",
    result: {
      isError: true,
      content: [{ type: "text", text: message }],
      structuredContent: { effect: "refused", code, message },
    },
  };
}
