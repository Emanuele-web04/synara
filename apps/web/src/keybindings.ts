import {
  type KeybindingCommand,
  type ResolvedKeybindingRule,
  type KeybindingShortcut,
  type KeybindingWhenNode,
  type ResolvedKeybindingsConfig,
  SPACE_JUMP_KEYBINDING_COMMANDS,
  type SpaceJumpKeybindingCommand,
  THREAD_JUMP_KEYBINDING_COMMANDS,
  type ThreadJumpKeybindingCommand,
} from "@synara/contracts";
import { isKeyboardShortcutsHelpChord } from "@synara/shared/browserShortcuts";
import { isUnassignedKeybindingShortcut } from "@synara/shared/keybindingRules";
import { isMacPlatform, isWindowsPlatform } from "./lib/utils";

export interface ShortcutEventLike {
  type?: string;
  code?: string;
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  repeat?: boolean;
}

export interface ShortcutMatchContext {
  terminalFocus: boolean;
  terminalOpen: boolean;
  [key: string]: boolean;
}

interface ShortcutMatchOptions {
  platform?: string;
  context?: Partial<ShortcutMatchContext>;
}

interface ResolvedShortcutLabelOptions extends ShortcutMatchOptions {
  platform?: string;
}

function commandShortcut(
  key: string,
  overrides: Partial<Omit<KeybindingShortcut, "key">> = {},
): KeybindingShortcut {
  return {
    key,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    modKey: true,
    ...overrides,
  };
}

function whenIdentifier(name: string): KeybindingWhenNode {
  return { type: "identifier", name };
}

function whenNot(node: KeybindingWhenNode): KeybindingWhenNode {
  return { type: "not", node };
}

function whenAnd(left: KeybindingWhenNode, right: KeybindingWhenNode): KeybindingWhenNode {
  return { type: "and", left, right };
}

function whenOr(left: KeybindingWhenNode, right: KeybindingWhenNode): KeybindingWhenNode {
  return { type: "or", left, right };
}

const whenNotTerminalFocus = whenNot(whenIdentifier("terminalFocus"));
// Cmd+1…9 is app navigation on macOS, including from a focused/full-width terminal.
// On Linux/Windows `mod` is Ctrl, so keep yielding the chord to the shell and to the
// terminal workspace's Ctrl+1/Ctrl+2 tabs while that surface is open.
const whenThreadJumpAvailable = whenOr(
  whenAnd(whenNotTerminalFocus, whenNot(whenIdentifier("terminalWorkspaceOpen"))),
  whenIdentifier("isMac"),
);
// App-level `mod` chords (new chat/terminal/provider chat/split, copy thread id) bind to
// `mod`, which is Cmd on macOS. xterm never forwards a Cmd-chord to the PTY, so a bare
// `!terminalFocus` guard silently dropped these chords whenever the terminal had focus
// — the chord did nothing instead of running the command. `|| isMac` lets them fire from
// the terminal on macOS while still yielding the chord to the shell on Linux/Windows,
// where `mod` is Ctrl and keys like Ctrl+N are real shell input that must pass through.
const whenModChordAllowed = whenOr(whenNotTerminalFocus, whenIdentifier("isMac"));

export const DEFAULT_SHORTCUT_FALLBACKS: ResolvedKeybindingsConfig = [
  {
    command: "sidechat.toggle",
    shortcut: commandShortcut("s", { altKey: true }),
    whenAst: whenModChordAllowed,
  },
  {
    command: "sidebar.activity",
    shortcut: commandShortcut("u", { altKey: true }),
    whenAst: whenModChordAllowed,
  },
  {
    command: "sidebar.addProject",
    shortcut: commandShortcut("o", { shiftKey: true }),
    whenAst: whenNotTerminalFocus,
  },
  {
    command: "sidebar.importThread",
    shortcut: commandShortcut("i"),
    whenAst: whenNotTerminalFocus,
  },
  {
    command: "chat.new",
    shortcut: commandShortcut("n"),
    whenAst: whenModChordAllowed,
  },
  {
    command: "chat.newLatestProject",
    shortcut: commandShortcut("n", { shiftKey: true }),
    whenAst: whenModChordAllowed,
  },
  {
    command: "chat.newClaude",
    shortcut: commandShortcut("c", { altKey: true }),
    whenAst: whenModChordAllowed,
  },
  {
    command: "chat.newChat",
    shortcut: commandShortcut("n", { altKey: true }),
    whenAst: whenModChordAllowed,
  },
  {
    command: "chat.newTerminal",
    shortcut: commandShortcut("t", { shiftKey: true }),
    whenAst: whenModChordAllowed,
  },
  {
    command: "chat.newCodex",
    shortcut: commandShortcut("x", { altKey: true }),
    whenAst: whenModChordAllowed,
  },
  {
    command: "chat.newCursor",
    shortcut: commandShortcut("r", { altKey: true }),
    whenAst: whenModChordAllowed,
  },
  {
    command: "chat.split",
    shortcut: commandShortcut("\\"),
    whenAst: whenModChordAllowed,
  },
  // Installed-app only (Electron / standalone PWA). Browsers reserve Ctrl+Tab and
  // Ctrl+Shift+Tab for tab switching and won't deliver them to the page, so the
  // recent-view switcher does not open in a normal browser tab. Uses literal Ctrl
  // (not mod) on purpose so it stays Ctrl+Tab on macOS too, matching Arc/Helium.
  // This intentionally ignores terminal focus; the chat route captures the chord
  // before xterm can pass it through to the shell.
  {
    command: "view.recent.next",
    shortcut: commandShortcut("tab", { ctrlKey: true, modKey: false }),
  },
  {
    command: "view.recent.previous",
    shortcut: commandShortcut("tab", { ctrlKey: true, shiftKey: true, modKey: false }),
  },
  {
    command: "modelPicker.toggle",
    shortcut: commandShortcut("m", { shiftKey: true }),
    whenAst: whenNotTerminalFocus,
  },
  {
    command: "model.next",
    shortcut: commandShortcut("]", { altKey: true, modKey: false }),
    whenAst: whenNotTerminalFocus,
  },
  {
    command: "model.previous",
    shortcut: commandShortcut("[", { altKey: true, modKey: false }),
    whenAst: whenNotTerminalFocus,
  },
  {
    command: "model.effort.next",
    shortcut: commandShortcut("tab", { shiftKey: true, modKey: false }),
    whenAst: whenIdentifier("composerFocus"),
  },
  {
    command: "traitsPicker.toggle",
    shortcut: commandShortcut("e", { shiftKey: true }),
    whenAst: whenNotTerminalFocus,
  },
  {
    command: "diff.change.next",
    shortcut: commandShortcut("arrowdown", { altKey: true, modKey: false }),
    whenAst: whenNotTerminalFocus,
  },
  {
    command: "diff.change.previous",
    shortcut: commandShortcut("arrowup", { altKey: true, modKey: false }),
    whenAst: whenNotTerminalFocus,
  },
  // Cmd-only instead of mod so Ctrl+L remains available to shells on non-macOS.
  {
    command: "composer.focus.toggle",
    shortcut: commandShortcut("l", { metaKey: true, modKey: false }),
    whenAst: whenNotTerminalFocus,
  },
  {
    command: "chat.find",
    shortcut: commandShortcut("f"),
    whenAst: whenNotTerminalFocus,
  },
  {
    command: "settings.usage",
    shortcut: commandShortcut("u", { shiftKey: true }),
    whenAst: whenNotTerminalFocus,
  },
  // Cmd+Ctrl+P on macOS. On Windows/Linux the literal chord would require the
  // Super/Windows key, which window managers routinely swallow before it reaches
  // the app, so those platforms get Ctrl+Alt+P instead (see the sibling entry below).
  {
    command: "git.commitAndPush",
    shortcut: commandShortcut("p", { metaKey: true, ctrlKey: true, modKey: false }),
    whenAst: whenAnd(whenNotTerminalFocus, whenIdentifier("isMac")),
  },
  {
    command: "git.commitAndPush",
    shortcut: commandShortcut("p", { ctrlKey: true, altKey: true, modKey: false }),
    whenAst: whenAnd(whenNotTerminalFocus, whenNot(whenIdentifier("isMac"))),
  },
  // Open thread tabs, browser-style; see the server defaults for why the chords differ.
  {
    command: "threadTab.next",
    shortcut: commandShortcut("arrowright", { ctrlKey: true }),
    whenAst: whenIdentifier("isMac"),
  },
  {
    command: "threadTab.previous",
    shortcut: commandShortcut("arrowleft", { ctrlKey: true }),
    whenAst: whenIdentifier("isMac"),
  },
  {
    command: "threadTab.next",
    shortcut: commandShortcut("pagedown", { ctrlKey: true, modKey: false }),
    whenAst: whenAnd(whenNotTerminalFocus, whenNot(whenIdentifier("isMac"))),
  },
  {
    command: "threadTab.previous",
    shortcut: commandShortcut("pageup", { ctrlKey: true, modKey: false }),
    whenAst: whenAnd(whenNotTerminalFocus, whenNot(whenIdentifier("isMac"))),
  },
  // Numbered space jumps target the switcher's visual tab order (mod+alt+1 = Void).
  // Same guard as the creation chords: Cmd+Alt never reaches the PTY on macOS, while
  // Ctrl+Alt+digit doubles as AltGr input on Linux/Windows and must yield to terminals.
  ...SPACE_JUMP_KEYBINDING_COMMANDS.map((command, index) => ({
    command,
    shortcut: commandShortcut(String(index + 1), { altKey: true }),
    whenAst: whenModChordAllowed,
  })),
  {
    command: "thread.jump.1",
    shortcut: commandShortcut("1"),
    whenAst: whenThreadJumpAvailable,
  },
  {
    command: "thread.jump.2",
    shortcut: commandShortcut("2"),
    whenAst: whenThreadJumpAvailable,
  },
  {
    command: "thread.jump.3",
    shortcut: commandShortcut("3"),
    whenAst: whenThreadJumpAvailable,
  },
  {
    command: "thread.jump.4",
    shortcut: commandShortcut("4"),
    whenAst: whenThreadJumpAvailable,
  },
  {
    command: "thread.jump.5",
    shortcut: commandShortcut("5"),
    whenAst: whenThreadJumpAvailable,
  },
  {
    command: "thread.jump.6",
    shortcut: commandShortcut("6"),
    whenAst: whenThreadJumpAvailable,
  },
  {
    command: "thread.jump.7",
    shortcut: commandShortcut("7"),
    whenAst: whenThreadJumpAvailable,
  },
  {
    command: "thread.jump.8",
    shortcut: commandShortcut("8"),
    whenAst: whenThreadJumpAvailable,
  },
  {
    command: "thread.jump.9",
    shortcut: commandShortcut("9"),
    whenAst: whenThreadJumpAvailable,
  },
  {
    command: "thread.copyId",
    shortcut: commandShortcut("c", { shiftKey: true }),
    whenAst: whenModChordAllowed,
  },
  {
    command: "terminal.workspace.newFullWidth",
    shortcut: commandShortcut("j", { shiftKey: true }),
  },
  {
    command: "terminal.workspace.closeActive",
    shortcut: commandShortcut("w"),
    whenAst: whenIdentifier("terminalWorkspaceOpen"),
  },
  {
    command: "terminal.workspace.terminal",
    shortcut: commandShortcut("1", { ctrlKey: true, modKey: false }),
    whenAst: whenIdentifier("terminalWorkspaceOpen"),
  },
  {
    command: "terminal.workspace.chat",
    shortcut: commandShortcut("2", { ctrlKey: true, modKey: false }),
    whenAst: whenIdentifier("terminalWorkspaceOpen"),
  },
  {
    command: "editor.file.save",
    shortcut: commandShortcut("s"),
    whenAst: whenNotTerminalFocus,
  },
];

const TERMINAL_WORD_BACKWARD = "\u001bb";
const TERMINAL_WORD_FORWARD = "\u001bf";
const TERMINAL_LINE_START = "\u0001";
const TERMINAL_LINE_END = "\u0005";
const EVENT_CODE_KEY_ALIASES: Readonly<Record<string, readonly string[]>> = {
  // Option+Space reports a non-breaking space on macOS, so match it by physical key.
  Space: [" "],
  BracketLeft: ["["],
  BracketRight: ["]"],
  Digit0: ["0"],
  Digit1: ["1"],
  Digit2: ["2"],
  Digit3: ["3"],
  Digit4: ["4"],
  Digit5: ["5"],
  Digit6: ["6"],
  Digit7: ["7"],
  Digit8: ["8"],
  Digit9: ["9"],
  KeyA: ["a"],
  KeyB: ["b"],
  KeyC: ["c"],
  KeyD: ["d"],
  KeyE: ["e"],
  KeyF: ["f"],
  KeyG: ["g"],
  KeyH: ["h"],
  KeyI: ["i"],
  KeyJ: ["j"],
  KeyK: ["k"],
  KeyL: ["l"],
  KeyM: ["m"],
  KeyN: ["n"],
  KeyO: ["o"],
  KeyP: ["p"],
  KeyQ: ["q"],
  KeyR: ["r"],
  KeyS: ["s"],
  KeyT: ["t"],
  KeyU: ["u"],
  KeyV: ["v"],
  KeyW: ["w"],
  KeyX: ["x"],
  KeyY: ["y"],
  KeyZ: ["z"],
};

/**
 * The layout-independent key a physical key matches as, or null for keys that are
 * only matched by the character they produce.
 */
export function shortcutKeyFromEventCode(code: string | undefined): string | null {
  return (code ? EVENT_CODE_KEY_ALIASES[code]?.[0] : undefined) ?? null;
}

/**
 * A rule that only records that its command was left without a shortcut. It keeps the
 * command "configured" so the fallback table below does not bring a default back, and
 * it is never a binding itself.
 */
export function isUnassignedKeybinding(binding: Pick<ResolvedKeybindingRule, "shortcut">): boolean {
  return isUnassignedKeybindingShortcut(binding.shortcut);
}

let dispatchSuspensions = 0;

/**
 * Stops every shortcut from resolving until the returned function is called. The
 * shortcut recorder holds this while open, so the keys being recorded reach it instead
 * of running the command they are currently bound to.
 */
export function suspendShortcutDispatch(): () => void {
  dispatchSuspensions += 1;
  let resumed = false;
  return () => {
    if (resumed) return;
    resumed = true;
    dispatchSuspensions -= 1;
  };
}

/** True while a shortcut recorder holds the keyboard. */
export function isShortcutDispatchSuspended(): boolean {
  return dispatchSuspensions > 0;
}

function normalizeEventKey(key: string): string {
  const normalized = key.toLowerCase();
  if (normalized === "esc") return "escape";
  if (normalized === "{") return "[";
  if (normalized === "}") return "]";
  return normalized;
}

/**
 * The keys a press can match as. A typed letter or digit is the only one: it is the key
 * the user's layout prints, and the one the recorder saves. Matching its physical key as
 * well would fire two bindings at once on layouts that move letters (AZERTY's Q types
 * "a"). Anything else, such as "ß" from Option+S or "!" from Shift+1, also matches as the
 * physical key, since that is the key the binding names.
 */
function resolveEventKeys(event: ShortcutEventLike): Set<string> {
  const typed = normalizeEventKey(event.key);
  const keys = new Set([typed]);
  if (/^[a-z0-9]$/.test(typed)) return keys;
  const aliases = event.code ? EVENT_CODE_KEY_ALIASES[event.code] : undefined;
  if (!aliases) return keys;

  for (const alias of aliases) {
    keys.add(alias);
  }
  return keys;
}

function matchesShortcutModifiers(
  event: ShortcutEventLike,
  shortcut: KeybindingShortcut,
  platform = navigator.platform,
): boolean {
  const useMetaForMod = isMacPlatform(platform);
  const expectedMeta = shortcut.metaKey || (shortcut.modKey && useMetaForMod);
  const expectedCtrl = shortcut.ctrlKey || (shortcut.modKey && !useMetaForMod);
  return (
    event.metaKey === expectedMeta &&
    event.ctrlKey === expectedCtrl &&
    event.shiftKey === shortcut.shiftKey &&
    event.altKey === shortcut.altKey
  );
}

/** Whether a key press is exactly `shortcut`, with the same rules as every binding. */
export function matchesShortcut(
  event: ShortcutEventLike,
  shortcut: KeybindingShortcut,
  platform = navigator.platform,
): boolean {
  if (!matchesShortcutModifiers(event, shortcut, platform)) return false;
  return resolveEventKeys(event).has(shortcut.key);
}

function resolvePlatform(options: ShortcutMatchOptions | undefined): string {
  return options?.platform ?? navigator.platform;
}

function resolveContext(options: ShortcutMatchOptions | undefined): ShortcutMatchContext {
  // `isMac` is derived from the resolved platform so `when` clauses can gate on it
  // (e.g. `whenModChordAllowed`) without every dispatch site having to thread the flag
  // through `context`. An explicit `context.isMac` still wins via the spread below.
  return {
    terminalFocus: false,
    terminalOpen: false,
    isMac: isMacPlatform(resolvePlatform(options)),
    ...options?.context,
  };
}

export function evaluateWhenNode(
  node: KeybindingWhenNode,
  context: Readonly<Record<string, boolean>>,
): boolean {
  switch (node.type) {
    case "identifier":
      if (node.name === "true") return true;
      if (node.name === "false") return false;
      return Boolean(context[node.name]);
    case "not":
      return !evaluateWhenNode(node.node, context);
    case "and":
      return evaluateWhenNode(node.left, context) && evaluateWhenNode(node.right, context);
    case "or":
      return evaluateWhenNode(node.left, context) || evaluateWhenNode(node.right, context);
  }
}

function matchesWhenClause(
  whenAst: KeybindingWhenNode | undefined,
  context: ShortcutMatchContext,
): boolean {
  if (!whenAst) return true;
  return evaluateWhenNode(whenAst, context);
}

/** Identity of the physical chord a shortcut resolves to on `platform`. */
export function shortcutConflictKey(
  shortcut: KeybindingShortcut,
  platform = navigator.platform,
): string {
  const useMetaForMod = isMacPlatform(platform);
  const metaKey = shortcut.metaKey || (shortcut.modKey && useMetaForMod);
  const ctrlKey = shortcut.ctrlKey || (shortcut.modKey && !useMetaForMod);

  return [
    shortcut.key,
    metaKey ? "meta" : "",
    ctrlKey ? "ctrl" : "",
    shortcut.shiftKey ? "shift" : "",
    shortcut.altKey ? "alt" : "",
  ].join("|");
}

function findEffectiveShortcutForCommand(
  keybindings: ResolvedKeybindingsConfig,
  command: KeybindingCommand,
  options?: ShortcutMatchOptions,
): KeybindingShortcut | null {
  return findEffectiveKeybindingForCommand(keybindings, command, options)?.shortcut ?? null;
}

export function findEffectiveKeybindingForCommand(
  keybindings: ResolvedKeybindingsConfig,
  command: KeybindingCommand,
  options?: ShortcutMatchOptions,
): ResolvedKeybindingRule | null {
  const platform = resolvePlatform(options);
  const context = resolveContext(options);
  const claimedShortcuts = new Set<string>();

  for (let index = keybindings.length - 1; index >= 0; index -= 1) {
    const binding = keybindings[index];
    if (!binding || isUnassignedKeybinding(binding)) continue;
    if (!matchesWhenClause(binding.whenAst, context)) continue;

    const conflictKey = shortcutConflictKey(binding.shortcut, platform);
    if (claimedShortcuts.has(conflictKey)) {
      continue;
    }

    claimedShortcuts.add(conflictKey);
    if (binding.command === command) {
      return binding;
    }
  }

  return null;
}

export function resolveKeybindingForCommand(
  keybindings: ResolvedKeybindingsConfig,
  command: KeybindingCommand,
  options?: ShortcutMatchOptions,
): ResolvedKeybindingRule | null {
  return (
    findEffectiveKeybindingForCommand(keybindings, command, options) ??
    findEffectiveKeybindingForCommand(getFallbackBindings(keybindings), command, options)
  );
}

export function formatKeybindingWhenExpression(node: KeybindingWhenNode | undefined): string {
  if (!node) return "";
  switch (node.type) {
    case "identifier":
      return node.name;
    case "not":
      return `!(${formatKeybindingWhenExpression(node.node)})`;
    case "and":
      return `(${formatKeybindingWhenExpression(node.left)} && ${formatKeybindingWhenExpression(node.right)})`;
    case "or":
      return `(${formatKeybindingWhenExpression(node.left)} || ${formatKeybindingWhenExpression(node.right)})`;
  }
}

function matchesCommandShortcut(
  event: ShortcutEventLike,
  keybindings: ResolvedKeybindingsConfig,
  command: KeybindingCommand,
  options?: ShortcutMatchOptions,
): boolean {
  return resolveShortcutCommand(event, keybindings, options) === command;
}

function resolveShortcutCommandFromBindings(
  event: ShortcutEventLike,
  keybindings: ResolvedKeybindingsConfig,
  options?: ShortcutMatchOptions,
): KeybindingCommand | null {
  const platform = resolvePlatform(options);
  const context = resolveContext(options);

  for (let index = keybindings.length - 1; index >= 0; index -= 1) {
    const binding = keybindings[index];
    if (!binding || isUnassignedKeybinding(binding)) continue;
    if (!matchesWhenClause(binding.whenAst, context)) continue;
    if (!matchesShortcut(event, binding.shortcut, platform)) continue;
    return binding.command;
  }

  return null;
}

function getFallbackBindings(
  keybindings: ResolvedKeybindingsConfig,
): ReadonlyArray<ResolvedKeybindingRule> {
  const configuredCommands = new Set(keybindings.map((binding) => binding.command));
  return DEFAULT_SHORTCUT_FALLBACKS.filter((binding) => !configuredCommands.has(binding.command));
}

export function resolveShortcutCommand(
  event: ShortcutEventLike,
  keybindings: ResolvedKeybindingsConfig,
  options?: ShortcutMatchOptions,
): string | null {
  if (dispatchSuspensions > 0) return null;
  const explicitCommand = resolveShortcutCommandFromBindings(event, keybindings, options);
  if (explicitCommand !== null) {
    return explicitCommand;
  }

  const fallbackBindings = getFallbackBindings(keybindings);
  if (fallbackBindings.length === 0) {
    return null;
  }

  return resolveShortcutCommandFromBindings(event, fallbackBindings, options);
}

function formatShortcutKeyLabel(key: string): string {
  if (key === " ") return "Space";
  if (key.length === 1) return key.toUpperCase();
  if (key === "escape") return "Esc";
  if (key === "arrowup") return "Up";
  if (key === "arrowdown") return "Down";
  if (key === "arrowleft") return "Left";
  if (key === "arrowright") return "Right";
  if (key === "pageup") return "PgUp";
  if (key === "pagedown") return "PgDn";
  return key.slice(0, 1).toUpperCase() + key.slice(1);
}

export function formatShortcutLabel(
  shortcut: KeybindingShortcut,
  platform = navigator.platform,
): string {
  const keyLabel = formatShortcutKeyLabel(shortcut.key);
  const useMetaForMod = isMacPlatform(platform);
  const showMeta = shortcut.metaKey || (shortcut.modKey && useMetaForMod);
  const showCtrl = shortcut.ctrlKey || (shortcut.modKey && !useMetaForMod);
  const showAlt = shortcut.altKey;
  const showShift = shortcut.shiftKey;

  if (useMetaForMod) {
    return `${showCtrl ? "\u2303" : ""}${showAlt ? "\u2325" : ""}${showShift ? "\u21e7" : ""}${showMeta ? "\u2318" : ""}${keyLabel}`;
  }

  const parts: string[] = [];
  if (showCtrl) parts.push("Ctrl");
  if (showAlt) parts.push("Alt");
  if (showShift) parts.push("Shift");
  if (showMeta) parts.push("Meta");
  parts.push(keyLabel);
  return parts.join("+");
}

const MODIFIER_SYMBOLS = new Set(["⌘", "⌥", "⌃", "⇧"]);

export function splitShortcutLabel(shortcutLabel: string): string[] {
  // macOS labels are symbols with the key last ("⇧⌘K", "⌘+"); the rest are joined with
  // "+" ("Ctrl+Shift+K"), where a trailing "++" is the plus key itself.
  if (
    ![...shortcutLabel].some((char) => MODIFIER_SYMBOLS.has(char)) &&
    shortcutLabel.includes("+")
  ) {
    const plusKey = shortcutLabel === "+" || shortcutLabel.endsWith("++");
    const parts = (plusKey ? shortcutLabel.slice(0, -1) : shortcutLabel)
      .split("+")
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
    return plusKey ? [...parts, "+"] : parts;
  }

  if ([...shortcutLabel].some((char) => MODIFIER_SYMBOLS.has(char))) {
    const parts = [...shortcutLabel];
    const key = parts
      .filter((char) => !MODIFIER_SYMBOLS.has(char))
      .join("")
      .trim();
    const modifiers = parts.filter((char) => MODIFIER_SYMBOLS.has(char));
    return key.length > 0 ? [...modifiers, key] : modifiers;
  }

  return [shortcutLabel];
}

export function shortcutLabelForCommand(
  keybindings: ResolvedKeybindingsConfig,
  command: KeybindingCommand,
  options?: string | ResolvedShortcutLabelOptions,
): string | null {
  const resolvedOptions =
    typeof options === "string"
      ? ({ platform: options } satisfies ResolvedShortcutLabelOptions)
      : options;
  const platform = resolvePlatform(resolvedOptions);
  const contextProvided = resolvedOptions?.context !== undefined;

  if (!contextProvided) {
    // Honor platform-gated `when` clauses (e.g. `isMac` / `!isMac`) using default
    // focus flags so labels stay correct without a full UI context.
    const platformAware = findEffectiveShortcutForCommand(keybindings, command, { platform });
    if (platformAware) {
      return formatShortcutLabel(platformAware, platform);
    }
    // Fall back to the last binding ignoring `when` so focus-gated chords
    // (e.g. terminal-only) still surface a label in chrome affordances.
    for (let index = keybindings.length - 1; index >= 0; index -= 1) {
      const binding = keybindings[index];
      if (!binding || binding.command !== command || isUnassignedKeybinding(binding)) continue;
      return formatShortcutLabel(binding.shortcut, platform);
    }
    for (const binding of getFallbackBindings(keybindings)) {
      if (binding.command !== command) continue;
      return formatShortcutLabel(binding.shortcut, platform);
    }
    return null;
  }

  const shortcut = findEffectiveShortcutForCommand(keybindings, command, resolvedOptions);
  if (shortcut) {
    return formatShortcutLabel(shortcut, platform);
  }

  const fallbackShortcut = findEffectiveShortcutForCommand(
    getFallbackBindings(keybindings),
    command,
    resolvedOptions,
  );
  return fallbackShortcut ? formatShortcutLabel(fallbackShortcut, platform) : null;
}

export function threadJumpCommandForIndex(index: number): ThreadJumpKeybindingCommand | null {
  return THREAD_JUMP_KEYBINDING_COMMANDS[index] ?? null;
}

export function threadJumpIndexFromCommand(command: string): number | null {
  const index = THREAD_JUMP_KEYBINDING_COMMANDS.indexOf(command as ThreadJumpKeybindingCommand);
  return index === -1 ? null : index;
}

export function spaceJumpCommandForIndex(index: number): SpaceJumpKeybindingCommand | null {
  return SPACE_JUMP_KEYBINDING_COMMANDS[index] ?? null;
}

export function spaceJumpIndexFromCommand(command: string): number | null {
  const index = SPACE_JUMP_KEYBINDING_COMMANDS.indexOf(command as SpaceJumpKeybindingCommand);
  return index === -1 ? null : index;
}

export function shouldShowThreadJumpHints(
  event: ShortcutEventLike,
  keybindings: ResolvedKeybindingsConfig,
  options?: ShortcutMatchOptions,
): boolean {
  if (dispatchSuspensions > 0) return false;
  const platform = resolvePlatform(options);
  const fallbackBindings = getFallbackBindings(keybindings);

  for (const command of THREAD_JUMP_KEYBINDING_COMMANDS) {
    const shortcut =
      findEffectiveShortcutForCommand(keybindings, command, options) ??
      findEffectiveShortcutForCommand(fallbackBindings, command, options);
    if (!shortcut) continue;
    if (matchesShortcutModifiers(event, shortcut, platform)) {
      return true;
    }
  }

  return false;
}

export function isOpenFavoriteEditorShortcut(
  event: ShortcutEventLike,
  keybindings: ResolvedKeybindingsConfig,
  options?: ShortcutMatchOptions,
): boolean {
  return matchesCommandShortcut(event, keybindings, "editor.openFavorite", options);
}

export function isEditorFileSaveShortcut(
  event: ShortcutEventLike,
  keybindings: ResolvedKeybindingsConfig,
  options?: ShortcutMatchOptions,
): boolean {
  return matchesCommandShortcut(event, keybindings, "editor.file.save", options);
}

export function isTerminalClearShortcut(event: ShortcutEventLike): boolean {
  if (event.type !== undefined && event.type !== "keydown") {
    return false;
  }

  const key = event.key.toLowerCase();

  return key === "l" && event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;
}

export function isKeyboardShortcutsHelpShortcut(
  event: ShortcutEventLike,
  platform = navigator.platform,
): boolean {
  if (dispatchSuspensions > 0) return false;
  return isKeyboardShortcutsHelpChord(
    {
      key: event.key,
      meta: event.metaKey,
      ctrl: event.ctrlKey,
      shift: event.shiftKey,
      alt: event.altKey,
      ...(event.type !== undefined ? { type: event.type } : {}),
      ...(event.code !== undefined ? { code: event.code } : {}),
      ...(event.repeat !== undefined ? { repeat: event.repeat } : {}),
    },
    {
      isMac: isMacPlatform(platform),
      isWindows: isWindowsPlatform(platform),
    },
  );
}

export function terminalNavigationShortcutData(
  event: ShortcutEventLike,
  platform = navigator.platform,
): string | null {
  if (event.type !== undefined && event.type !== "keydown") {
    return null;
  }

  if (event.shiftKey) return null;

  const key = normalizeEventKey(event.key);
  if (key !== "arrowleft" && key !== "arrowright") {
    return null;
  }

  const moveWord = key === "arrowleft" ? TERMINAL_WORD_BACKWARD : TERMINAL_WORD_FORWARD;
  const moveLine = key === "arrowleft" ? TERMINAL_LINE_START : TERMINAL_LINE_END;

  if (isMacPlatform(platform)) {
    if (event.altKey && !event.metaKey && !event.ctrlKey) {
      return moveWord;
    }
    if (event.metaKey && !event.altKey && !event.ctrlKey) {
      return moveLine;
    }
    return null;
  }

  if (event.ctrlKey && !event.metaKey && !event.altKey) {
    return moveWord;
  }

  if (event.altKey && !event.metaKey && !event.ctrlKey) {
    return moveWord;
  }

  return null;
}
