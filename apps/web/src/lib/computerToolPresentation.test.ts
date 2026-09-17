// FILE: computerToolPresentation.test.ts
// Purpose: Pin the approval card's account of a desktop action — the question being
//          asked is "click what", and the answer must not be the raw wire call.
// Layer: Web UI logic tests

import type { ComputerWindow } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  COMPUTER_TOOL_TITLES,
  computerToolName,
  describeComputerToolCall,
  isComputerToolName,
} from "./computerToolPresentation";

const SAFARI: ComputerWindow = {
  id: "win-7",
  title: "Google",
  appName: "Safari",
  focused: true,
  minimized: false,
  visible: true,
} as unknown as ComputerWindow;

describe("computerToolName", () => {
  it("covers every native desktop tool advertised by the gateway", () => {
    expect(Object.keys(COMPUTER_TOOL_TITLES)).toEqual([
      "computer_screenshot",
      "computer_get_state",
      "computer_get_screen_size",
      "computer_list_windows",
      "computer_list_apps",
      "computer_verify_state",
      "computer_zoom",
      "computer_get_accessibility_tree",
      "computer_get_cursor_position",
      "computer_click",
      "computer_double_click",
      "computer_triple_click",
      "computer_right_click",
      "computer_move_cursor",
      "computer_drag",
      "computer_scroll",
      "computer_type_text",
      "computer_press_key",
      "computer_hotkey",
      "computer_set_value",
      "computer_perform_action",
      "computer_launch_app",
      "computer_activate_window",
      "computer_set_window_frame",
      "computer_invoke_menu",
      "computer_kill_app",
      "computer_wait",
      "computer_read_clipboard",
      "computer_write_clipboard",
      "computer_paste",
      "computer_run",
    ]);
  });

  it("recovers the gateway tool through whatever wrapping a provider applied", () => {
    expect(computerToolName("mcp__synara__computer_click")).toBe("computer_click");
    expect(computerToolName("computer_click")).toBe("computer_click");
    expect(computerToolName("MCP__Synara__Computer_Type_Text")).toBe("computer_type_text");
    expect(computerToolName("browser_click")).toBeNull();
    expect(computerToolName(undefined)).toBeNull();
  });

  it("does not claim a merely similar name", () => {
    expect(isComputerToolName("my_computer_clicker")).toBe(false);
  });
});

describe("describeComputerToolCall", () => {
  it("says verb, coordinate and window instead of the raw call", () => {
    const described = describeComputerToolCall({
      toolName: "mcp__synara__computer_click",
      args: { x: 812, y: 344, window_id: "win-7" },
      windows: [SAFARI],
    });
    expect(described?.summary).toBe("Click at (812, 344) in Safari — Google");
  });

  it("drops a window id it cannot resolve rather than printing it", () => {
    // An opaque id tells the user nothing they can check against their screen.
    const described = describeComputerToolCall({
      toolName: "computer_click",
      args: { x: 10, y: 20, window_id: "win-missing" },
      windows: [SAFARI],
    });
    expect(described?.summary).toBe("Click at (10, 20)");
    expect(described?.params.some((row) => row.name === "Window")).toBe(false);
  });

  it("prefers a semantic label over coordinates, because that is what was targeted", () => {
    expect(
      describeComputerToolCall({
        toolName: "computer_click",
        args: { label: "Save", x: 5, y: 6 },
      })?.summary,
    ).toBe("Click on “Save”");
  });

  it("keeps typed and clipboard values out of transcript summaries", () => {
    // `computer_write_clipboard` used to be classified a *file change* by a
    // substring match on "write"; naming its payload "Text" would leave the same
    // impression, that something is being typed into whatever has focus.
    expect(
      describeComputerToolCall({ toolName: "computer_type_text", args: { text: "hello" } })
        ?.summary,
    ).toBe("Type");
    const clipboard = describeComputerToolCall({
      toolName: "computer_write_clipboard",
      args: { text: "secret" },
    });
    expect(clipboard?.summary).toBe("Write to the clipboard");
    expect(clipboard?.params).toContainEqual({ name: "Clipboard", value: "secret" });
    expect(
      describeComputerToolCall({ toolName: "computer_paste", args: { text: "secret" } })?.summary,
    ).toBe("Paste text");
    const run = describeComputerToolCall({
      toolName: "computer_run",
      args: {
        steps: [
          { type: "click", label: "Save" },
          { type: "type_text", text: "secret" },
          { type: "press_key", key: "enter" },
        ],
      },
    });
    expect(run?.summary).toBe("Run a sequence");
    expect(run?.params).toEqual([{ name: "Steps", value: "click → type_text → press_key" }]);
  });

  it("gives a scroll a direction and a shortcut its keys", () => {
    expect(
      describeComputerToolCall({ toolName: "computer_scroll", args: { delta_y: 240 } })?.summary,
    ).toBe("Scroll down");
    expect(
      describeComputerToolCall({ toolName: "computer_hotkey", args: { keys: ["cmd", "s"] } })
        ?.summary,
    ).toBe("Press a shortcut cmd+s");
  });

  it("renders a coordinate pair as one row, because it is one fact", () => {
    const described = describeComputerToolCall({
      toolName: "computer_click",
      args: { x: 812, y: 344 },
    });
    expect(described?.params).toEqual([{ name: "Position", value: "812, 344" }]);
  });

  it("describes triple-click, activation, wait, and nested drag targets", () => {
    expect(
      describeComputerToolCall({
        toolName: "computer_triple_click",
        args: { label: "Address" },
      })?.summary,
    ).toBe("Triple-click on “Address”");
    expect(
      describeComputerToolCall({
        toolName: "computer_activate_window",
        args: { window_id: "win-7" },
        windows: [SAFARI],
      })?.summary,
    ).toBe("Activate a window in Safari — Google");
    expect(
      describeComputerToolCall({
        toolName: "computer_wait",
        args: { duration_ms: 2_000, label: "Done", window_id: "win-7" },
        windows: [SAFARI],
      })?.summary,
    ).toBe("Wait for “Done” in Safari — Google");
    expect(
      describeComputerToolCall({
        toolName: "computer_drag",
        args: { from: { label: "Draft" }, to: { label: "Archive" } },
      })?.summary,
    ).toBe("Drag from “Draft” to “Archive”");
  });

  it("describes the app, menu, frame and process tools the gateway now serves", () => {
    expect(describeComputerToolCall({ toolName: "computer_list_apps", args: {} })?.summary).toBe(
      "List apps",
    );
    // The menu path is the payload: the approving human reads which command
    // fires, not which pixel was aimed at.
    const menu = describeComputerToolCall({
      toolName: "computer_invoke_menu",
      args: { window_id: "win-7", path: ["File", "Export As…"] },
      windows: [SAFARI],
    });
    expect(menu?.summary).toBe("Invoke a menu item File → Export As… in Safari — Google");
    expect(menu?.params).toContainEqual({ name: "Menu", value: "File → Export As…" });
    expect(menu?.params).toContainEqual({ name: "Window", value: "Safari — Google" });
    // A frame call names its destination: new position and size land as rows
    // the approval card can check.
    const frame = describeComputerToolCall({
      toolName: "computer_set_window_frame",
      args: { window_id: "win-7", x: 40, y: 60, width: 900, height: 700 },
      windows: [SAFARI],
    });
    expect(frame?.summary).toBe("Move or resize a window at (40, 60) in Safari — Google");
    expect(frame?.params).toEqual([
      { name: "New position", value: "40, 60" },
      { name: "Size", value: "900×700" },
      { name: "Window", value: "Safari — Google" },
    ]);
    // Kill and verify resolve their window to the owning app the same way —
    // and keep the opaque id out when it cannot be resolved.
    expect(
      describeComputerToolCall({
        toolName: "computer_kill_app",
        args: { window_id: "win-7" },
        windows: [SAFARI],
      })?.summary,
    ).toBe("Force-quit an app in Safari — Google");
    expect(
      describeComputerToolCall({
        toolName: "computer_kill_app",
        args: { window_id: "win-gone" },
        windows: [SAFARI],
      })?.summary,
    ).toBe("Force-quit an app");
    expect(
      describeComputerToolCall({
        toolName: "computer_verify_state",
        args: { window_id: "win-7", expect: [{ window: {} }] },
        windows: [SAFARI],
      })?.summary,
    ).toBe("Verify state in Safari — Google");
    expect(
      describeComputerToolCall({
        toolName: "computer_zoom",
        args: { window_id: "win-7", x: 10, y: 20, width: 300, height: 200 },
        windows: [SAFARI],
      })?.summary,
    ).toBe("Zoom into a window at (10, 20) in Safari — Google");
  });

  it("returns null for anything that is not a desktop tool", () => {
    expect(describeComputerToolCall({ toolName: "Bash", args: { command: "ls" } })).toBeNull();
  });
});
