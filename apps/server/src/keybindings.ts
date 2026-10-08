/**
 * Keybindings - Keybinding configuration service definitions.
 *
 * Owns parsing, validation, merge, and persistence of user keybinding
 * configuration consumed by the server runtime.
 *
 * @module Keybindings
 */
import {
  KeybindingRule,
  KeybindingsConfig,
  MAX_KEYBINDINGS_COUNT,
  ResolvedKeybindingRule,
  ResolvedKeybindingsConfig,
  STATIC_KEYBINDING_COMMANDS,
  UNASSIGNED_KEYBINDING_KEY,
  type ServerConfigIssue,
  type ServerKeybindingEdit,
} from "@synara/contracts";
import { Mutable } from "effect/Types";
import {
  Array,
  Cache,
  Cause,
  Deferred,
  Effect,
  Exit,
  FileSystem,
  Path,
  Layer,
  Option,
  Predicate,
  PubSub,
  Schema,
  SchemaIssue,
  SchemaTransformation,
  Ref,
  ServiceMap,
  Scope,
  Stream,
} from "effect";
import * as Semaphore from "effect/Semaphore";
import {
  compileKeybindingRule,
  encodeKeybindingShortcut,
  encodeKeybindingWhen,
  isUnassignedKeybindingRule,
  keybindingRuleIdentity,
  parseKeybindingShortcut,
} from "@synara/shared/keybindingRules";
import { writeFileStringAtomically } from "./atomicWrite";
import { ServerConfig } from "./config";

/** @internal - Exported for testing */
export { parseKeybindingShortcut };

export class KeybindingsConfigError extends Schema.TaggedErrorClass<KeybindingsConfigError>()(
  "KeybindingsConfigParseError",
  {
    configPath: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Unable to parse keybindings config at ${this.configPath}: ${this.detail}`;
  }
}

/** Shown when an edit names a rule that is no longer in the config it was made against. */
export const KEYBINDING_EDIT_STALE_DETAIL =
  "Shortcuts changed while you were editing. Review them and try again.";
export const KEYBINDING_LIMIT_DETAIL = `You have reached the limit of ${MAX_KEYBINDINGS_COUNT} shortcuts. Remove some before adding more.`;
export const KEYBINDING_INVALID_RULE_DETAIL = "invalid shortcut or condition expression";

/**
 * A shortcut change the server refused; nothing was written. Its message is the plain
 * detail, so clients can show it as is.
 */
export class KeybindingsEditRejectedError extends Schema.TaggedErrorClass<KeybindingsEditRejectedError>()(
  "KeybindingsEditRejectedError",
  {
    reason: Schema.Literals(["invalid", "stale", "limit"]),
    detail: Schema.String,
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export type KeybindingsWriteError = KeybindingsConfigError | KeybindingsEditRejectedError;

// Loading tolerates a file that is already over the cap; a write may only shrink it there.
function exceedsKeybindingLimit(previousCount: number, nextCount: number): boolean {
  return nextCount > MAX_KEYBINDINGS_COUNT && nextCount > previousCount;
}

const SIDEBAR_SEARCH_DEFAULT_KEYBINDINGS = [
  // Cmd-only on macOS so Ctrl+K stays available for kill-to-end-of-line.
  // Keep Ctrl+K on Windows/Linux (where `mod` would otherwise be Ctrl).
  { key: "cmd+k", command: "sidebar.search" },
  { key: "ctrl+k", command: "sidebar.search", when: "!isMac" },
] as const satisfies ReadonlyArray<KeybindingRule>;

export const DEFAULT_KEYBINDINGS: ReadonlyArray<KeybindingRule> = [
  { key: "mod+b", command: "sidebar.toggle", when: "!terminalFocus" },
  ...SIDEBAR_SEARCH_DEFAULT_KEYBINDINGS,
  { key: "mod+alt+u", command: "sidebar.activity", when: "!terminalFocus || isMac" },
  { key: "mod+shift+o", command: "sidebar.addProject", when: "!terminalFocus" },
  { key: "mod+i", command: "sidebar.importThread", when: "!terminalFocus" },
  { key: "mod+alt+arrowleft", command: "space.previous", when: "!terminalFocus" },
  { key: "mod+alt+arrowright", command: "space.next", when: "!terminalFocus" },
  // Numbered space jumps address tabs in the switcher's visual order, so mod+alt+1 is
  // always Void. Same `|| isMac` escape hatch as the new-surface chords below: Cmd
  // chords never reach the PTY on macOS, while Ctrl+Alt+digit is AltGr territory on
  // Linux/Windows layouts and must keep yielding to focused terminals there.
  { key: "mod+alt+1", command: "space.jump.1", when: "!terminalFocus || isMac" },
  { key: "mod+alt+2", command: "space.jump.2", when: "!terminalFocus || isMac" },
  { key: "mod+alt+3", command: "space.jump.3", when: "!terminalFocus || isMac" },
  { key: "mod+alt+4", command: "space.jump.4", when: "!terminalFocus || isMac" },
  { key: "mod+alt+5", command: "space.jump.5", when: "!terminalFocus || isMac" },
  { key: "mod+alt+6", command: "space.jump.6", when: "!terminalFocus || isMac" },
  { key: "mod+alt+7", command: "space.jump.7", when: "!terminalFocus || isMac" },
  { key: "mod+alt+8", command: "space.jump.8", when: "!terminalFocus || isMac" },
  { key: "mod+alt+9", command: "space.jump.9", when: "!terminalFocus || isMac" },
  { key: "mod+j", command: "terminal.toggle" },
  // Reserve Cmd/Ctrl+T for the terminal workspace's "new tab" action while focused.
  { key: "mod+t", command: "terminal.new", when: "terminalFocus" },
  { key: "mod+w", command: "terminal.close", when: "terminalFocus" },
  { key: "mod+shift+j", command: "terminal.workspace.newFullWidth" },
  { key: "mod+w", command: "terminal.workspace.closeActive", when: "terminalWorkspaceOpen" },
  // Keep workspace tabs on literal Ctrl so Cmd+1…9 remains consistent app navigation
  // on macOS even when a thread was opened directly as a full-width terminal.
  { key: "ctrl+1", command: "terminal.workspace.terminal", when: "terminalWorkspaceOpen" },
  { key: "ctrl+2", command: "terminal.workspace.chat", when: "terminalWorkspaceOpen" },
  { key: "mod+shift+b", command: "browser.toggle", when: "!terminalFocus" },
  { key: "mod+alt+s", command: "sidechat.toggle", when: "!terminalFocus || isMac" },
  { key: "mod+d", command: "diff.toggle", when: "!terminalFocus" },
  { key: "alt+arrowdown", command: "diff.change.next", when: "!terminalFocus" },
  { key: "alt+arrowup", command: "diff.change.previous", when: "!terminalFocus" },
  // Cmd-only instead of mod so Ctrl+L remains available to shells on non-macOS.
  { key: "cmd+l", command: "composer.focus.toggle", when: "!terminalFocus" },
  { key: "mod+f", command: "chat.find", when: "!terminalFocus && !filePreviewFocus" },
  { key: "mod+f", command: "file.find", when: "filePreviewFocus" },
  { key: "mod+shift+m", command: "modelPicker.toggle", when: "!terminalFocus" },
  // Cycle models within the active provider (favorites first, then remaining list).
  { key: "alt+]", command: "model.next", when: "!terminalFocus" },
  { key: "alt+[", command: "model.previous", when: "!terminalFocus" },
  // Preserve reverse focus navigation outside the composer and its effort picker.
  { key: "shift+tab", command: "model.effort.next", when: "composerFocus" },
  { key: "mod+shift+e", command: "traitsPicker.toggle", when: "!terminalFocus" },
  { key: "mod+shift+u", command: "settings.usage", when: "!terminalFocus" },
  // New thread (chat.new) is the primary create action; it falls back to the most
  // recent project when no project is active.
  //
  // These new-surface chords use `!terminalFocus || isMac`: on macOS `mod` is Cmd and
  // xterm never forwards a Cmd-chord to the PTY, so the bare `!terminalFocus` guard just
  // dropped the chord while the terminal had focus (you couldn't open a new chat/terminal
  // from the terminal). The `|| isMac` escape hatch fires them on macOS regardless of
  // focus, while Linux/Windows keep `!terminalFocus` so Ctrl-chords still reach the shell.
  { key: "mod+n", command: "chat.new", when: "!terminalFocus || isMac" },
  { key: "mod+shift+n", command: "chat.newLatestProject", when: "!terminalFocus || isMac" },
  { key: "mod+alt+n", command: "chat.newChat", when: "!terminalFocus || isMac" },
  { key: "mod+shift+t", command: "chat.newTerminal", when: "!terminalFocus || isMac" },
  { key: "mod+alt+c", command: "chat.newClaude", when: "!terminalFocus || isMac" },
  { key: "mod+alt+x", command: "chat.newCodex", when: "!terminalFocus || isMac" },
  { key: "mod+alt+r", command: "chat.newCursor", when: "!terminalFocus || isMac" },
  { key: "mod+\\", command: "chat.split", when: "!terminalFocus || isMac" },
  // Recent-view switcher (Ctrl+Tab) is an installed-app feature only: Electron and
  // standalone PWA windows have no tab strip, so the chord reaches the page. It remains
  // app-level even with terminal focus; the web route captures it before xterm input.
  { key: "ctrl+tab", command: "view.recent.next" },
  { key: "ctrl+shift+tab", command: "view.recent.previous" },
  {
    key: "mod+1",
    command: "thread.jump.1",
    when: "(!terminalFocus && !terminalWorkspaceOpen) || isMac",
  },
  {
    key: "mod+2",
    command: "thread.jump.2",
    when: "(!terminalFocus && !terminalWorkspaceOpen) || isMac",
  },
  {
    key: "mod+3",
    command: "thread.jump.3",
    when: "(!terminalFocus && !terminalWorkspaceOpen) || isMac",
  },
  {
    key: "mod+4",
    command: "thread.jump.4",
    when: "(!terminalFocus && !terminalWorkspaceOpen) || isMac",
  },
  {
    key: "mod+5",
    command: "thread.jump.5",
    when: "(!terminalFocus && !terminalWorkspaceOpen) || isMac",
  },
  {
    key: "mod+6",
    command: "thread.jump.6",
    when: "(!terminalFocus && !terminalWorkspaceOpen) || isMac",
  },
  {
    key: "mod+7",
    command: "thread.jump.7",
    when: "(!terminalFocus && !terminalWorkspaceOpen) || isMac",
  },
  {
    key: "mod+8",
    command: "thread.jump.8",
    when: "(!terminalFocus && !terminalWorkspaceOpen) || isMac",
  },
  {
    key: "mod+9",
    command: "thread.jump.9",
    when: "(!terminalFocus && !terminalWorkspaceOpen) || isMac",
  },
  // Copying the active thread id is not terminal input on macOS, but Ctrl+Shift+C is the
  // terminal copy chord on Linux/Windows, so it keeps the same `|| isMac` escape hatch.
  { key: "mod+shift+c", command: "thread.copyId", when: "!terminalFocus || isMac" },
  // Keep these distinct from browser Save As / View Source and side-chat / Activity.
  { key: "mod+alt+shift+a", command: "thread.archive", when: "!terminalFocus || isMac" },
  { key: "mod+alt+shift+s", command: "thread.snooze", when: "!terminalFocus || isMac" },
  { key: "mod+alt+shift+u", command: "thread.markUnread", when: "!terminalFocus || isMac" },
  { key: "mod+shift+]", command: "chat.visible.next", when: "!terminalFocus" },
  { key: "mod+shift+[", command: "chat.visible.previous", when: "!terminalFocus" },
  // Open thread tabs, browser-style: Cmd+Ctrl+Left/Right on macOS (Cmd+Shift+Left/Right
  // selects to the line edge in the composer, Cmd+Option+Arrow switches spaces, and
  // xterm never sees a Cmd-chord), and
  // Ctrl+PageUp/PageDown elsewhere, where Ctrl+Alt+Left/Right switches desktop workspaces.
  { key: "mod+ctrl+arrowright", command: "threadTab.next", when: "isMac" },
  { key: "mod+ctrl+arrowleft", command: "threadTab.previous", when: "isMac" },
  { key: "ctrl+pagedown", command: "threadTab.next", when: "!terminalFocus && !isMac" },
  { key: "ctrl+pageup", command: "threadTab.previous", when: "!terminalFocus && !isMac" },
  { key: "meta+ctrl+p", command: "git.commitAndPush", when: "!terminalFocus && isMac" },
  { key: "ctrl+alt+p", command: "git.commitAndPush", when: "!terminalFocus && !isMac" },
  { key: "mod+o", command: "editor.openFavorite" },
  { key: "mod+s", command: "editor.file.save", when: "!terminalFocus" },
];

/** @internal - Exported for testing */
export function compileResolvedKeybindingRule(rule: KeybindingRule): ResolvedKeybindingRule | null {
  return compileKeybindingRule(rule);
}

export function compileResolvedKeybindingsConfig(
  config: KeybindingsConfig,
): ResolvedKeybindingsConfig {
  const compiled: Mutable<ResolvedKeybindingsConfig> = [];
  for (const rule of config) {
    const result = Schema.decodeExit(ResolvedKeybindingFromConfig)(rule);
    if (result._tag === "Success") {
      compiled.push(result.value);
    }
  }
  return compiled;
}

export const ResolvedKeybindingFromConfig = KeybindingRule.pipe(
  Schema.decodeTo(
    Schema.toType(ResolvedKeybindingRule),
    SchemaTransformation.transformOrFail({
      decode: (rule) =>
        Effect.succeed(compileResolvedKeybindingRule(rule)).pipe(
          Effect.filterOrFail(
            Predicate.isNotNull,
            () =>
              new SchemaIssue.InvalidValue(Option.some(rule), {
                title: "Invalid keybinding rule",
              }),
          ),
          Effect.map((resolved) => resolved),
        ),

      encode: (resolved) =>
        Effect.gen(function* () {
          const key = encodeKeybindingShortcut(resolved.shortcut);
          if (!key) {
            return yield* Effect.fail(
              new SchemaIssue.InvalidValue(Option.some(resolved), {
                title: "Resolved shortcut cannot be encoded to key string",
              }),
            );
          }

          const when = resolved.whenAst ? encodeKeybindingWhen(resolved.whenAst) : undefined;
          return {
            key,
            command: resolved.command,
            when,
          };
        }),
    }),
  ),
);

function isSameKeybindingRule(left: KeybindingRule, right: KeybindingRule): boolean {
  return (
    left.command === right.command &&
    left.key === right.key &&
    (left.when ?? undefined) === (right.when ?? undefined)
  );
}

function isSameResolvedKeybindingRule(left: KeybindingRule, right: KeybindingRule): boolean {
  const leftIdentity = keybindingRuleIdentity(left);
  return leftIdentity !== null && leftIdentity === keybindingRuleIdentity(right);
}

function keybindingShortcutContext(rule: KeybindingRule): string | null {
  const parsed = parseKeybindingShortcut(rule.key);
  if (!parsed) return null;
  const encoded = encodeKeybindingShortcut(parsed);
  if (!encoded) return null;
  return `${encoded}\u0000${rule.when ?? ""}`;
}

function hasSameShortcutContext(left: KeybindingRule, right: KeybindingRule): boolean {
  const leftContext = keybindingShortcutContext(left);
  const rightContext = keybindingShortcutContext(right);
  if (!leftContext || !rightContext) return false;
  return leftContext === rightContext;
}

export const DEFAULT_RESOLVED_KEYBINDINGS = compileResolvedKeybindingsConfig(DEFAULT_KEYBINDINGS);

const BUILT_IN_KEYBINDING_COMMANDS: ReadonlySet<string> = new Set(STATIC_KEYBINDING_COMMANDS);
const DEFAULT_KEYBINDING_COMMANDS: ReadonlySet<string> = new Set(
  DEFAULT_KEYBINDINGS.map((rule) => rule.command),
);

const SHIPPED_KEYBINDING_RULE_INDEX_BY_IDENTITY = new Map(
  DEFAULT_KEYBINDINGS.flatMap((rule, index) => {
    const identity = keybindingRuleIdentity(rule);
    return identity === null ? [] : [[identity, index] as const];
  }),
);

function shippedKeybindingRuleIndex(rule: KeybindingRule): number {
  const identity = keybindingRuleIdentity(rule);
  return identity === null ? -1 : (SHIPPED_KEYBINDING_RULE_INDEX_BY_IDENTITY.get(identity) ?? -1);
}

// Later rules win, and a few shipped bindings share a key on purpose (Cmd+W closes a
// terminal tab or the workspace panel depending on which rule comes last). A rule that
// matches a shipped one therefore goes back before the shipped rules that follow it, so
// restoring a command never reorders those pairs. Anything else is appended and wins.
function insertKeybindingRule(
  rules: readonly KeybindingRule[],
  rule: KeybindingRule,
): KeybindingRule[] {
  const shippedIndex = shippedKeybindingRuleIndex(rule);
  const insertAt =
    shippedIndex === -1
      ? -1
      : rules.findIndex((existing) => shippedKeybindingRuleIndex(existing) > shippedIndex);
  const next = [...rules];
  next.splice(insertAt === -1 ? next.length : insertAt, 0, rule);
  return next;
}

function insertShippedKeybindingRules(
  rules: readonly KeybindingRule[],
  command: KeybindingRule["command"],
): KeybindingRule[] {
  return DEFAULT_KEYBINDINGS.filter((rule) => rule.command === command).reduce(
    (next, rule) => insertKeybindingRule(next, { ...rule }),
    [...rules],
  );
}

// Startup skips writing a shipped rule whose key another command already holds, so a
// command can be live with nothing on disk. Write its shipped rules out before editing
// one of them; otherwise the edit would silently drop the command's other bindings.
function materializeShippedKeybindingRules(
  rules: readonly KeybindingRule[],
  command: KeybindingRule["command"],
): KeybindingRule[] {
  return rules.some((rule) => rule.command === command)
    ? [...rules]
    : insertShippedKeybindingRules(rules, command);
}

export type KeybindingEditsResult =
  | { readonly _tag: "success"; readonly rules: readonly KeybindingRule[] }
  | {
      readonly _tag: "failure";
      readonly reason: KeybindingsEditRejectedError["reason"];
      readonly detail: string;
    };

function isValidAssignableKeybindingRule(rule: KeybindingRule): boolean {
  return !isUnassignedKeybindingRule(rule) && compileResolvedKeybindingRule(rule) !== null;
}

function hasResolvedKeybindingRule(
  rules: readonly KeybindingRule[],
  rule: KeybindingRule,
): boolean {
  return rules.some((existing) => isSameResolvedKeybindingRule(existing, rule));
}

const STALE_KEYBINDING_EDIT = {
  _tag: "failure",
  reason: "stale",
  detail: KEYBINDING_EDIT_STALE_DETAIL,
} as const satisfies KeybindingEditsResult;

/**
 * Applies editor changes to the config's rules. A `set` that replaces a rule, or a
 * `remove`, must name a rule that is live (on disk, or shipped for a command with nothing
 * on disk); otherwise the editor acted on an old snapshot and the whole batch is refused.
 *
 * @internal - Exported for testing
 */
export function applyKeybindingEdits(
  rules: readonly KeybindingRule[],
  edits: readonly ServerKeybindingEdit[],
): KeybindingEditsResult {
  let next: KeybindingRule[] = [...rules];
  for (const edit of edits) {
    switch (edit.type) {
      case "set": {
        const { rule, replacing } = edit;
        if (!isValidAssignableKeybindingRule(rule)) {
          return { _tag: "failure", reason: "invalid", detail: KEYBINDING_INVALID_RULE_DETAIL };
        }
        if (replacing && compileResolvedKeybindingRule(replacing) === null) {
          return { _tag: "failure", reason: "invalid", detail: KEYBINDING_INVALID_RULE_DETAIL };
        }
        if (replacing && replacing.command !== rule.command) {
          return {
            _tag: "failure",
            reason: "invalid",
            detail: "a shortcut can only replace one of its own command",
          };
        }
        next = materializeShippedKeybindingRules(next, rule.command);
        if (replacing && !hasResolvedKeybindingRule(next, replacing)) {
          return STALE_KEYBINDING_EDIT;
        }
        next = next.filter(
          (existing) =>
            !(existing.command === rule.command && isUnassignedKeybindingRule(existing)) &&
            !(replacing && isSameResolvedKeybindingRule(existing, replacing)) &&
            !isSameResolvedKeybindingRule(existing, rule),
        );
        next = insertKeybindingRule(next, rule);
        break;
      }
      case "remove": {
        const { rule } = edit;
        if (compileResolvedKeybindingRule(rule) === null) {
          return { _tag: "failure", reason: "invalid", detail: KEYBINDING_INVALID_RULE_DETAIL };
        }
        next = materializeShippedKeybindingRules(next, rule.command);
        if (!hasResolvedKeybindingRule(next, rule)) {
          return STALE_KEYBINDING_EDIT;
        }
        next = next.filter((existing) => !isSameResolvedKeybindingRule(existing, rule));
        // Only shipped commands need the marker: nothing would re-add a binding for a
        // command that has no default.
        if (
          DEFAULT_KEYBINDING_COMMANDS.has(rule.command) &&
          !next.some((existing) => existing.command === rule.command)
        ) {
          next.push({ key: UNASSIGNED_KEYBINDING_KEY, command: rule.command });
        }
        break;
      }
      case "reset": {
        const { command } = edit;
        if (command === undefined) {
          // Project script shortcuts are owned by their project, not by this reset.
          next = [
            ...DEFAULT_KEYBINDINGS.map((rule) => ({ ...rule })),
            ...next.filter((rule) => !BUILT_IN_KEYBINDING_COMMANDS.has(rule.command)),
          ];
          break;
        }
        next = insertShippedKeybindingRules(
          next.filter((rule) => rule.command !== command),
          command,
        );
        break;
      }
    }
  }
  return { _tag: "success", rules: next };
}

/**
 * Result of normalizing the raw on-disk keybindings config into a list of entries.
 *
 * `migratedShape: true` marks tolerated non-canonical top-level shapes (empty file,
 * `null`, `{}`, `{"keybindings": [...]}`, or a single rule object) so callers can
 * rewrite the file into the canonical JSON-array form instead of surfacing an error
 * on every startup.
 */
type RawKeybindingsEntriesResult =
  | {
      readonly _tag: "success";
      readonly entries: ReadonlyArray<unknown>;
      readonly migratedShape: boolean;
    }
  | { readonly _tag: "failure"; readonly detail: string };

function describeJsonValueShape(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function decodeRawKeybindingsEntries(rawConfig: string): RawKeybindingsEntriesResult {
  if (rawConfig.trim().length === 0) {
    return { _tag: "success", entries: [], migratedShape: true };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawConfig);
  } catch (error) {
    return { _tag: "failure", detail: `expected JSON array (${String(error)})` };
  }

  if (Array.isArray(parsed)) {
    return { _tag: "success", entries: parsed, migratedShape: false };
  }
  if (parsed === null) {
    return { _tag: "success", entries: [], migratedShape: true };
  }
  if (typeof parsed === "object") {
    const record = parsed as Record<string, unknown>;
    if (Array.isArray(record.keybindings)) {
      return { _tag: "success", entries: record.keybindings, migratedShape: true };
    }
    if (Object.keys(record).length === 0) {
      return { _tag: "success", entries: [], migratedShape: true };
    }
    if (typeof record.key === "string" && typeof record.command === "string") {
      return { _tag: "success", entries: [record], migratedShape: true };
    }
  }
  return {
    _tag: "failure",
    detail: `expected JSON array, got ${describeJsonValueShape(parsed)}`,
  };
}

// Uncapped on purpose: a config already over MAX_KEYBINDINGS_COUNT from an older release
// must still be writable when an edit shrinks it.
const KeybindingRules = Schema.Array(KeybindingRule);

/** A file entry that did not decode; written back verbatim so a save never destroys it. */
interface InvalidKeybindingEntry {
  /** Position in the file it was read from. */
  readonly index: number;
  readonly entry: unknown;
  readonly detail: string;
}

/** The file's rules after legacy normalization and default-rule migrations. */
interface CustomKeybindingsConfig {
  readonly rules: readonly KeybindingRule[];
  readonly invalidEntries: readonly InvalidKeybindingEntry[];
  readonly migratedLegacyCommandCount: number;
  readonly migratedDefaultRuleCount: number;
  readonly migratedConfigShape: boolean;
}

type CustomKeybindingsConfigResult =
  | ({ readonly _tag: "loaded" } & CustomKeybindingsConfig)
  | { readonly _tag: "malformed"; readonly detail: string };

const EMPTY_CUSTOM_KEYBINDINGS_CONFIG: CustomKeybindingsConfig = {
  rules: [],
  invalidEntries: [],
  migratedLegacyCommandCount: 0,
  migratedDefaultRuleCount: 0,
  migratedConfigShape: false,
};

export interface KeybindingsConfigState {
  readonly keybindings: ResolvedKeybindingsConfig;
  readonly issues: readonly ServerConfigIssue[];
}

export interface KeybindingsChangeEvent {
  readonly keybindings: ResolvedKeybindingsConfig;
  readonly issues: readonly ServerConfigIssue[];
}

function trimIssueMessage(message: string): string {
  const trimmed = message.trim();
  return trimmed.length > 0 ? trimmed : "Invalid keybindings configuration.";
}

function malformedConfigIssue(detail: string): ServerConfigIssue {
  return {
    kind: "keybindings.malformed-config",
    message: trimIssueMessage(detail),
  };
}

function invalidEntryIssue(index: number, detail: string): ServerConfigIssue {
  return {
    kind: "keybindings.invalid-entry",
    index,
    message: trimIssueMessage(detail),
  };
}

const LEGACY_KEYBINDING_COMMAND_ALIASES = {
  "commandPalette.toggle": "sidebar.search",
  "composer.effortPicker.toggle": "traitsPicker.toggle",
  "composer.modelPicker.toggle": "modelPicker.toggle",
  "effortPicker.toggle": "traitsPicker.toggle",
  "reasoningPicker.toggle": "traitsPicker.toggle",
  "thread.previous": "chat.visible.previous",
  "thread.next": "chat.visible.next",
} as const satisfies Record<string, KeybindingRule["command"]>;

// Commands removed without a direct replacement are dropped during startup so
// persisted configs from older releases do not produce validation warnings.
const RETIRED_LEGACY_KEYBINDING_COMMANDS = new Set(["chat.newGemini"]);
const RETIRED_LEGACY_KEYBINDING_COMMAND_PATTERN = /^(?:composer\.)?modelPicker\.jump\.[1-9]$/;
const OUTDATED_RECENT_VIEW_TERMINAL_GUARD = "!terminalFocus";
const OUTDATED_SIDEBAR_SEARCH_SHORTCUT = "mod+k";
const RECENT_VIEW_SHORTCUT_BY_COMMAND: Partial<Record<KeybindingRule["command"], string>> = {
  "view.recent.next": "ctrl+tab",
  "view.recent.previous": "ctrl+shift+tab",
};

// New-surface creation commands shipped guarded by a bare `!terminalFocus`. On macOS
// `mod` is Cmd and xterm never forwards a Cmd-chord to the PTY, so that guard silently
// dropped "new chat/terminal" chords whenever the terminal had focus. The relaxed guard
// adds an `|| isMac` escape hatch (see DEFAULT_KEYBINDINGS) so the chord fires on macOS
// regardless of focus while Linux/Windows keep yielding Ctrl-chords to the shell.
const OUTDATED_CREATION_TERMINAL_GUARD = "!terminalFocus";
const RELAXED_CREATION_TERMINAL_GUARD = "!terminalFocus || isMac";
const OUTDATED_THREAD_JUMP_GUARD = "!terminalFocus && !terminalWorkspaceOpen";
const RELAXED_THREAD_JUMP_GUARD = "(!terminalFocus && !terminalWorkspaceOpen) || isMac";
const OUTDATED_WORKSPACE_TAB_SHORTCUT_BY_COMMAND: Partial<
  Record<KeybindingRule["command"], string>
> = {
  "terminal.workspace.terminal": "mod+1",
  "terminal.workspace.chat": "mod+2",
};
const CREATION_COMMANDS_WITH_TERMINAL_ESCAPE = new Set<KeybindingRule["command"]>([
  "chat.new",
  "chat.newLatestProject",
  "chat.newChat",
  "chat.newLocal",
  "chat.newTerminal",
  "chat.newClaude",
  "chat.newCodex",
  "chat.newCursor",
  "chat.split",
]);

function readKeybindingEntryCommand(entry: unknown): string | null {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    return null;
  }

  const command = (entry as { command?: unknown }).command;
  return typeof command === "string" ? command : null;
}

function isRetiredLegacyKeybindingCommand(command: string): boolean {
  return (
    RETIRED_LEGACY_KEYBINDING_COMMANDS.has(command) ||
    RETIRED_LEGACY_KEYBINDING_COMMAND_PATTERN.test(command)
  );
}

// Cross-device configs can lag behind command renames; normalize known aliases
// before schema validation so stale synced files do not become warning toasts.
function normalizeLegacyKeybindingEntry(entry: unknown): {
  readonly entry: unknown;
  readonly migrated: boolean;
} {
  const command = readKeybindingEntryCommand(entry);
  if (typeof command !== "string" || !(command in LEGACY_KEYBINDING_COMMAND_ALIASES)) {
    return { entry, migrated: false };
  }

  // `readKeybindingEntryCommand` only yields a string command for non-null object
  // entries, so the spread target is guaranteed to be an object here.
  return {
    entry: {
      ...(entry as Record<string, unknown>),
      command:
        LEGACY_KEYBINDING_COMMAND_ALIASES[
          command as keyof typeof LEGACY_KEYBINDING_COMMAND_ALIASES
        ],
    },
    migrated: true,
  };
}

// Update exact earlier shipped defaults while preserving custom keys and conditions.
function migrateOutdatedDefaultKeybindingRule(rule: KeybindingRule): {
  readonly rule: KeybindingRule;
  readonly migrated: boolean;
} {
  // The initial Mac tab defaults collided with space navigation. Rewrite only their
  // exact shipped shape; custom keys and custom guards keep their precedence.
  const tabArrow =
    rule.command === "threadTab.next"
      ? "arrowright"
      : rule.command === "threadTab.previous"
        ? "arrowleft"
        : null;
  if (tabArrow && rule.key === `mod+alt+${tabArrow}` && rule.when === "isMac") {
    return { rule: { ...rule, key: `mod+ctrl+${tabArrow}` }, migrated: true };
  }

  const recentViewShortcut = RECENT_VIEW_SHORTCUT_BY_COMMAND[rule.command];
  if (
    recentViewShortcut === undefined ||
    rule.key !== recentViewShortcut ||
    rule.when !== OUTDATED_RECENT_VIEW_TERMINAL_GUARD
  ) {
    return { rule, migrated: false };
  }

  return {
    rule: {
      key: rule.key,
      command: rule.command,
    },
    migrated: true,
  };
}

// The original sidebar search default used `mod+k`, which resolves to Ctrl+K on
// Windows/Linux but also captures the native kill-to-end-of-line chord on macOS.
// Expand only that exact shipped default so other user-defined search chords remain intact.
function migrateOutdatedSidebarSearchDefault(rules: readonly KeybindingRule[]): {
  readonly rules: KeybindingRule[];
  readonly migratedCount: number;
} {
  let migratedCount = 0;
  const next = rules.flatMap((rule) => {
    if (
      rule.command !== "sidebar.search" ||
      rule.key !== OUTDATED_SIDEBAR_SEARCH_SHORTCUT ||
      rule.when !== undefined
    ) {
      return [rule];
    }

    migratedCount += 1;
    return SIDEBAR_SEARCH_DEFAULT_KEYBINDINGS.map((binding) => ({ ...binding }));
  });
  return { rules: next, migratedCount };
}

// Add the `|| isMac` escape hatch to new-surface creation commands still pinned to the
// bare `!terminalFocus` guard, so existing configs gain the macOS terminal-focus fix the
// shipped defaults already carry. Matched on command + exact old guard (not key) so it
// also reaches a creation command the user rebound to a different chord — the guard, not
// the key, is what was too aggressive. Idempotent: once relaxed the guard no longer
// matches the old one.
function relaxCreationCommandTerminalGuards(rules: readonly KeybindingRule[]): {
  readonly rules: KeybindingRule[];
  readonly migratedCount: number;
} {
  let migratedCount = 0;
  const next = rules.map((rule) => {
    if (
      rule.when !== OUTDATED_CREATION_TERMINAL_GUARD ||
      !CREATION_COMMANDS_WITH_TERMINAL_ESCAPE.has(rule.command)
    ) {
      return rule;
    }
    migratedCount += 1;
    return { ...rule, when: RELAXED_CREATION_TERMINAL_GUARD };
  });
  return { rules: next, migratedCount };
}

// The original full-width workspace reused mod+1/mod+2 for its terminal/chat tabs and
// disabled all numbered thread jumps while the workspace was open. That made Cmd+1…9
// stop being app navigation when a macOS thread opened as a terminal. Move only the exact
// shipped tab defaults to literal Ctrl, and relax only the exact shipped thread-jump guard;
// custom keys and conditions remain untouched.
function migrateNumberedTerminalWorkspaceDefaults(rules: readonly KeybindingRule[]): {
  readonly rules: KeybindingRule[];
  readonly migratedCount: number;
} {
  let migratedCount = 0;
  const next = rules.map((rule) => {
    const outdatedWorkspaceShortcut = OUTDATED_WORKSPACE_TAB_SHORTCUT_BY_COMMAND[rule.command];
    if (
      outdatedWorkspaceShortcut !== undefined &&
      rule.key === outdatedWorkspaceShortcut &&
      rule.when === "terminalWorkspaceOpen"
    ) {
      migratedCount += 1;
      return { ...rule, key: rule.command === "terminal.workspace.terminal" ? "ctrl+1" : "ctrl+2" };
    }

    if (
      /^thread\.jump\.[1-9]$/.test(rule.command) &&
      rule.key === `mod+${rule.command.slice(-1)}` &&
      rule.when === OUTDATED_THREAD_JUMP_GUARD
    ) {
      migratedCount += 1;
      return { ...rule, when: RELAXED_THREAD_JUMP_GUARD };
    }

    return rule;
  });
  return { rules: next, migratedCount };
}

/**
 * Every rewrite of an outdated shipped default, in the order the loader applies them.
 * Writes go through it too, so a rule the editor records in an old default's shape
 * (Cmd+K for sidebar search) is saved, cached, and reloaded the same way.
 */
function migrateOutdatedDefaultKeybindingRules(rules: readonly KeybindingRule[]): {
  readonly rules: readonly KeybindingRule[];
  readonly migratedCount: number;
} {
  let migratedCount = 0;
  const perRule = rules.map((rule) => {
    const migrated = migrateOutdatedDefaultKeybindingRule(rule);
    if (migrated.migrated) migratedCount += 1;
    return migrated.rule;
  });
  const sidebarSearch = migrateOutdatedSidebarSearchDefault(perRule);
  const relaxed = relaxCreationCommandTerminalGuards(sidebarSearch.rules);
  const numberedWorkspace = migrateNumberedTerminalWorkspaceDefaults(relaxed.rules);
  // An expansion can recreate a rule the config already holds; keep its later copy.
  const identities = numberedWorkspace.rules.map(keybindingRuleIdentity);
  return {
    rules: numberedWorkspace.rules.filter((_rule, index) => {
      const identity = identities[index] ?? null;
      return identity === null || !identities.includes(identity, index + 1);
    }),
    migratedCount:
      migratedCount +
      sidebarSearch.migratedCount +
      relaxed.migratedCount +
      numberedWorkspace.migratedCount,
  };
}

function decodeKeybindingEntry(
  entry: unknown,
):
  | { readonly _tag: "rule"; readonly rule: KeybindingRule }
  | { readonly _tag: "invalid"; readonly detail: string } {
  const decodedRule = Schema.decodeUnknownExit(KeybindingRule)(entry);
  if (decodedRule._tag === "Failure") {
    return { _tag: "invalid", detail: Cause.pretty(decodedRule.cause) };
  }
  const resolvedRule = Schema.decodeExit(ResolvedKeybindingFromConfig)(decodedRule.value);
  if (resolvedRule._tag === "Failure") {
    return { _tag: "invalid", detail: Cause.pretty(resolvedRule.cause) };
  }
  return { _tag: "rule", rule: decodedRule.value };
}

function mergeWithDefaultKeybindings(custom: ResolvedKeybindingsConfig): ResolvedKeybindingsConfig {
  if (custom.length === 0) {
    return [...DEFAULT_RESOLVED_KEYBINDINGS];
  }

  // Legacy files may exceed the write cap. Keep their newest user rules without
  // spending that budget on defaults; the resolved contract reserves both spaces.
  const activeCustom = custom.slice(-MAX_KEYBINDINGS_COUNT);
  const overriddenCommands = new Set(activeCustom.map((binding) => binding.command));
  const retainedDefaults = DEFAULT_RESOLVED_KEYBINDINGS.filter(
    (binding) => !overriddenCommands.has(binding.command),
  );
  return [...retainedDefaults, ...activeCustom];
}

function toKeybindingsConfigState(
  config: Pick<CustomKeybindingsConfig, "rules" | "invalidEntries">,
): KeybindingsConfigState {
  return {
    keybindings: mergeWithDefaultKeybindings(compileResolvedKeybindingsConfig(config.rules)),
    issues: config.invalidEntries.map(({ index, detail }) => invalidEntryIssue(index, detail)),
  };
}

/**
 * KeybindingsShape - Service API for keybinding configuration operations.
 */
export interface KeybindingsShape {
  /**
   * Start the keybindings runtime and attach file watching.
   *
   * Safe to call multiple times. The first successful call establishes the
   * runtime; later calls await the same startup.
   */
  readonly start: Effect.Effect<void, KeybindingsConfigError>;

  /**
   * Await keybindings runtime readiness.
   *
   * Readiness means the config directory exists, the watcher is attached, the
   * startup sync has completed, and the current snapshot has been loaded.
   */
  readonly ready: Effect.Effect<void, KeybindingsConfigError>;

  /**
   * Ensure the on-disk keybindings file exists and includes all default
   * commands so newly-added defaults are backfilled on startup.
   */
  readonly syncDefaultKeybindingsOnStartup: Effect.Effect<void, KeybindingsConfigError>;

  /**
   * Load runtime keybindings state along with non-fatal configuration issues.
   */
  readonly loadConfigState: Effect.Effect<KeybindingsConfigState, KeybindingsConfigError>;

  /**
   * Read the latest keybindings snapshot from cache/disk.
   */
  readonly getSnapshot: Effect.Effect<KeybindingsConfigState, KeybindingsConfigError>;

  /**
   * Stream of keybindings config change events.
   */
  readonly streamChanges: Stream.Stream<KeybindingsChangeEvent>;

  /**
   * Upsert a keybinding rule and persist the resulting configuration.
   *
   * When `replacing` is supplied, only that semantic rule is replaced so sibling
   * conditions for the same command remain intact. Without it, the command keeps
   * the existing command-wide replacement behavior.
   *
   * Writes config atomically. Fails with {@link KeybindingsEditRejectedError} for an
   * invalid rule or when the write would take the config past the max rule count.
   */
  readonly upsertKeybindingRule: (
    rule: KeybindingRule,
    replacing?: KeybindingRule,
  ) => Effect.Effect<ResolvedKeybindingsConfig, KeybindingsWriteError>;

  /**
   * Apply shortcut-editor changes in order and persist the result in one write, so a
   * change that moves a shortcut between commands is never observed half done. A batch
   * made against an old snapshot fails with {@link KEYBINDING_EDIT_STALE_DETAIL}.
   */
  readonly editKeybindings: (
    edits: readonly ServerKeybindingEdit[],
  ) => Effect.Effect<ResolvedKeybindingsConfig, KeybindingsWriteError>;
}

/**
 * Keybindings - Service tag for keybinding configuration operations.
 */
export class Keybindings extends ServiceMap.Service<Keybindings, KeybindingsShape>()(
  "synara/keybindings",
) {}

const makeKeybindings = Effect.gen(function* () {
  const { keybindingsConfigPath } = yield* ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const upsertSemaphore = yield* Semaphore.make(1);
  const resolvedConfigCacheKey = "resolved" as const;
  const changesPubSub = yield* PubSub.unbounded<KeybindingsChangeEvent>();
  const startedRef = yield* Ref.make(false);
  const startedDeferred = yield* Deferred.make<void, KeybindingsConfigError>();
  const watcherScope = yield* Scope.make("sequential");
  yield* Effect.addFinalizer(() => Scope.close(watcherScope, Exit.void));
  const emitChange = (configState: KeybindingsConfigState) =>
    PubSub.publish(changesPubSub, configState).pipe(Effect.asVoid);

  const readConfigExists = fs.exists(keybindingsConfigPath).pipe(
    Effect.mapError(
      (cause) =>
        new KeybindingsConfigError({
          configPath: keybindingsConfigPath,
          detail: "failed to access keybindings config",
          cause,
        }),
    ),
  );

  const readRawConfig = fs.readFileString(keybindingsConfigPath).pipe(
    Effect.mapError(
      (cause) =>
        new KeybindingsConfigError({
          configPath: keybindingsConfigPath,
          detail: "failed to read keybindings config",
          cause,
        }),
    ),
  );

  // The one reader for both the runtime snapshot and edits, so an edit always works on the
  // rules the runtime shows.
  const loadCustomKeybindingsConfig = Effect.fn(function* (): Effect.fn.Return<
    CustomKeybindingsConfigResult,
    KeybindingsConfigError
  > {
    if (!(yield* readConfigExists)) {
      return { _tag: "loaded", ...EMPTY_CUSTOM_KEYBINDINGS_CONFIG };
    }

    const rawConfig = yield* readRawConfig;
    const decodedEntries = decodeRawKeybindingsEntries(rawConfig);
    if (decodedEntries._tag === "failure") {
      return { _tag: "malformed", detail: decodedEntries.detail };
    }
    if (decodedEntries.migratedShape) {
      yield* Effect.logWarning("migrating keybindings config with non-array top-level shape", {
        path: keybindingsConfigPath,
      });
    }

    const keybindings: KeybindingRule[] = [];
    const invalidEntries: InvalidKeybindingEntry[] = [];
    let migratedLegacyCommandCount = 0;
    for (const [index, entry] of decodedEntries.entries.entries()) {
      const command = readKeybindingEntryCommand(entry);
      if (command !== null && isRetiredLegacyKeybindingCommand(command)) {
        migratedLegacyCommandCount += 1;
        continue;
      }

      const normalized = normalizeLegacyKeybindingEntry(entry);
      if (normalized.migrated) {
        migratedLegacyCommandCount += 1;
      }
      const decoded = decodeKeybindingEntry(normalized.entry);
      if (decoded._tag === "invalid") {
        invalidEntries.push({ index, entry, detail: decoded.detail });
        yield* Effect.logWarning("ignoring invalid keybinding entry", {
          path: keybindingsConfigPath,
          index,
          entry,
          error: decoded.detail,
        });
        continue;
      }
      keybindings.push(decoded.rule);
    }

    const migrated = migrateOutdatedDefaultKeybindingRules(keybindings);
    return {
      _tag: "loaded",
      rules: migrated.rules,
      invalidEntries,
      migratedLegacyCommandCount,
      migratedDefaultRuleCount: migrated.migratedCount,
      migratedConfigShape: decodedEntries.migratedShape,
    };
  });

  const loadWritableCustomKeybindingsConfig = loadCustomKeybindingsConfig().pipe(
    Effect.flatMap((result) =>
      result._tag === "loaded"
        ? Effect.succeed(result)
        : Effect.fail(
            new KeybindingsConfigError({
              configPath: keybindingsConfigPath,
              detail: result.detail,
            }),
          ),
    ),
  );

  // Entries that did not decode go back verbatim after the rules, so a save keeps them.
  const writeConfigAtomically = (
    rules: readonly KeybindingRule[],
    invalidEntries: readonly InvalidKeybindingEntry[] = [],
  ) => {
    return Schema.encodeEffect(KeybindingRules)(rules).pipe(
      Effect.map(
        (encoded) =>
          `${JSON.stringify([...encoded, ...invalidEntries.map(({ entry }) => entry)], null, 2)}\n`,
      ),
      Effect.flatMap((encoded) =>
        writeFileStringAtomically({ filePath: keybindingsConfigPath, contents: encoded }),
      ),
      Effect.mapError(
        (cause) =>
          new KeybindingsConfigError({
            configPath: keybindingsConfigPath,
            detail: "failed to write keybindings config",
            cause,
          }),
      ),
    );
  };

  const loadConfigStateFromDisk = loadCustomKeybindingsConfig().pipe(
    Effect.map(
      (result): KeybindingsConfigState =>
        result._tag === "loaded"
          ? toKeybindingsConfigState(result)
          : {
              keybindings: [...DEFAULT_RESOLVED_KEYBINDINGS],
              issues: [malformedConfigIssue(result.detail)],
            },
    ),
  );

  const resolvedConfigCache = yield* Cache.make<
    typeof resolvedConfigCacheKey,
    KeybindingsConfigState,
    KeybindingsConfigError
  >({
    capacity: 1,
    lookup: () => loadConfigStateFromDisk,
  });

  const loadConfigStateFromCacheOrDisk = Cache.get(resolvedConfigCache, resolvedConfigCacheKey);

  // Callers hold the upsert permit.
  const reloadAndEmit = Effect.gen(function* () {
    yield* Cache.invalidate(resolvedConfigCache, resolvedConfigCacheKey);
    const configState = yield* loadConfigStateFromCacheOrDisk;
    yield* emitChange(configState);
  });

  const revalidateAndEmit = upsertSemaphore.withPermits(1)(reloadAndEmit);

  const syncDefaultKeybindingsOnStartup = upsertSemaphore.withPermits(1)(
    Effect.gen(function* () {
      const configExists = yield* readConfigExists;
      if (!configExists) {
        yield* writeConfigAtomically(DEFAULT_KEYBINDINGS);
        yield* Cache.invalidate(resolvedConfigCache, resolvedConfigCacheKey);
        return;
      }

      const runtimeConfig = yield* loadCustomKeybindingsConfig();
      if (runtimeConfig._tag === "malformed" || runtimeConfig.invalidEntries.length > 0) {
        yield* Effect.logWarning(
          "skipping startup keybindings default sync because config has issues",
          {
            path: keybindingsConfigPath,
            issues: (runtimeConfig._tag === "malformed"
              ? { keybindings: [], issues: [malformedConfigIssue(runtimeConfig.detail)] }
              : toKeybindingsConfigState(runtimeConfig)
            ).issues,
          },
        );
        yield* Cache.invalidate(resolvedConfigCache, resolvedConfigCacheKey);
        return;
      }
      const customConfig = runtimeConfig.rules;
      const existingCommands = new Set(customConfig.map((entry) => entry.command));
      const missingDefaults: KeybindingRule[] = [];
      const shortcutConflictWarnings: Array<{
        defaultCommand: KeybindingRule["command"];
        conflictingCommand: KeybindingRule["command"];
        key: string;
        when: string | null;
      }> = [];
      for (const defaultRule of DEFAULT_KEYBINDINGS) {
        if (existingCommands.has(defaultRule.command)) {
          continue;
        }
        const conflictingEntry = customConfig.find((entry) =>
          hasSameShortcutContext(entry, defaultRule),
        );
        if (conflictingEntry) {
          shortcutConflictWarnings.push({
            defaultCommand: defaultRule.command,
            conflictingCommand: conflictingEntry.command,
            key: defaultRule.key,
            when: defaultRule.when ?? null,
          });
          continue;
        }
        missingDefaults.push(defaultRule);
      }
      for (const conflict of shortcutConflictWarnings) {
        yield* Effect.logWarning("skipping default keybinding due to shortcut conflict", {
          path: keybindingsConfigPath,
          defaultCommand: conflict.defaultCommand,
          conflictingCommand: conflict.conflictingCommand,
          key: conflict.key,
          when: conflict.when,
          reason: "shortcut context already used by existing rule",
        });
      }
      // A config at the cap goes without the backfill instead of losing its oldest rules.
      // Runtime defaults have a separate budget, so the full user config stays live
      // alongside the missing shipped commands without rewriting the file.
      const backfillExceedsLimit =
        missingDefaults.length > 0 &&
        exceedsKeybindingLimit(customConfig.length, customConfig.length + missingDefaults.length);
      if (backfillExceedsLimit) {
        yield* Effect.logWarning("skipping default keybinding backfill at max entries", {
          path: keybindingsConfigPath,
          maxEntries: MAX_KEYBINDINGS_COUNT,
          commands: missingDefaults.map((rule) => rule.command),
        });
      }
      if (missingDefaults.length === 0 || backfillExceedsLimit) {
        if (
          runtimeConfig.migratedLegacyCommandCount > 0 ||
          runtimeConfig.migratedDefaultRuleCount > 0 ||
          runtimeConfig.migratedConfigShape
        ) {
          yield* writeConfigAtomically(customConfig);
        }
        yield* Cache.invalidate(resolvedConfigCache, resolvedConfigCacheKey);
        return;
      }

      const matchingDefaults = DEFAULT_KEYBINDINGS.filter((defaultRule) =>
        customConfig.some((entry) => isSameKeybindingRule(entry, defaultRule)),
      ).map((rule) => rule.command);
      if (matchingDefaults.length > 0) {
        yield* Effect.logWarning("default keybinding rule already defined in user config", {
          path: keybindingsConfigPath,
          commands: matchingDefaults,
        });
      }

      const migratedKeybindingCount =
        runtimeConfig.migratedLegacyCommandCount + runtimeConfig.migratedDefaultRuleCount;
      if (migratedKeybindingCount > 0) {
        yield* Effect.logInfo("migrated keybinding config entries", {
          path: keybindingsConfigPath,
          count: migratedKeybindingCount,
        });
      }
      yield* writeConfigAtomically([...customConfig, ...missingDefaults]);
      yield* Cache.invalidate(resolvedConfigCache, resolvedConfigCacheKey);
    }),
  );

  const startWatcher = Effect.gen(function* () {
    const keybindingsConfigDir = path.dirname(keybindingsConfigPath);
    const keybindingsConfigFile = path.basename(keybindingsConfigPath);
    const keybindingsConfigPathResolved = path.resolve(keybindingsConfigPath);

    yield* fs.makeDirectory(keybindingsConfigDir, { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new KeybindingsConfigError({
            configPath: keybindingsConfigPath,
            detail: "failed to prepare keybindings config directory",
            cause,
          }),
      ),
    );

    const revalidateAndEmitSafely = revalidateAndEmit.pipe(Effect.ignoreCause({ log: true }));

    yield* Stream.runForEach(fs.watch(keybindingsConfigDir), (event) => {
      const isTargetConfigEvent =
        event.path === keybindingsConfigFile ||
        event.path === keybindingsConfigPath ||
        path.resolve(keybindingsConfigDir, event.path) === keybindingsConfigPathResolved;
      if (!isTargetConfigEvent) {
        return Effect.void;
      }
      return revalidateAndEmitSafely;
    }).pipe(Effect.ignoreCause({ log: true }), Effect.forkIn(watcherScope), Effect.asVoid);
  });

  const start = Effect.gen(function* () {
    const alreadyStarted = yield* Ref.get(startedRef);
    if (alreadyStarted) {
      return yield* Deferred.await(startedDeferred);
    }

    yield* Ref.set(startedRef, true);
    const startup = Effect.gen(function* () {
      yield* startWatcher;
      yield* syncDefaultKeybindingsOnStartup;
      yield* Cache.invalidate(resolvedConfigCache, resolvedConfigCacheKey);
      yield* loadConfigStateFromCacheOrDisk;
    });

    const startupExit = yield* Effect.exit(startup);
    if (startupExit._tag === "Failure") {
      yield* Deferred.failCause(startedDeferred, startupExit.cause).pipe(Effect.orDie);
      return yield* Effect.failCause(startupExit.cause);
    }

    yield* Deferred.succeed(startedDeferred, undefined).pipe(Effect.orDie);
  });

  const validateUpsertRule = (rule: KeybindingRule) =>
    compileResolvedKeybindingRule(rule) === null
      ? Effect.fail(
          new KeybindingsEditRejectedError({
            reason: "invalid",
            detail: KEYBINDING_INVALID_RULE_DETAIL,
          }),
        )
      : Effect.void;

  const keepExistingRuleDuringUpsert = (
    existingRule: KeybindingRule,
    rule: KeybindingRule,
    replacing: KeybindingRule | undefined,
  ) => {
    // A command that gains a binding is no longer unassigned.
    if (existingRule.command === rule.command && isUnassignedKeybindingRule(existingRule)) {
      return false;
    }
    return replacing
      ? !isSameResolvedKeybindingRule(existingRule, replacing)
      : existingRule.command !== rule.command;
  };

  const persistCustomKeybindings = Effect.fn(function* (
    current: CustomKeybindingsConfig,
    editedRules: readonly KeybindingRule[],
  ): Effect.fn.Return<ResolvedKeybindingsConfig, KeybindingsWriteError> {
    const nextRules = migrateOutdatedDefaultKeybindingRules(editedRules).rules;
    if (exceedsKeybindingLimit(current.rules.length, nextRules.length)) {
      return yield* new KeybindingsEditRejectedError({
        reason: "limit",
        detail: KEYBINDING_LIMIT_DETAIL,
      });
    }
    // Preserved entries now sit after the rules.
    const invalidEntries = current.invalidEntries.map((invalid, offset) => ({
      ...invalid,
      index: nextRules.length + offset,
    }));
    yield* writeConfigAtomically(nextRules, invalidEntries);
    const nextState = toKeybindingsConfigState({ rules: nextRules, invalidEntries });
    yield* Cache.set(resolvedConfigCache, resolvedConfigCacheKey, nextState);
    yield* emitChange(nextState);
    return nextState.keybindings;
  });

  return {
    start,
    ready: Deferred.await(startedDeferred),
    syncDefaultKeybindingsOnStartup,
    loadConfigState: loadConfigStateFromCacheOrDisk,
    getSnapshot: loadConfigStateFromCacheOrDisk,
    get streamChanges() {
      return Stream.fromPubSub(changesPubSub);
    },
    upsertKeybindingRule: (rule, replacing) =>
      upsertSemaphore.withPermits(1)(
        Effect.gen(function* () {
          yield* validateUpsertRule(rule);
          if (replacing) yield* validateUpsertRule(replacing);
          const customConfig = yield* loadWritableCustomKeybindingsConfig;
          return yield* persistCustomKeybindings(customConfig, [
            ...customConfig.rules.filter((entry) =>
              keepExistingRuleDuringUpsert(entry, rule, replacing),
            ),
            rule,
          ]);
        }),
      ),
    editKeybindings: (edits) =>
      upsertSemaphore.withPermits(1)(
        Effect.gen(function* () {
          const customConfig = yield* loadWritableCustomKeybindingsConfig;
          const result = applyKeybindingEdits(customConfig.rules, edits);
          if (result._tag === "failure") {
            // A stale edit means the file changed without the watcher noticing (or
            // before it did): publish what is on disk so every client catches up.
            if (result.reason === "stale") {
              yield* reloadAndEmit.pipe(Effect.ignoreCause({ log: true }));
            }
            return yield* new KeybindingsEditRejectedError({
              reason: result.reason,
              detail: result.detail,
            });
          }
          return yield* persistCustomKeybindings(customConfig, result.rules);
        }),
      ),
  } satisfies KeybindingsShape;
});

export const KeybindingsLive = Layer.effect(Keybindings, makeKeybindings);
