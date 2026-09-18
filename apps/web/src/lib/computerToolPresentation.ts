// FILE: computerToolPresentation.ts
// Purpose: Say what a desktop tool call actually does, in the words a person would use,
//          for the approval card and the transcript.
// Layer: Web UI logic
// Exports: COMPUTER_TOOL_TITLES, isComputerToolName, describeComputerToolCall
//
// Every browser tool has a curated presentation and every computer tool had
// none, so an approval for the most consequential thing Synara can do — moving a
// pointer on the user's own machine — read
// `mcp__synara__computer_click  x 812  y 344`, which is the raw wire call. The
// decision the user is being asked to make is "click *what*", and the answer is
// assembled here: verb, where, and which window, resolved from the window list
// the pane already receives rather than left as an opaque id.

import type { ComputerWindow } from "@synara/contracts";

/** The gateway's desktop tools, and the verb each one performs. */
export const COMPUTER_TOOL_TITLES = {
  computer_screenshot: "Take a screenshot",
  computer_get_state: "Read the screen",
  computer_get_screen_size: "Measure the screen",
  computer_list_windows: "List windows",
  computer_list_apps: "List apps",
  computer_verify_state: "Verify state",
  computer_zoom: "Zoom into a window",
  computer_get_accessibility_tree: "List apps and windows",
  computer_get_cursor_position: "Read the cursor position",
  computer_help: "Read the Computer playbook",
  computer_click: "Click",
  computer_double_click: "Double-click",
  computer_triple_click: "Triple-click",
  computer_right_click: "Right-click",
  computer_move_cursor: "Move the agent cursor",
  computer_drag: "Drag",
  computer_scroll: "Scroll",
  computer_type_text: "Type",
  computer_press_key: "Press a key",
  computer_hotkey: "Press a shortcut",
  computer_set_value: "Set a field",
  computer_select_text: "Select text",
  computer_perform_action: "Activate a control",
  computer_launch_app: "Open an app",
  computer_activate_window: "Activate a window",
  computer_set_window_frame: "Move or resize a window",
  computer_invoke_menu: "Invoke a menu item",
  computer_kill_app: "Force-quit an app",
  computer_set_window_minimized: "Minimize or restore a window",
  computer_set_app_visibility: "Hide or unhide an app",
  computer_wait: "Wait",
  computer_read_clipboard: "Read the clipboard",
  computer_write_clipboard: "Write to the clipboard",
  computer_paste: "Paste text",
  computer_run: "Run a sequence",
} as const;

export type ComputerToolName = keyof typeof COMPUTER_TOOL_TITLES;

/**
 * The bare tool name inside whatever wrapping a provider applied, or null.
 * Providers surface the same gateway tool as `computer_click`,
 * `mcp__synara__computer_click`, and other permutations, so identity is
 * recovered from the suffix rather than matched exactly.
 */
export function computerToolName(candidate: string | null | undefined): ComputerToolName | null {
  if (!candidate) return null;
  const normalized = candidate
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_");
  for (const name of Object.keys(COMPUTER_TOOL_TITLES) as ComputerToolName[]) {
    if (normalized === name || normalized.endsWith(`_${name}`)) return name;
  }
  return null;
}

export function isComputerToolName(candidate: string | null | undefined): boolean {
  return computerToolName(candidate) !== null;
}

export interface ComputerToolCallDescription {
  readonly tool: ComputerToolName;
  /** One line: verb, target, window. Never the raw arguments. */
  readonly summary: string;
  /** The arguments worth showing, already named and formatted. */
  readonly params: ReadonlyArray<{ readonly name: string; readonly value: string }>;
}

/**
 * "Click at (812, 344) in Safari — Google".
 *
 * `windows` is the live window list, used only to turn an opaque `window_id`
 * into the app and title a person recognises. Without a match the id is dropped
 * rather than printed: an id tells the user nothing they can check against what
 * is on their screen.
 */
export function describeComputerToolCall(input: {
  readonly toolName: string | null | undefined;
  readonly args: Readonly<Record<string, unknown>> | undefined;
  readonly windows?: readonly ComputerWindow[] | undefined;
}): ComputerToolCallDescription | null {
  const tool = computerToolName(input.toolName);
  if (tool === null) return null;
  const args = input.args ?? {};
  // The visibility pair's flag is the verb's direction: an approval that reads
  // "Minimize or restore" makes the user guess which half is being asked for.
  const verb =
    (tool === "computer_set_window_minimized"
      ? directionVerb(args.minimized, "Minimize a window", "Restore a window")
      : tool === "computer_set_app_visibility"
        ? directionVerb(args.hidden, "Hide an app", "Unhide an app")
        : undefined) ?? COMPUTER_TOOL_TITLES[tool];
  const where =
    tool === "computer_launch_app"
      ? ""
      : tool === "computer_drag"
        ? describeDragTarget(args, input.windows)
        : tool === "computer_set_app_visibility"
          ? describePidTarget(args, input.windows)
          : describeTarget(args, input.windows, tool === "computer_wait" ? "for" : "on");
  const what = describePayload(tool, args);

  const summary = [verb, what, where].filter((part) => part.length > 0).join(" ");
  return { tool, summary, params: describeParams(tool, args, input.windows) };
}

/** true/false pick the verb's direction; anything else keeps the generic title. */
function directionVerb(flag: unknown, whenTrue: string, whenFalse: string): string | undefined {
  return flag === true ? whenTrue : flag === false ? whenFalse : undefined;
}

/** "in Safari" — the pid resolved through the window list, or "" when it cannot be. */
function describePidTarget(
  args: Readonly<Record<string, unknown>>,
  windows: readonly ComputerWindow[] | undefined,
): string {
  const pid = readNumber(args.pid);
  if (pid === null || !windows) return "";
  const app = windows.find((window) => window.pid === pid)?.appName?.trim();
  return app ? `in ${app}` : "";
}

/** "at (812, 344) in Safari — Google", "on “Save” in Notes", or "". */
function describeTarget(
  args: Readonly<Record<string, unknown>>,
  windows: readonly ComputerWindow[] | undefined,
  labelPreposition: "on" | "for" = "on",
): string {
  const parts: string[] = [];
  const label = readString(args.label);
  const x = readNumber(args.x);
  const y = readNumber(args.y);
  if (label) {
    parts.push(`${labelPreposition} “${label}”`);
  } else if (x !== null && y !== null) {
    parts.push(`at (${x}, ${y})`);
  }
  const window = resolveWindow(args.window_id, windows);
  const app = readString(args.app_name) ?? readString(args.application) ?? readString(args.app);
  if (window) {
    parts.push(`in ${window}`);
  } else if (app) {
    parts.push(`in ${app}`);
  }
  return parts.join(" ");
}

function describeDragTarget(
  args: Readonly<Record<string, unknown>>,
  windows: readonly ComputerWindow[] | undefined,
): string {
  const from = readRecord(args.from);
  const to = readRecord(args.to);
  if (!from || !to) return "";
  const fromTarget = describeTarget(from, windows).replace(/^on /, "");
  const toTarget = describeTarget(to, windows).replace(/^on /, "");
  return fromTarget && toTarget ? `from ${fromTarget} to ${toTarget}` : "";
}

/** The thing being typed, pressed, or scrolled — the part that is not a target. */
function describePayload(tool: ComputerToolName, args: Readonly<Record<string, unknown>>): string {
  // Values typed into a field or copied to the clipboard can be credentials or
  // other private data. The expanded parameter list may show the exact action
  // being approved, but transcript summaries must never repeat that content.
  if (
    tool === "computer_type_text" ||
    tool === "computer_set_value" ||
    tool === "computer_write_clipboard" ||
    tool === "computer_paste" ||
    tool === "computer_run"
  ) {
    return "";
  }
  if (tool === "computer_press_key") {
    const key = readString(args.key);
    return key === null ? "" : `${key}`;
  }
  if (tool === "computer_hotkey") {
    const keys = readStringArray(args.keys);
    return keys.length > 0 ? keys.join("+") : "";
  }
  if (tool === "computer_scroll") {
    const dx = readNumber(args.delta_x) ?? 0;
    const dy = readNumber(args.delta_y) ?? 0;
    if (dy !== 0) return dy > 0 ? "down" : "up";
    if (dx !== 0) return dx > 0 ? "right" : "left";
    return "";
  }
  if (tool === "computer_launch_app") {
    const app = readString(args.app) ?? readString(args.name) ?? readString(args.bundle_id);
    return app ?? "";
  }
  if (tool === "computer_invoke_menu") {
    const path = readStringArray(args.path);
    return path.length > 0 ? truncate(path.join(" → "), 80) : "";
  }
  if (tool === "computer_wait" && !readString(args.label)) {
    const durationMs = readNumber(args.duration_ms);
    if (durationMs === null) return "";
    return durationMs >= 1_000 && durationMs % 1_000 === 0
      ? `for ${durationMs / 1_000} ${durationMs === 1_000 ? "second" : "seconds"}`
      : `for ${durationMs} ms`;
  }
  return "";
}

/**
 * The argument rows, named for a reader rather than for the wire. A coordinate
 * pair is one row, not two, because it is one fact.
 */
function describeParams(
  tool: ComputerToolName,
  args: Readonly<Record<string, unknown>>,
  windows: readonly ComputerWindow[] | undefined,
): ReadonlyArray<{ readonly name: string; readonly value: string }> {
  const rows: Array<{ name: string; value: string }> = [];
  const x = readNumber(args.x);
  const y = readNumber(args.y);
  if (x !== null && y !== null) {
    rows.push({
      name: tool === "computer_set_window_frame" ? "New position" : "Position",
      value: `${x}, ${y}`,
    });
  }
  const width = readNumber(args.width);
  const height = readNumber(args.height);
  if (
    (tool === "computer_set_window_frame" || tool === "computer_zoom") &&
    width !== null &&
    height !== null
  ) {
    rows.push({ name: "Size", value: `${width}×${height}` });
  }
  if (tool === "computer_invoke_menu") {
    const path = readStringArray(args.path);
    if (path.length > 0) rows.push({ name: "Menu", value: truncate(path.join(" → "), 200) });
  }
  const label = readString(args.label);
  if (label) rows.push({ name: "Target", value: label });
  const role = readString(args.role);
  if (role) rows.push({ name: "Role", value: role });
  const window = resolveWindow(args.window_id, windows);
  if (window) rows.push({ name: "Window", value: window });
  const text = readString(args.text) ?? readString(args.value);
  if (text !== null && text.length > 0) {
    rows.push({
      // The clipboard is not a text field, and calling both "Text" is how a
      // clipboard write reads as typing into whatever has focus.
      name: tool === "computer_write_clipboard" ? "Clipboard" : "Text",
      value: truncate(text, 200),
    });
  }
  const key = readString(args.key);
  if (key) rows.push({ name: "Key", value: key });
  const keys = readStringArray(args.keys);
  if (keys.length > 0) rows.push({ name: "Shortcut", value: keys.join("+") });
  const dx = readNumber(args.delta_x);
  const dy = readNumber(args.delta_y);
  if (dx !== null || dy !== null) {
    rows.push({ name: "Scroll", value: `${dx ?? 0}, ${dy ?? 0}` });
  }
  // The range is what is being approved — show it as one fact, the way a
  // coordinate pair is.
  if (tool === "computer_select_text") {
    const start = readNumber(args.start);
    const length = readNumber(args.length);
    if (start !== null && length !== null) {
      rows.push({ name: "Range", value: `${start}, ${length}` });
    }
  }
  const action = readString(args.action);
  if (action) rows.push({ name: "Action", value: action });
  const topic = readString(args.topic);
  if (topic) rows.push({ name: "Topic", value: topic });
  const app = readString(args.app) ?? readString(args.name) ?? readString(args.bundle_id);
  if (app) rows.push({ name: "App", value: app });
  // The off-screen flag changes what the launch does to the user's screen, so
  // the card shows it rather than letting "Open an app" read as ordinary.
  if (tool === "computer_launch_app" && args.hidden === true) {
    rows.push({ name: "Hidden", value: "yes" });
  }
  // The pid is what the call actually targeted; the app name resolved into the
  // summary is the friendly gloss, not a substitute for the real argument.
  if (tool === "computer_set_app_visibility") {
    const pid = readNumber(args.pid);
    if (pid !== null) rows.push({ name: "PID", value: `${pid}` });
  }
  // A run approves the whole list at once, so the list is what the card must
  // show: each step's verb, in order, never its arguments.
  if (tool === "computer_run" && Array.isArray(args.steps)) {
    const kinds = args.steps
      .map((step) => readString(readRecord(step)?.type))
      .filter((kind): kind is string => kind !== null);
    rows.push({
      name: "Steps",
      value: truncate(kinds.length > 0 ? kinds.join(" → ") : `${args.steps.length}`, 200),
    });
  }
  return rows;
}

function resolveWindow(
  windowId: unknown,
  windows: readonly ComputerWindow[] | undefined,
): string | null {
  const id = readString(windowId);
  if (!id || !windows) return null;
  const match = windows.find((window) => window.id === id);
  if (!match) return null;
  const app = match.appName?.trim();
  const title = match.title?.trim();
  if (app && title && title !== app) return `${app} — ${truncate(title, 48)}`;
  return app || (title ? truncate(title, 48) : null);
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readStringArray(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function truncate(value: string, max: number): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max - 1)}…`;
}
