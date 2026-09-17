import { describe, expect, it } from "vitest";

import { CUA_ACTION_TOOLS, CUA_READ_TOOLS } from "./cuaDriverProtocol";

/**
 * The macOS cua-driver tool inventory at the pinned release (driver 0.28.2,
 * native revision 17, embedded serve). `platform-macos` `tools::register_all`
 * registers the platform and core tools; the cua-driver binary adds
 * `check_for_update` and — only under the upstream preview admission the
 * embedded host never grants — `history_status`/`history_query`.
 *
 * The classification of every row lives in
 * `docs/computer-use-cua/v2-parity-matrix.md`. The allowlists below are the
 * whole server→host boundary: a name absent from both is refused by the
 * desktop host before a daemon even starts, so a new driver tool is
 * unreachable by default and adding one here is the audited act.
 */
const REGISTERED_MACOS_TOOLS = [
  // Agent-facing reads.
  "list_windows",
  "list_apps",
  "get_window_state",
  "get_desktop_state",
  "get_screen_size",
  "get_accessibility_tree",
  "get_cursor_position",
  "verify_state",
  "zoom",
  // Agent-facing actions.
  "click",
  "move_cursor",
  "drag",
  "scroll",
  "type_text",
  "press_key",
  "hotkey",
  "set_value",
  "clipboard_read",
  "clipboard_write",
  "launch_app",
  "bring_to_front",
  "invoke_menu",
  "set_window_frame",
  "kill_app",
  // Rev 17 hidden-workspace lifecycle; verified live against hidden and
  // minimized windows. Reachability is decided by the allowlists.
  "set_app_visibility",
  "set_window_minimized",
  // Surfaced through `click` arguments rather than dispatched by name.
  "double_click",
  "right_click",
  // Allowlisted for backend-internal calls; no agent tool exposes them.
  "check_permissions",
  "check_input_ready",
  "get_agent_cursor_state",
  // Host-internal session lifecycle; the host owns native sessions.
  "start_session",
  "end_session",
  "escalate_session",
  "get_session",
  "list_sessions",
  "get_session_state",
  // Host-internal cursor ownership; posture is set at spawn and bootstrap.
  "set_agent_cursor_enabled",
  "set_agent_cursor_motion",
  "set_agent_cursor_theme",
  // Host-internal driver configuration.
  "get_config",
  "set_config",
  // Host-internal recording/replay; gated on a privacy policy decision.
  "start_recording",
  "stop_recording",
  "get_recording_state",
  "replay_trajectory",
  "install_ffmpeg",
  // Host-internal diagnostics/lifecycle surfaces.
  "health_report",
  "check_for_update",
  "history_status",
  "history_query",
  // Browser surface — a separate feature family with its own consent model.
  "page",
  "get_browser_state",
  "browser_prepare",
  "browser_navigate",
  "browser_click",
  "browser_type",
  "browser_dialog",
  "browser_set_input_files",
  "browser_download",
  "browser_pointer",
] as const;

/** Driver names the agent path must never reach. */
const AGENT_UNREACHABLE_TOOLS = REGISTERED_MACOS_TOOLS.filter(
  (name) => !CUA_READ_TOOLS.has(name) && !CUA_ACTION_TOOLS.has(name),
);

describe("cuaDriverProtocol tool boundary", () => {
  it("allowlists exactly the audited tool set", () => {
    // The two sets together are the complete server→host vocabulary — both
    // directions pinned so an allowlist edit is a deliberate audit event.
    expect([...CUA_READ_TOOLS].sort()).toEqual(
      [
        "check_input_ready",
        "check_permissions",
        "get_accessibility_tree",
        "get_agent_cursor_state",
        "get_cursor_position",
        "get_desktop_state",
        "get_screen_size",
        "get_window_state",
        "list_apps",
        "list_windows",
        "verify_state",
        "zoom",
      ].sort(),
    );
    expect([...CUA_ACTION_TOOLS].sort()).toEqual(
      [
        "bring_to_front",
        "click",
        "clipboard_read",
        "clipboard_write",
        "drag",
        "hotkey",
        "invoke_menu",
        "kill_app",
        "launch_app",
        "move_cursor",
        "press_key",
        "scroll",
        "set_app_visibility",
        "set_value",
        "set_window_minimized",
        "set_window_frame",
        "type_text",
      ].sort(),
    );
  });

  it("keeps every host-internal and browser-family driver tool unreachable", () => {
    // Every registered name not in the allowlists must stay out: the audit
    // classifies each one as host-internal or browser-owned, and this list
    // exists so a stray allowlist entry cannot quietly reopen them.
    expect(AGENT_UNREACHABLE_TOOLS.sort()).toEqual(
      [
        "double_click",
        "right_click",
        "start_session",
        "end_session",
        "escalate_session",
        "get_session",
        "list_sessions",
        "get_session_state",
        "set_agent_cursor_enabled",
        "set_agent_cursor_motion",
        "set_agent_cursor_theme",
        "get_config",
        "set_config",
        "start_recording",
        "stop_recording",
        "get_recording_state",
        "replay_trajectory",
        "install_ffmpeg",
        "health_report",
        "check_for_update",
        "history_status",
        "history_query",
        "page",
        "get_browser_state",
        "browser_prepare",
        "browser_navigate",
        "browser_click",
        "browser_type",
        "browser_dialog",
        "browser_set_input_files",
        "browser_download",
        "browser_pointer",
      ].sort(),
    );
  });

  it("admits only names the macOS driver actually registers", () => {
    // A typo'd allowlist entry would pass both sets above while naming
    // nothing the driver has — keep the allowlist inside the real registry.
    const registered = new Set<string>(REGISTERED_MACOS_TOOLS);
    for (const name of [...CUA_READ_TOOLS, ...CUA_ACTION_TOOLS]) {
      expect(registered.has(name), name).toBe(true);
    }
  });
});
