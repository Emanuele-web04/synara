import { describe, expect, it } from "vitest";

import {
  CUA_ACTION_TOOLS,
  CUA_BROWSER_MUTATION_TOOLS,
  CUA_BROWSER_TOOLS,
  CUA_READ_TOOLS,
  cuaCleanupAcknowledged,
  parseCuaShieldArgs,
} from "./cuaDriverProtocol";

/**
 * The macOS cua-driver tool inventory at the pinned release (driver 0.28.2,
 * Synara native patch, embedded serve). `platform-macos` `tools::register_all`
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
  "list_spaces",
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
  // Native revision 19's semantic text selection.
  "select_text",
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
  // Rev 18 read-only AX observer settle; allowlisted for backend-internal
  // post-action observation and the explicit computer_wait settle path.
  "wait_for_settle",
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
        "list_spaces",
        "list_windows",
        "verify_state",
        "wait_for_settle",
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
        "select_text",
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
        // Browser-family names stay out of the *desktop* allowlists: they are
        // admitted only through CUA_BROWSER_TOOLS with task attribution, a
        // separate consent model — asserted below.
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

  it("admits the browser family only through its own tool set", () => {
    // Browser calls ride CDP on session-scoped target_id/tab_id capabilities,
    // never the desktop frame/pixel machinery — the family membership is
    // pinned so a stray entry cannot smuggle a browser name into the desktop
    // allowlists or an unregistered name into the family.
    expect([...CUA_BROWSER_TOOLS].sort()).toEqual(
      [
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
    expect([...CUA_BROWSER_MUTATION_TOOLS].sort()).toEqual(
      [...CUA_BROWSER_TOOLS].filter((name) => name !== "get_browser_state").sort(),
    );
    for (const name of CUA_BROWSER_TOOLS) {
      expect(CUA_READ_TOOLS.has(name)).toBe(false);
      expect(CUA_ACTION_TOOLS.has(name)).toBe(false);
    }
  });

  it("admits only names the macOS driver actually registers", () => {
    // A typo'd allowlist entry would pass both sets above while naming
    // nothing the driver has — keep the allowlist inside the real registry.
    const registered = new Set<string>(REGISTERED_MACOS_TOOLS);
    for (const name of [...CUA_READ_TOOLS, ...CUA_ACTION_TOOLS, ...CUA_BROWSER_TOOLS]) {
      expect(registered.has(name), name).toBe(true);
    }
  });
});

describe("cuaCleanupAcknowledged", () => {
  // The retirement gate is deliberately strict: every field must read exactly
  // as the protocol documents before a generation may be killed or replaced —
  // anything less leaves held OS input unprovable and closes admission instead.
  const PID = 4242;
  const complete = {
    pid: PID,
    input_admission_closed: true,
    cleanup_complete: true,
    pending_input: 0,
  };

  it("accepts only the complete acknowledgement for the spawned child", () => {
    expect(cuaCleanupAcknowledged(complete, PID)).toBe(true);
  });

  it.each([
    ["a different pid", { ...complete, pid: PID + 1 }],
    ["admission still open", { ...complete, input_admission_closed: false }],
    ["cleanup incomplete", { ...complete, cleanup_complete: false }],
    ["pending input", { ...complete, pending_input: 1 }],
    ["a missing admission flag", { pid: PID, cleanup_complete: true, pending_input: 0 }],
    ["a success string", "cleanup done"],
    ["an empty result", {}],
    ["no result", undefined],
  ])("rejects %s", (_label, result) => {
    expect(cuaCleanupAcknowledged(result as Record<string, unknown>, PID)).toBe(false);
  });

  it("rejects an unknown child pid", () => {
    expect(cuaCleanupAcknowledged(complete, undefined)).toBe(false);
  });
});

describe("parseCuaShieldArgs", () => {
  const engage = {
    action: "engage",
    shield_id: "shield-a1b2c3d4",
    frame: { x: 1050.5, y: 120, width: 420, height: 620 },
    window_id: 4242,
    pid: 777,
    label: "Synara activating Calculator",
  };

  it("parses an engage with its full target shape", () => {
    expect(parseCuaShieldArgs(engage)).toEqual({
      action: "engage",
      shieldId: "shield-a1b2c3d4",
      frame: { x: 1050.5, y: 120, width: 420, height: 620 },
      windowId: 4242,
      pid: 777,
      label: "Synara activating Calculator",
    });
  });

  it("tolerates a missing label and an off-screen frame origin", () => {
    const { label: _label, ...withoutLabel } = engage;
    const parsed = parseCuaShieldArgs(withoutLabel);
    expect(parsed).toMatchObject({ action: "engage", shieldId: "shield-a1b2c3d4" });
    expect(parsed && "label" in parsed ? parsed.label : undefined).toBeUndefined();
    expect(
      parseCuaShieldArgs({ ...engage, frame: { x: -4600, y: -30, width: 800, height: 600 } }),
    ).toMatchObject({ frame: { x: -4600, y: -30, width: 800, height: 600 } });
  });

  it("sanitizes the painted label", () => {
    const parsed = parseCuaShieldArgs({
      ...engage,
      label: " line\nbreak\u001b " + "x".repeat(300),
    });
    expect(parsed).toMatchObject({ action: "engage" });
    const label = parsed && parsed.action === "engage" ? parsed.label : undefined;
    expect(label).not.toContain("\n");
    expect(label).not.toContain("\u001b");
    expect(label!.length).toBeLessThanOrEqual(160);
  });

  it.each([
    ["missing args", undefined],
    ["non-object args", "engage"],
    ["unknown action", { action: "expand" }],
    ["bad shield id characters", { ...engage, shield_id: "shield has spaces" }],
    ["empty shield id", { ...engage, shield_id: "" }],
    ["oversized shield id", { ...engage, shield_id: "s".repeat(65) }],
    ["missing frame", { ...engage, frame: undefined }],
    ["zero-area frame", { ...engage, frame: { x: 0, y: 0, width: 0, height: 600 } }],
    ["absurd extent", { ...engage, frame: { x: 0, y: 0, width: 100_000, height: 600 } }],
    ["non-finite origin", { ...engage, frame: { x: Number.NaN, y: 0, width: 800, height: 600 } }],
    ["zero window id", { ...engage, window_id: 0 }],
    ["fractional window id", { ...engage, window_id: 1.5 }],
    ["zero pid", { ...engage, pid: 0 }],
    ["negative pid", { ...engage, pid: -4 }],
  ])("refuses %s", (_name, args) => {
    expect(parseCuaShieldArgs(args)).toBeUndefined();
  });

  it("parses release and release_all", () => {
    expect(parseCuaShieldArgs({ action: "release", shield_id: "shield-1" })).toEqual({
      action: "release",
      shieldId: "shield-1",
    });
    expect(parseCuaShieldArgs({ action: "release_all" })).toEqual({ action: "release_all" });
    // release_all stays minimal: it must work even for a caller that cannot
    // name the shields it is dropping.
    expect(parseCuaShieldArgs({ action: "release_all", shield_id: 42 })).toEqual({
      action: "release_all",
    });
  });

  it("refuses release without a valid shield id", () => {
    expect(parseCuaShieldArgs({ action: "release" })).toBeUndefined();
    expect(parseCuaShieldArgs({ action: "release", shield_id: "" })).toBeUndefined();
  });
});
