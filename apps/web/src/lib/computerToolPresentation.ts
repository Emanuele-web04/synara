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

/** The gateway's Computer tools, and the verb each one performs. */
export const COMPUTER_TOOL_TITLES = {
  computer_screenshot: "Take a screenshot",
  computer_get_state: "Read the screen",
  computer_get_screen_size: "Measure the screen",
  computer_list_windows: "Find open windows",
  computer_list_apps: "List apps",
  computer_verify_state: "Verify state",
  computer_zoom: "Zoom into a window",
  computer_get_accessibility_tree: "List apps and windows",
  computer_get_cursor_position: "Read the cursor position",
  computer_help: "Read the Computer playbook",
  computer_click: "Click",
  computer_move_cursor: "Move the agent cursor",
  computer_drag: "Drag",
  computer_scroll: "Scroll",
  computer_type_text: "Type",
  computer_press_key: "Press a key",
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
  computer_inspect: "Inspect the computer",
  computer_spaces: "Inspect desktop Spaces",
  computer_browser_state: "Read the browser page",
  computer_browser_prepare: "Prepare a browser",
  computer_browser_navigate: "Open a browser page",
  computer_browser_click: "Click in the browser",
  computer_browser_type: "Type in a browser field",
  computer_browser_dialog: "Handle a browser dialog",
  computer_browser_upload: "Attach files in the browser",
  computer_browser_download: "Download a file",
  computer_browser_pointer: "Use the pointer in the browser",
  computer_browser_press: "Press Enter in the browser",
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
  if (tool === "computer_inspect") {
    const selectedTool = readString(args.tool);
    if (
      selectedTool === "computer_read_clipboard" ||
      selectedTool === "computer_zoom" ||
      selectedTool === "computer_get_accessibility_tree" ||
      selectedTool === "computer_get_cursor_position" ||
      selectedTool === "computer_spaces"
    ) {
      const description = describeComputerToolCall({
        toolName: selectedTool,
        args: readRecord(args.arguments) ?? undefined,
        windows: input.windows,
      })!;
      return {
        ...description,
        tool,
        params: selectedTool === "computer_read_clipboard" ? [] : description.params,
      };
    }
  }
  if (tool === "computer_spaces") {
    const summaries: Record<string, string> = {
      list: "Inspect desktop Spaces",
      reserve: "Reserve a desktop Space for this task",
      release: "Release the task's desktop Space",
      select: "Select a window in the task's Space",
      peek: "Inspect a window without switching Spaces",
    };
    return {
      tool,
      summary: Object.hasOwn(summaries, readString(args.operation) ?? "list")
        ? summaries[readString(args.operation) ?? "list"]!
        : "Check a desktop Space operation",
      params: describeParams(tool, args, input.windows),
    };
  }
  if (tool.startsWith("computer_browser_")) {
    return {
      tool,
      summary: describeBrowserAction(tool, args),
      params: describeParams(tool, args, input.windows),
    };
  }
  // The visibility pair's flag is the verb's direction: an approval that reads
  // "Minimize or restore" makes the user guess which half is being asked for.
  const verb =
    tool === "computer_press_key" && readString(args.key)
      ? "Press"
      : tool === "computer_launch_app"
        ? "Open"
        : tool === "computer_activate_window"
          ? `Switch to ${
              readString(args.app_name) ??
              readString(args.application) ??
              readString(args.app) ??
              resolveWindow(args.window_id, input.windows) ??
              ""
            }`.trimEnd()
          : ((tool === "computer_set_window_minimized"
              ? directionVerb(args.minimized, "Minimize a window", "Restore a window")
              : tool === "computer_set_app_visibility"
                ? directionVerb(args.hidden, "Hide an app", "Unhide an app")
                : undefined) ?? COMPUTER_TOOL_TITLES[tool]);
  const where =
    tool === "computer_launch_app" || tool === "computer_activate_window"
      ? ""
      : tool === "computer_drag"
        ? describeDragTarget(args, input.windows)
        : tool === "computer_set_app_visibility"
          ? describePidTarget(args, input.windows)
          : describeTarget(
              args,
              input.windows,
              tool === "computer_wait"
                ? "for"
                : tool === "computer_type_text" || tool === "computer_set_value"
                  ? "in"
                  : "on",
              tool === "computer_zoom",
            );
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
  labelPreposition: "on" | "for" | "in" = "on",
  alwaysShowCoordinates = false,
): string {
  const parts: string[] = [];
  const label = readString(args.label);
  const x = readNumber(args.x);
  const y = readNumber(args.y);
  const coordinates = x !== null && y !== null ? `at (${x}, ${y})` : null;
  const window = resolveWindow(args.window_id, windows);
  const app = readString(args.app_name) ?? readString(args.application) ?? readString(args.app);
  if (label) {
    parts.push(`${labelPreposition} “${label}”`);
  } else if (alwaysShowCoordinates && coordinates) {
    parts.push(coordinates);
  }
  if (window) {
    parts.push(`in ${window}`);
  } else if (app) {
    parts.push(`in ${app}`);
  }
  // Coordinates appear only when nothing else names the target: a window or
  // app title is what a person checks against their screen, and the raw pair
  // stays in the parameter rows either way. Zoom is the exception — the region
  // is the whole point of the call.
  if (parts.length === 0 && coordinates) {
    parts.push(coordinates);
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
    return key === null ? "" : keyboardShortcut(key);
  }
  if (tool === "computer_scroll") {
    const dx = readNumber(args.delta_x) ?? 0;
    const dy = readNumber(args.delta_y) ?? 0;
    if (dy !== 0) return dy > 0 ? "down" : "up";
    if (dx !== 0) return dx > 0 ? "right" : "left";
    return "";
  }
  if (tool === "computer_launch_app") {
    const app = appName(args.app) ?? appName(args.name) ?? appName(args.bundle_id);
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

function describeBrowserAction(
  tool: ComputerToolName,
  args: Readonly<Record<string, unknown>>,
): string {
  if (tool === "computer_browser_prepare" && args.allow_launch === true) {
    return args.windowed === true
      ? "Open an isolated browser window"
      : "Open an isolated browser in the background";
  }
  if (tool === "computer_browser_navigate") {
    const site = browserSite(args.url);
    if (site) return `Open ${site} in the browser`;
  }
  if (tool === "computer_browser_type" && args.replace === true) {
    return args.text === "" ? "Clear a browser field" : "Replace text in a browser field";
  }
  if (tool === "computer_browser_dialog") {
    const verbs: Record<string, string> = { inspect: "Read", accept: "Accept", dismiss: "Dismiss" };
    const verb =
      typeof args.action === "string" && Object.hasOwn(verbs, args.action)
        ? verbs[args.action]
        : undefined;
    if (verb) return `${verb} a browser dialog`;
  }
  if (tool === "computer_browser_upload") {
    const count = readStringArray(args.files).length;
    if (count > 0) return `Attach ${count === 1 ? "a file" : `${count} files`} in the browser`;
  }
  if (tool === "computer_browser_pointer") {
    const actions: Record<string, string> = {
      hover: "Hover over a browser control",
      right_click: "Right-click in the browser",
      double_click: "Double-click in the browser",
      drag: "Drag in the browser",
    };
    if (args.action === "scroll") {
      return ["Scroll", describePayload("computer_scroll", args), "in the browser"]
        .filter(Boolean)
        .join(" ");
    }
    const action =
      typeof args.action === "string" && Object.hasOwn(actions, args.action)
        ? actions[args.action]
        : undefined;
    if (action) return action;
  }
  return COMPUTER_TOOL_TITLES[tool];
}

/** A page's domain is useful context; credentials, paths and query values are not a tool title. */
function browserSite(value: unknown): string | null {
  const url = readString(value);
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? truncate(parsed.hostname, 80)
      : null;
  } catch {
    return null;
  }
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

function keyboardShortcut(value: string): string {
  return value
    .split(/\+(?=.)/)
    .map((key) => keyName(key.trim()))
    .join(" + ");
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
  const nativeSpaceId = readNumber(args.space_id);
  if (tool === "computer_spaces" && nativeSpaceId !== null)
    rows.push({ name: "Space ID", value: String(nativeSpaceId) });
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
  if (key) rows.push({ name: "Key", value: keyboardShortcut(key) });
  const keys = readStringArray(args.keys);
  if (keys.length > 0) rows.push({ name: "Shortcut", value: keys.map(keyName).join(" + ") });
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
  if (action && !tool.startsWith("computer_browser_")) rows.push({ name: "Action", value: action });
  const topic = readString(args.topic);
  if (topic) rows.push({ name: "Topic", value: topic });
  const app = readString(args.app) ?? readString(args.name) ?? readString(args.bundle_id);
  if (app) rows.push({ name: "App", value: app });
  if (tool.startsWith("computer_browser_")) {
    const site = browserSite(args.url);
    if (site) rows.push({ name: "Website", value: site });
    const files = readStringArray(args.files);
    if (files.length > 0) rows.push({ name: "Files", value: `${files.length}` });
    if (tool === "computer_browser_prepare" && args.allow_launch === true) {
      rows.push({
        name: "Browser",
        value: args.windowed === true ? "Visible window" : "Background",
      });
    }
  }
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
      value: truncate(
        kinds.length > 0
          ? kinds
              .map((kind) => {
                const name = computerToolName(`computer_${kind}`);
                return name ? COMPUTER_TOOL_TITLES[name] : "Action";
              })
              .join(" → ")
          : `${args.steps.length}`,
        200,
      ),
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
