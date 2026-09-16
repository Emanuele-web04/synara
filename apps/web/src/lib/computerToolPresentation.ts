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
  computer_list_windows: "Find open windows",
  computer_click: "Click",
  computer_double_click: "Double-click",
  computer_triple_click: "Triple-click",
  computer_right_click: "Right-click",
  computer_move_cursor: "Move the cursor",
  computer_drag: "Drag",
  computer_scroll: "Scroll",
  computer_type_text: "Type text",
  computer_press_key: "Press a key",
  computer_hotkey: "Press a shortcut",
  computer_set_value: "Fill in a field",
  computer_perform_action: "Activate a control",
  computer_launch_app: "Open an app",
  computer_activate_window: "Switch windows",
  computer_wait: "Wait",
  computer_read_clipboard: "Read the clipboard",
  computer_write_clipboard: "Write to the clipboard",
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
 * "Click on “Save” in Safari — Google".
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
  let verb: string = COMPUTER_TOOL_TITLES[tool];
  const app =
    resolveWindow(args.window_id, input.windows) ??
    appName(args.app_name ?? args.application ?? args.app);
  if (tool === "computer_launch_app") {
    const name = appName(args.app ?? args.name ?? args.bundle_id);
    return {
      tool,
      summary: name ? `Open ${name}` : verb,
      params: describeParams(tool, args, input.windows),
    };
  }
  if (tool === "computer_activate_window" && app) {
    return { tool, summary: `Switch to ${app}`, params: describeParams(tool, args, input.windows) };
  }
  if (tool === "computer_press_key" && readString(args.key)) verb = "Press";
  if (tool === "computer_hotkey" && readStringArray(args.keys).length) verb = "Press";
  if (tool === "computer_set_value" && readString(args.label)) verb = "Fill in";
  if (tool === "computer_type_text" && readString(args.label)) verb = "Type";
  const where =
    tool === "computer_drag"
      ? describeDragTarget(args, input.windows)
      : describeTarget(
          args,
          input.windows,
          tool === "computer_wait"
            ? "for"
            : tool === "computer_type_text"
              ? "in"
              : tool === "computer_set_value"
                ? ""
                : "on",
        );
  const what = describePayload(tool, args);

  const summary = [verb, what, where].filter((part) => part.length > 0).join(" ");
  return { tool, summary, params: describeParams(tool, args, input.windows) };
}

/** Semantic targets belong in the summary; coordinates stay in the details. */
function describeTarget(
  args: Readonly<Record<string, unknown>>,
  windows: readonly ComputerWindow[] | undefined,
  labelPreposition: "on" | "for" | "in" | "" = "on",
): string {
  const parts: string[] = [];
  const label = readString(args.label);
  if (label) {
    parts.push([labelPreposition, `“${truncate(label, 80)}”`].filter(Boolean).join(" "));
  }
  const window = resolveWindow(args.window_id, windows);
  const app = appName(args.app_name ?? args.application ?? args.app);
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
    tool === "computer_write_clipboard"
  ) {
    return "";
  }
  if (tool === "computer_press_key") {
    const key = readString(args.key);
    return key === null ? "" : keyName(key);
  }
  if (tool === "computer_hotkey") {
    const keys = readStringArray(args.keys);
    return keys.map(keyName).join(" + ");
  }
  if (tool === "computer_scroll") {
    const dx = readNumber(args.delta_x) ?? 0;
    const dy = readNumber(args.delta_y) ?? 0;
    if (dy !== 0) return dy > 0 ? "down" : "up";
    if (dx !== 0) return dx > 0 ? "right" : "left";
    return "";
  }
  if (tool === "computer_wait" && !readString(args.label)) {
    const durationMs = readNumber(args.duration_ms);
    if (durationMs === null) return "";
    const seconds = durationMs / 1_000;
    return `for ${seconds} ${seconds === 1 ? "second" : "seconds"}`;
  }
  return "";
}

function appName(value: unknown): string | null {
  const name = readString(value)?.trim();
  if (!name) return null;
  const basename = name
    .split(/[\\/]/)
    .at(-1)!
    .replace(/\.app$/i, "");
  const label = /^(?:[a-z][a-z0-9-]*\.){2,}/i.test(basename)
    ? basename.split(".").at(-1)!
    : basename;
  return truncate(label.charAt(0).toUpperCase() + label.slice(1), 80);
}

const KEY_NAMES: Readonly<Record<string, string>> = {
  cmd: "Command",
  command: "Command",
  super: "Super",
  meta: "Meta",
  ctrl: "Control",
  control: "Control",
  alt: "Alt",
  option: "Option",
  shift: "Shift",
  return: "Enter",
  enter: "Enter",
  esc: "Escape",
  escape: "Escape",
  space: "Space",
  tab: "Tab",
  backspace: "Backspace",
  delete: "Delete",
  arrowup: "Up arrow",
  arrowdown: "Down arrow",
  arrowleft: "Left arrow",
  arrowright: "Right arrow",
};

function keyName(key: string): string {
  return KEY_NAMES[key.toLowerCase()] ?? (key.length === 1 ? key.toUpperCase() : key);
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
  if (x !== null && y !== null) rows.push({ name: "Position", value: `${x}, ${y}` });
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
  if (key) rows.push({ name: "Key", value: keyName(key) });
  const keys = readStringArray(args.keys);
  if (keys.length > 0) rows.push({ name: "Shortcut", value: keys.map(keyName).join(" + ") });
  const dx = readNumber(args.delta_x);
  const dy = readNumber(args.delta_y);
  if (dx !== null || dy !== null) {
    rows.push({ name: "Scroll", value: `${dx ?? 0}, ${dy ?? 0}` });
  }
  const action = readString(args.action);
  if (action) rows.push({ name: "Action", value: action });
  const app = appName(args.app ?? args.name ?? args.bundle_id);
  if (app) rows.push({ name: "App", value: app });
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
