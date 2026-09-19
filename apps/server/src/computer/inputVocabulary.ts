import type { ComputerInputModifier } from "@synara/contracts";
import {
  COMPUTER_KEY_NAME_ALIASES,
  COMPUTER_MODIFIER_KEY_NAMES,
  COMPUTER_NAMED_KEYS,
  isComputerNamedKey,
} from "@synara/shared/computerKeyNames";

import { ComputerBackendError, type ComputerAgentDialect } from "./ComputerBackend.ts";

/**
 * The one vocabulary every desktop backend validates keyboard and semantic
 * input against, so the fake the core tests run against refuses exactly what
 * a real backend refuses.
 *
 * The named keys and modifiers themselves live in
 * `@synara/shared/computerKeyNames`, where the web pane reads them too; this
 * module is the server-side judgement built on them: what text can be typed
 * through a US-QWERTY evdev table, what a single key name may be, what a chord
 * may contain, and which semantic action names each desktop family performs.
 *
 * @module computer/inputVocabulary
 */

export { COMPUTER_MODIFIER_KEY_NAMES, COMPUTER_NAMED_KEYS };

/**
 * The semantic action names each desktop's accessibility layer performs.
 * Linux maps exactly two onto a synthetic click; macOS forwards the name to
 * `AXUIElementPerformAction`.
 */
export const COMPUTER_SEMANTIC_ACTIONS: Readonly<Record<ComputerAgentDialect, readonly string[]>> =
  {
    linux: ["activate", "click"],
    macos: [
      "activate",
      "click",
      "AXPress",
      "AXShowMenu",
      "AXIncrement",
      "AXDecrement",
      "AXConfirm",
      "AXCancel",
      "AXPick",
      "AXScrollToVisible",
    ],
  };

const MODIFIER_NAMES: ReadonlySet<string> = new Set(COMPUTER_MODIFIER_KEY_NAMES);

/** Modifier spellings the chord grammar folds onto the four modifiers the seat holds. */
const MODIFIER_CANONICAL: Readonly<Record<string, ComputerInputModifier>> = {
  shift: "shift",
  ctrl: "ctrl",
  control: "ctrl",
  alt: "alt",
  option: "alt",
  meta: "meta",
  super: "meta",
  command: "meta",
};

const NEWLINE = String.fromCharCode(0x0a);
const TAB = String.fromCharCode(0x09);

/**
 * Whether one character can be synthesised through the US-QWERTY evdev table:
 * printable ASCII, plus the newline and tab that are keys in their own right.
 */
export function isTypeableCharacter(character: string): boolean {
  if (character === NEWLINE || character === TAB) return true;
  const code = character.codePointAt(0);
  return code !== undefined && code >= 0x20 && code <= 0x7e && character.length === 1;
}

/** Refuses text the keyboard synthesiser cannot type, naming the first character it cannot. */
export function assertTypeableText(text: string): void {
  for (const character of text) {
    if (isTypeableCharacter(character)) continue;
    const codePoint = character.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0");
    throw new ComputerBackendError(
      `Text contains ${JSON.stringify(character)} (U+${codePoint}), which this desktop's keyboard cannot type. ` +
        "Only printable ASCII, newline and tab can be typed; write other text through the clipboard or computer_set_value.",
    );
  }
}

/** Whether a canonical key name is a modifier the chord grammar holds rather than taps. */
export function isModifierKeyName(name: string): boolean {
  return MODIFIER_NAMES.has(name);
}

/**
 * The canonical spelling of one key: a single typeable character as given, a
 * named key or one of its accepted aliases lowercased, or a modifier name.
 * Anything else is refused, because a key the backend cannot map is a key the
 * user pressed and nothing happened to.
 */
export function assertKeyName(key: string): string {
  const trimmed = key.trim();
  if (trimmed.length === 1 && isTypeableCharacter(trimmed)) return trimmed;
  const lowered = trimmed.toLowerCase();
  const canonical = COMPUTER_KEY_NAME_ALIASES[lowered] ?? lowered;
  if (isComputerNamedKey(canonical) || isModifierKeyName(canonical)) return canonical;
  throw new ComputerBackendError(
    `Key ${JSON.stringify(key)} is not one this desktop can press. Use a single printable character, a modifier (${COMPUTER_MODIFIER_KEY_NAMES.join(", ")}), or a named key: ${COMPUTER_NAMED_KEYS.join(", ")}.`,
  );
}

/**
 * A chord as the seat presses it: any modifiers, in the order given, plus
 * exactly one other key. Two non-modifier keys are two shortcuts, not one, and
 * a chord of modifiers alone presses nothing.
 */
export function assertHotkeyChord(keys: readonly string[]): {
  readonly modifiers: readonly ComputerInputModifier[];
  readonly key: string;
} {
  const modifiers: ComputerInputModifier[] = [];
  const others: string[] = [];
  for (const raw of keys) {
    const name = assertKeyName(raw);
    if (isModifierKeyName(name)) {
      const canonical = MODIFIER_CANONICAL[name];
      if (canonical === undefined) {
        throw new ComputerBackendError(
          `Modifier ${JSON.stringify(raw)} cannot be held in a chord on this desktop.`,
        );
      }
      if (!modifiers.includes(canonical)) modifiers.push(canonical);
    } else {
      others.push(name);
    }
  }
  if (others.length !== 1) {
    throw new ComputerBackendError(
      others.length === 0
        ? "A hotkey chord needs one key besides its modifiers; modifiers alone press nothing."
        : `A hotkey chord holds exactly one key besides its modifiers; got ${others.map((key) => JSON.stringify(key)).join(", ")}. Press two shortcuts as two calls.`,
    );
  }
  return { modifiers, key: others[0]! };
}

/** Refuses a semantic action name the desktop's accessibility layer does not perform. */
export function assertSemanticAction(dialect: ComputerAgentDialect, action: string): void {
  if (COMPUTER_SEMANTIC_ACTIONS[dialect].includes(action)) return;
  throw new ComputerBackendError(
    `This desktop does not perform the semantic action ${JSON.stringify(action)}; it accepts ${COMPUTER_SEMANTIC_ACTIONS[dialect].map((name) => JSON.stringify(name)).join(", ")}.`,
  );
}
