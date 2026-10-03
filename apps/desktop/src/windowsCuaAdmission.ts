import type { CuaReply } from "@synara/shared/cuaDriverProtocol";

/**
 * Native tools that hold OS input across the whole dispatch on Windows.
 *
 * The pinned upstream Windows driver answers "Unknown method" to both
 * `interrupt_input` and `cancel_input`, and Synara ships no OS-level
 * held-input release for this platform — so anything the driver holds past
 * an Escape or Stop cannot be stopped or verified afterward. Refuse those
 * routes at admission (before dispatch) instead of stranding held buttons
 * or modifiers on the user's desktop. Momentary tools (click, scroll,
 * press_key, type_text) complete inside one short call and stay admitted;
 * their residual down/up race is the same on every platform.
 */
const UNCANCELLABLE_HELD_INPUT_TOOLS = new Set([
  // Foreground drag holds the mouse button for the entire gesture:
  // button-down, moves/sleeps, release only at the end.
  "drag",
]);

export function windowsCuaAdmissionRefusal(name: string): CuaReply | undefined {
  if (!UNCANCELLABLE_HELD_INPUT_TOOLS.has(name)) return undefined;
  const message =
    "Computer drags are unavailable on this Windows driver: it holds the mouse button " +
    "for the whole gesture and this build cannot stop or verify the release mid-drag. " +
    "Use clicks, typing, and screenshots instead; nothing was changed.";
  return {
    ok: true,
    effect: "not-dispatched",
    result: {
      isError: true,
      content: [{ type: "text", text: message }],
      structuredContent: { effect: "refused", code: "windows_held_input_unavailable", message },
    },
  };
}
