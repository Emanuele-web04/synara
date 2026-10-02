// FILE: keybindingEditor.ts
// Purpose: Model behind Settings → Keybindings: the rows it lists, what a recorded
//          shortcut would collide with, and the server edits each action sends.
// Layer: UI helper
// Depends on: the shortcut definitions, the keybinding matcher, and key capture.

import {
  UNASSIGNED_KEYBINDING_KEY,
  type KeybindingCommand,
  type KeybindingRule,
  type KeybindingShortcut,
  type KeybindingWhenNode,
  type ResolvedKeybindingRule,
  type ResolvedKeybindingsConfig,
  type ServerKeybindingEdit,
} from "@synara/contracts";

import {
  evaluateWhenNode,
  formatKeybindingWhenExpression,
  formatShortcutLabel,
  isUnassignedKeybinding,
  shortcutConflictKey,
} from "./keybindings";
import { keybindingValueFromShortcut } from "./lib/keybindingCapture";
import { isMacPlatform } from "./lib/utils";
import {
  listShortcutEditorDefinitions,
  shortcutSheetCommandLabel,
  type ShortcutEditorDefinition,
} from "./shortcutsSheet";

export interface ShortcutEditorSource {
  keybindings: ResolvedKeybindingsConfig;
  /** Shipped bindings; absent when the server predates the editor. */
  defaultKeybindings: ResolvedKeybindingsConfig | undefined;
  platform: string;
}

export interface ShortcutEditorBinding {
  id: string;
  /** Rendered shortcut, e.g. "⌘N", or "⌘1–9" for a numbered family. */
  label: string;
  /** One rule, or one per member of a numbered family in key order. */
  rules: readonly ResolvedKeybindingRule[];
}

export interface ShortcutEditorRow {
  id: string;
  label: string;
  description: string;
  commands: readonly KeybindingCommand[];
  /** A numbered family is rebound as one modifier combination across the keys 1–9. */
  numbered: boolean;
  bindings: readonly ShortcutEditorBinding[];
  /** False once any of the row's commands differs from what ships. */
  isDefault: boolean;
}

export interface ShortcutEditorConflict {
  rule: ResolvedKeybindingRule;
  /** Name of the command that holds the shortcut. */
  label: string;
}

export type ShortcutRecording =
  | { status: "idle" }
  | { status: "problem"; message: string }
  | {
      status: "ready";
      candidates: readonly ResolvedKeybindingRule[];
      /** Bindings of other commands the save takes the shortcut from. */
      conflicts: readonly ShortcutEditorConflict[];
    };

const NUMBER_KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"] as const;
// Checking two conditions together tries every combination of the names they mention;
// past this many names it is cheaper to assume they can overlap.
const MAX_WHEN_NAMES = 12;

function platformFacts(platform: string): Record<string, boolean> {
  return { isMac: isMacPlatform(platform) };
}

function collectWhenNames(node: KeybindingWhenNode, names: Set<string>): void {
  switch (node.type) {
    case "identifier":
      if (node.name !== "true" && node.name !== "false") names.add(node.name);
      return;
    case "not":
      collectWhenNames(node.node, names);
      return;
    case "and":
    case "or":
      collectWhenNames(node.left, names);
      collectWhenNames(node.right, names);
      return;
  }
}

/**
 * Whether some app state makes every condition true at once, given `facts` that never
 * change at runtime (the platform). Two bindings on the same key only collide when
 * their conditions can hold together: Mod+D splits a focused terminal and toggles the
 * diff panel otherwise, and those never meet.
 */
export function whenConditionsCanHoldTogether(
  conditions: ReadonlyArray<KeybindingWhenNode | undefined>,
  facts: Readonly<Record<string, boolean>>,
): boolean {
  const nodes = conditions.filter((node): node is KeybindingWhenNode => node !== undefined);
  const names = new Set<string>();
  for (const node of nodes) collectWhenNames(node, names);
  const free = [...names].filter((name) => !(name in facts));
  if (free.length > MAX_WHEN_NAMES) return true;

  for (let mask = 0; mask < 2 ** free.length; mask += 1) {
    const context: Record<string, boolean> = { ...facts };
    free.forEach((name, index) => {
      context[name] = (mask & (1 << index)) !== 0;
    });
    if (nodes.every((node) => evaluateWhenNode(node, context))) return true;
  }
  return false;
}

function ruleIdentity(rule: ResolvedKeybindingRule): string {
  const { shortcut } = rule;
  return [
    rule.command,
    shortcut.key,
    shortcut.modKey,
    shortcut.metaKey,
    shortcut.ctrlKey,
    shortcut.altKey,
    shortcut.shiftKey,
    formatKeybindingWhenExpression(rule.whenAst),
  ].join("\u0000");
}

function isShippedRule(source: ShortcutEditorSource, rule: ResolvedKeybindingRule): boolean {
  const identity = ruleIdentity(rule);
  return (source.defaultKeybindings ?? []).some((shipped) => ruleIdentity(shipped) === identity);
}

function appliesOnPlatform(source: ShortcutEditorSource, rule: ResolvedKeybindingRule): boolean {
  return whenConditionsCanHoldTogether([rule.whenAst], platformFacts(source.platform));
}

/** Bindings of `command` that can fire on this platform, in precedence order. */
function visibleRules(
  source: ShortcutEditorSource,
  command: KeybindingCommand,
): ResolvedKeybindingRule[] {
  return source.keybindings.filter(
    (rule) =>
      rule.command === command && !isUnassignedKeybinding(rule) && appliesOnPlatform(source, rule),
  );
}

function commandsAreDefault(
  source: ShortcutEditorSource,
  commands: readonly KeybindingCommand[],
): boolean {
  if (!source.defaultKeybindings) return true;
  const inRow = (rule: ResolvedKeybindingRule) => commands.includes(rule.command);
  const current = source.keybindings.filter(inRow).map(ruleIdentity).toSorted();
  const shipped = source.defaultKeybindings.filter(inRow).map(ruleIdentity).toSorted();
  return current.length === shipped.length && current.every((id, index) => id === shipped[index]);
}

function sameModifiers(left: KeybindingShortcut, right: KeybindingShortcut): boolean {
  return (
    left.modKey === right.modKey &&
    left.metaKey === right.metaKey &&
    left.ctrlKey === right.ctrlKey &&
    left.altKey === right.altKey &&
    left.shiftKey === right.shiftKey
  );
}

function singleBinding(source: ShortcutEditorSource, rule: ResolvedKeybindingRule) {
  return {
    id: ruleIdentity(rule),
    label: formatShortcutLabel(rule.shortcut, source.platform),
    rules: [rule],
  } satisfies ShortcutEditorBinding;
}

/**
 * The family's bindings when it still reads as "these modifiers plus 1–9": every
 * member has the same number of bindings, and the n-th binding of each shares its
 * modifiers and condition and sits on the member's own number key. Null once a member
 * was rebound on its own, which the editor then shows member by member.
 */
function numberedFamilyBindings(
  source: ShortcutEditorSource,
  commands: readonly KeybindingCommand[],
): ShortcutEditorBinding[] | null {
  const rulesByMember = commands.map((command) => visibleRules(source, command));
  const first = rulesByMember[0] ?? [];
  if (rulesByMember.some((rules) => rules.length !== first.length)) return null;

  const bindings: ShortcutEditorBinding[] = [];
  for (const [slot, lead] of first.entries()) {
    const rules = rulesByMember.map((memberRules) => memberRules[slot]);
    const uniform = rules.every(
      (rule, index) =>
        rule !== undefined &&
        rule.shortcut.key === NUMBER_KEYS[index] &&
        sameModifiers(rule.shortcut, lead.shortcut) &&
        formatKeybindingWhenExpression(rule.whenAst) ===
          formatKeybindingWhenExpression(lead.whenAst),
    );
    if (!uniform) return null;
    bindings.push({
      id: `${commands[0]}:${slot}`,
      label: `${formatShortcutLabel(lead.shortcut, source.platform)}–9`,
      rules: rules as ResolvedKeybindingRule[],
    });
  }
  return bindings;
}

function singleRow(
  source: ShortcutEditorSource,
  definition: ShortcutEditorDefinition,
): ShortcutEditorRow {
  return {
    id: definition.id,
    label: definition.label,
    description: definition.description,
    commands: definition.commands,
    numbered: false,
    bindings: definition.commands.flatMap((command) =>
      visibleRules(source, command).map((rule) => singleBinding(source, rule)),
    ),
    isDefault: commandsAreDefault(source, definition.commands),
  };
}

export function buildShortcutEditorRows(source: ShortcutEditorSource): ShortcutEditorRow[] {
  return listShortcutEditorDefinitions().flatMap((definition) => {
    if (!definition.members) return [singleRow(source, definition)];
    const bindings = numberedFamilyBindings(source, definition.commands);
    if (!bindings) return definition.members.map((member) => singleRow(source, member));
    return [
      {
        id: definition.id,
        label: definition.label,
        description: definition.description,
        commands: definition.commands,
        numbered: true,
        bindings,
        isDefault: commandsAreDefault(source, definition.commands),
      },
    ];
  });
}

/** Rows whose name, description, or shortcut contains the query. */
export function filterShortcutEditorRows(
  rows: readonly ShortcutEditorRow[],
  query: string,
): ShortcutEditorRow[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return [...rows];
  return rows.filter(
    (row) =>
      row.label.toLowerCase().includes(needle) ||
      row.description.toLowerCase().includes(needle) ||
      row.bindings.some((binding) => binding.label.toLowerCase().includes(needle)),
  );
}

// A new binding takes the condition its command ships with, so "New thread" keeps
// yielding to a focused terminal on Linux whichever key it moves to.
function defaultWhenFor(
  source: ShortcutEditorSource,
  command: KeybindingCommand,
): KeybindingWhenNode | undefined {
  const shipped = (source.defaultKeybindings ?? []).find(
    (rule) => rule.command === command && appliesOnPlatform(source, rule),
  );
  return (shipped ?? visibleRules(source, command)[0])?.whenAst;
}

function resolvedRule(
  command: KeybindingCommand,
  shortcut: KeybindingShortcut,
  whenAst: KeybindingWhenNode | undefined,
): ResolvedKeybindingRule {
  return { command, shortcut, ...(whenAst ? { whenAst } : {}) };
}

/** The rules saving `shortcut` would write: one, or one per number key of a family. */
function candidateRules(
  source: ShortcutEditorSource,
  row: ShortcutEditorRow,
  replacing: ShortcutEditorBinding | null,
  shortcut: KeybindingShortcut,
): ResolvedKeybindingRule[] {
  if (!row.numbered) {
    const replaced = replacing?.rules[0];
    const command = replaced?.command ?? row.commands[0];
    if (!command) return [];
    return [
      resolvedRule(
        command,
        shortcut,
        replaced ? replaced.whenAst : defaultWhenFor(source, command),
      ),
    ];
  }
  return row.commands.map((command, index) => {
    const replaced = replacing?.rules[index];
    return resolvedRule(
      command,
      { ...shortcut, key: NUMBER_KEYS[index] ?? shortcut.key },
      replaced ? replaced.whenAst : defaultWhenFor(source, command),
    );
  });
}

function commandLabel(command: KeybindingCommand): string {
  return shortcutSheetCommandLabel(command) ?? command;
}

function isProjectScriptCommand(command: KeybindingCommand): boolean {
  return command.startsWith("script.");
}

/** Bindings that would fire on the same key press as one of `candidates`. */
function collidingRules(
  source: ShortcutEditorSource,
  candidates: readonly ResolvedKeybindingRule[],
  ignored: readonly ResolvedKeybindingRule[],
): ResolvedKeybindingRule[] {
  const facts = platformFacts(source.platform);
  return source.keybindings.filter(
    (existing) =>
      !isUnassignedKeybinding(existing) &&
      !ignored.includes(existing) &&
      candidates.some(
        (candidate) =>
          shortcutConflictKey(candidate.shortcut, source.platform) ===
            shortcutConflictKey(existing.shortcut, source.platform) &&
          whenConditionsCanHoldTogether([candidate.whenAst, existing.whenAst], facts) &&
          // A few shipped bindings share a key on purpose and settle it by rule order
          // (Mod+W closes a terminal tab or the workspace panel). Putting one back is
          // not a collision.
          !(
            candidate.command !== existing.command &&
            isShippedRule(source, candidate) &&
            isShippedRule(source, existing)
          ),
      ),
  );
}

interface ReservedShortcut {
  key: string;
  shiftKey?: boolean;
  macOnly?: boolean;
  reason: string;
}

// Chords the app cannot hand to a command: binding them would take text editing away
// from every input, or the system or Synara's own fixed shortcuts get the key first.
const RESERVED_PRIMARY_SHORTCUTS: readonly ReservedShortcut[] = [
  { key: "c", reason: "is reserved for Copy" },
  { key: "v", reason: "is reserved for Paste" },
  { key: "x", reason: "is reserved for Cut" },
  { key: "a", reason: "is reserved for Select All" },
  { key: "z", reason: "is reserved for Undo" },
  { key: "z", shiftKey: true, reason: "is reserved for Redo" },
  { key: ",", reason: "always opens Settings" },
  { key: "/", reason: "always opens the keybindings sheet" },
  { key: "q", macOnly: true, reason: "is reserved by macOS for Quit" },
  { key: "h", macOnly: true, reason: "is reserved by macOS for Hide" },
  { key: "m", macOnly: true, reason: "is reserved by macOS for Minimize" },
];

function reservedReason(shortcut: KeybindingShortcut, platform: string): string | null {
  const isMac = isMacPlatform(platform);
  const primaryOnly = shortcut.modKey && !shortcut.altKey && !shortcut.metaKey && !shortcut.ctrlKey;
  if (!primaryOnly) return null;
  const reserved = RESERVED_PRIMARY_SHORTCUTS.find(
    (entry) =>
      entry.key === shortcut.key &&
      (entry.shiftKey ?? false) === shortcut.shiftKey &&
      (!entry.macOnly || isMac),
  );
  return reserved?.reason ?? null;
}

function isFunctionKey(key: string): boolean {
  return /^f(?:[1-9]|1\d|2[0-4])$/.test(key);
}

export function shortcutModifierHint(platform: string): string {
  return isMacPlatform(platform)
    ? "Use ⌘, ⌥ or ⌃ with any key, or an F-key on its own."
    : "Use Ctrl or Alt with any key, or an F-key on its own.";
}

/**
 * What saving `shortcut` for `row` would do. `replacing` is the binding being edited,
 * or null when the row gains a new one.
 */
export function evaluateRecordedShortcut(input: {
  source: ShortcutEditorSource;
  row: ShortcutEditorRow;
  replacing: ShortcutEditorBinding | null;
  shortcut: KeybindingShortcut | null;
}): ShortcutRecording {
  const { source, row, replacing, shortcut } = input;
  if (!shortcut) return { status: "idle" };

  const candidates = candidateRules(source, row, replacing, shortcut);
  const replaced = replacing?.rules ?? [];
  const unchanged =
    replaced.length === candidates.length &&
    candidates.every(
      (candidate, index) =>
        shortcutConflictKey(candidate.shortcut, source.platform) ===
        shortcutConflictKey(replaced[index]!.shortcut, source.platform),
    );
  if (unchanged) return { status: "idle" };

  const label = formatShortcutLabel(shortcut, source.platform);
  const hasCommandModifier =
    shortcut.modKey || shortcut.metaKey || shortcut.ctrlKey || shortcut.altKey;
  if (row.numbered && !NUMBER_KEYS.some((key) => key === shortcut.key)) {
    return { status: "problem", message: "Hold the modifiers and press a number key." };
  }
  if (!hasCommandModifier && !isFunctionKey(shortcut.key)) {
    return {
      status: "problem",
      message: isMacPlatform(source.platform)
        ? "Add ⌘, ⌥ or ⌃ to that key, or use an F-key on its own."
        : "Add Ctrl or Alt to that key, or use an F-key on its own.",
    };
  }
  const reserved = reservedReason(shortcut, source.platform);
  if (reserved) return { status: "problem", message: `${label} ${reserved}. Try another.` };

  const colliding = collidingRules(source, candidates, replaced);
  if (colliding.some((rule) => row.commands.includes(rule.command))) {
    return { status: "problem", message: `${label} is already a shortcut for this command.` };
  }
  const script = colliding.find((rule) => isProjectScriptCommand(rule.command));
  if (script) {
    return {
      status: "problem",
      message: `${label} already runs a project script. Change it from the project's scripts first.`,
    };
  }
  return {
    status: "ready",
    candidates,
    conflicts: colliding.map((rule) => ({ rule, label: commandLabel(rule.command) })),
  };
}

const WHEN_PRECEDENCE = { or: 1, and: 2, not: 3, identifier: 4 } as const;

// Writes a condition the way a person would type it into keybindings.json. Parentheses
// stay wherever dropping them would regroup the expression, so the text parses back to
// this exact tree and still identifies the rule it came from.
function whenExpression(node: KeybindingWhenNode): string {
  const operand = (child: KeybindingWhenNode, needsParens: boolean) =>
    needsParens ? `(${whenExpression(child)})` : whenExpression(child);
  const precedence = WHEN_PRECEDENCE[node.type];
  switch (node.type) {
    case "identifier":
      return node.name;
    case "not":
      return `!${operand(node.node, WHEN_PRECEDENCE[node.node.type] < precedence)}`;
    case "and":
    case "or":
      return [
        operand(node.left, WHEN_PRECEDENCE[node.left.type] < precedence),
        node.type === "and" ? "&&" : "||",
        operand(node.right, WHEN_PRECEDENCE[node.right.type] <= precedence),
      ].join(" ");
  }
}

function keybindingRule(rule: ResolvedKeybindingRule): KeybindingRule {
  const when = rule.whenAst ? whenExpression(rule.whenAst) : "";
  return {
    command: rule.command,
    key:
      rule.shortcut.key === UNASSIGNED_KEYBINDING_KEY
        ? UNASSIGNED_KEYBINDING_KEY
        : keybindingValueFromShortcut(rule.shortcut),
    ...(when ? { when } : {}),
  };
}

/** Takes the shortcut from whoever holds it, then gives it to the row. */
export function shortcutSaveEdits(
  recording: Extract<ShortcutRecording, { status: "ready" }>,
  replacing: ShortcutEditorBinding | null,
): ServerKeybindingEdit[] {
  return [
    ...recording.conflicts.map(
      (conflict): ServerKeybindingEdit => ({ type: "remove", rule: keybindingRule(conflict.rule) }),
    ),
    ...recording.candidates.map((candidate, index): ServerKeybindingEdit => {
      const replaced = replacing?.rules[index];
      return {
        type: "set",
        rule: keybindingRule(candidate),
        ...(replaced ? { replacing: keybindingRule(replaced) } : {}),
      };
    }),
  ];
}

export function shortcutRemoveEdits(binding: ShortcutEditorBinding): ServerKeybindingEdit[] {
  return binding.rules.map((rule) => ({ type: "remove", rule: keybindingRule(rule) }));
}

/**
 * Restores the row's shipped bindings, first taking their keys back from any other
 * command that picked them up in the meantime. Project script shortcuts are left
 * alone: they are edited with their project, and they keep winning the key.
 */
export function shortcutResetEdits(
  source: ShortcutEditorSource,
  row: ShortcutEditorRow,
): ServerKeybindingEdit[] {
  const shipped = (source.defaultKeybindings ?? []).filter(
    (rule) => row.commands.includes(rule.command) && appliesOnPlatform(source, rule),
  );
  const ownRules = source.keybindings.filter((rule) => row.commands.includes(rule.command));
  const takenBack = collidingRules(source, shipped, ownRules).filter(
    (rule) => !isProjectScriptCommand(rule.command),
  );
  return [
    ...takenBack.map(
      (rule): ServerKeybindingEdit => ({ type: "remove", rule: keybindingRule(rule) }),
    ),
    ...row.commands.map((command): ServerKeybindingEdit => ({ type: "reset", command })),
  ];
}
