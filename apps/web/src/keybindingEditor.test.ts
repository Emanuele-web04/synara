import type {
  KeybindingCommand,
  KeybindingShortcut,
  KeybindingWhenNode,
  ResolvedKeybindingRule,
} from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { fixedShortcutsForPlatform } from "./fixedShortcuts";
import { DEFAULT_SHORTCUT_FALLBACKS, shortcutConflictKey } from "./keybindings";

import {
  buildShortcutEditorRows,
  evaluateRecordedShortcut,
  filterShortcutEditorRows,
  shortcutRemoveEdits,
  shortcutResetEdits,
  shortcutResetTakeovers,
  shortcutSaveEdits,
  whenConditionsCanHoldTogether,
  type ShortcutEditorSource,
} from "./keybindingEditor";

const MAC = "MacIntel";
const LINUX = "Linux x86_64";

function shortcut(key: string, modifiers: Partial<KeybindingShortcut> = {}): KeybindingShortcut {
  return {
    key,
    modKey: false,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...modifiers,
  };
}

const id = (name: string): KeybindingWhenNode => ({ type: "identifier", name });
const not = (node: KeybindingWhenNode): KeybindingWhenNode => ({ type: "not", node });
const and = (left: KeybindingWhenNode, right: KeybindingWhenNode): KeybindingWhenNode => ({
  type: "and",
  left,
  right,
});
const or = (left: KeybindingWhenNode, right: KeybindingWhenNode): KeybindingWhenNode => ({
  type: "or",
  left,
  right,
});

function rule(
  command: KeybindingCommand,
  key: string,
  modifiers: Partial<KeybindingShortcut> = { modKey: true },
  whenAst?: KeybindingWhenNode,
): ResolvedKeybindingRule {
  return { command, shortcut: shortcut(key, modifiers), ...(whenAst ? { whenAst } : {}) };
}

const SHIPPED: ResolvedKeybindingRule[] = [
  rule("terminal.toggle", "j"),
  rule("terminal.split", "d", { modKey: true }, id("terminalFocus")),
  rule("diff.toggle", "d", { modKey: true }, not(id("terminalFocus"))),
  rule("terminal.close", "w", { modKey: true }, id("terminalFocus")),
  rule("terminal.workspace.closeActive", "w", { modKey: true }, id("terminalWorkspaceOpen")),
  rule("chat.new", "n", { modKey: true }, or(not(id("terminalFocus")), id("isMac"))),
  rule(
    "git.commitAndPush",
    "p",
    { metaKey: true, ctrlKey: true },
    and(not(id("terminalFocus")), id("isMac")),
  ),
  rule(
    "git.commitAndPush",
    "p",
    { ctrlKey: true, altKey: true },
    and(not(id("terminalFocus")), not(id("isMac"))),
  ),
  ...Array.from({ length: 9 }, (_, index) =>
    rule(
      `thread.jump.${index + 1}` as KeybindingCommand,
      String(index + 1),
      { modKey: true },
      id("isMac"),
    ),
  ),
];

function sourceWith(
  keybindings: ResolvedKeybindingRule[] = SHIPPED,
  platform = MAC,
): ShortcutEditorSource {
  return { keybindings, defaultKeybindings: SHIPPED, platform };
}

function rowFor(source: ShortcutEditorSource, rowId: string) {
  const row = buildShortcutEditorRows(source).find((candidate) => candidate.id === rowId);
  if (!row) throw new Error(`no row ${rowId}`);
  return row;
}

function record(
  source: ShortcutEditorSource,
  rowId: string,
  recorded: KeybindingShortcut,
  bindingIndex: number | null = 0,
) {
  const row = rowFor(source, rowId);
  const replacing = bindingIndex === null ? null : (row.bindings[bindingIndex] ?? null);
  return {
    replacing,
    recording: evaluateRecordedShortcut({ source, row, replacing, shortcut: recorded }),
  };
}

describe("whenConditionsCanHoldTogether", () => {
  it("separates conditions that never meet from ones that can", () => {
    expect(whenConditionsCanHoldTogether([id("terminalFocus"), not(id("terminalFocus"))], {})).toBe(
      false,
    );
    expect(
      whenConditionsCanHoldTogether([id("terminalFocus"), id("terminalWorkspaceOpen")], {}),
    ).toBe(true);
    expect(whenConditionsCanHoldTogether([undefined, not(id("terminalFocus"))], {})).toBe(true);
  });

  it("never has two surfaces focused at once", () => {
    expect(whenConditionsCanHoldTogether([id("composerFocus"), id("terminalFocus")], {})).toBe(
      false,
    );
    expect(whenConditionsCanHoldTogether([id("composerFocus"), not(id("terminalFocus"))], {})).toBe(
      true,
    );
  });

  it("treats the platform as fixed", () => {
    const macOnly = and(not(id("terminalFocus")), id("isMac"));

    expect(whenConditionsCanHoldTogether([macOnly], { isMac: true })).toBe(true);
    expect(whenConditionsCanHoldTogether([macOnly], { isMac: false })).toBe(false);
  });
});

describe("buildShortcutEditorRows", () => {
  it("lists a command with no binding as an empty row instead of dropping it", () => {
    const source = sourceWith([
      ...SHIPPED.filter((entry) => entry.command !== "terminal.toggle"),
      rule("terminal.toggle", "unassigned", {}),
    ]);

    const row = rowFor(source, "terminal.toggle");

    expect(row.bindings).toEqual([]);
    expect(row.isDefault).toBe(false);
  });

  it("shows only the bindings that can fire on this platform", () => {
    expect(
      rowFor(sourceWith(SHIPPED, MAC), "git.commitAndPush").bindings.map((b) => b.label),
    ).toEqual(["⌃⌘P"]);
    expect(
      rowFor(sourceWith(SHIPPED, LINUX), "git.commitAndPush").bindings.map((b) => b.label),
    ).toEqual(["Ctrl+Alt+P"]);
  });

  it("keeps every binding of a command, in precedence order", () => {
    const source = sourceWith([...SHIPPED, rule("terminal.toggle", "`", { ctrlKey: true })]);

    const row = rowFor(source, "terminal.toggle");

    expect(row.bindings.map((binding) => binding.label)).toEqual(["⌘J", "⌃`"]);
    expect(row.isDefault).toBe(false);
  });

  it("collapses a numbered family into one row while its members still line up", () => {
    const row = rowFor(sourceWith(), "thread.jump");

    expect(row.numbered).toBe(true);
    expect(row.bindings.map((binding) => binding.label)).toEqual(["⌘1–9"]);
    expect(row.bindings[0]?.rules).toHaveLength(9);
    expect(row.isDefault).toBe(true);
  });

  it("lists a numbered family member by member once one was rebound on its own", () => {
    const source = sourceWith(
      SHIPPED.map((entry) =>
        entry.command === "thread.jump.3" ? rule("thread.jump.3", "e", { modKey: true }) : entry,
      ),
    );

    const rows = buildShortcutEditorRows(source);

    expect(rows.some((row) => row.id === "thread.jump")).toBe(false);
    expect(rows.find((row) => row.id === "thread.jump.3")?.bindings.map((b) => b.label)).toEqual([
      "⌘E",
    ]);
    expect(rows.find((row) => row.id === "thread.jump.1")?.isDefault).toBe(true);
  });

  it("finds rows by name, description, or shortcut", () => {
    const rows = buildShortcutEditorRows(sourceWith());

    expect(filterShortcutEditorRows(rows, "toggle terminal").map((row) => row.id)).toEqual([
      "terminal.toggle",
    ]);
    expect(filterShortcutEditorRows(rows, "⌘J").map((row) => row.id)).toEqual(["terminal.toggle"]);
    expect(filterShortcutEditorRows(rows, "  ")).toHaveLength(rows.length);
  });
});

describe("evaluateRecordedShortcut", () => {
  it("asks for a real modifier unless the key is an F-key", () => {
    const source = sourceWith();

    expect(record(source, "terminal.toggle", shortcut("k")).recording).toEqual({
      status: "problem",
      message: "Add ⌘, ⌥ or ⌃ to that key, or use an F-key on its own.",
    });
    expect(
      record(source, "terminal.toggle", shortcut("k", { shiftKey: true })).recording.status,
    ).toBe("problem");
    expect(record(source, "terminal.toggle", shortcut("f5")).recording.status).toBe("ready");
  });

  it("refuses chords that belong to text editing or the system", () => {
    const source = sourceWith();

    expect(record(source, "terminal.toggle", shortcut("c", { modKey: true })).recording).toEqual({
      status: "problem",
      message: "⌘C is reserved for Copy. Try another.",
    });
    // The same letters stay free with another modifier added.
    expect(
      record(source, "terminal.toggle", shortcut("c", { modKey: true, shiftKey: true })).recording
        .status,
    ).toBe("ready");
  });

  it("refuses the chords Synara handles before any binding", () => {
    const source = sourceWith();

    expect(record(source, "terminal.toggle", shortcut("p", { modKey: true })).recording).toEqual({
      status: "problem",
      message: "⌘P always opens file search. Try another.",
    });
    expect(record(source, "terminal.toggle", shortcut("[", { modKey: true })).recording).toEqual({
      status: "problem",
      message: "⌘[ always goes back in the desktop app. Try another.",
    });
    const linux = sourceWith(SHIPPED, LINUX);
    expect(
      record(linux, "terminal.toggle", shortcut("arrowleft", { altKey: true })).recording.status,
    ).toBe("problem");
  });

  it("refuses the terminal's search chord only where the terminal can have focus", () => {
    const anywhere = sourceWith();
    expect(record(anywhere, "terminal.toggle", shortcut("f", { modKey: true })).recording).toEqual({
      status: "problem",
      message: "⌘F searches the terminal while it has focus. Try another.",
    });

    const outsideTerminal = rule("chat.new", "n", { modKey: true }, not(id("terminalFocus")));
    const source = { ...sourceWith([outsideTerminal]), defaultKeybindings: [outsideTerminal] };
    expect(record(source, "chat.new", shortcut("f", { modKey: true })).recording.status).toBe(
      "ready",
    );
  });

  it("ships no default on a fixed chord", () => {
    for (const platform of [MAC, LINUX]) {
      const facts = { isMac: platform === MAC };
      const taken = DEFAULT_SHORTCUT_FALLBACKS.filter((binding) =>
        fixedShortcutsForPlatform(platform).some(
          (entry) =>
            shortcutConflictKey(entry.shortcut, platform) ===
              shortcutConflictKey(binding.shortcut, platform) &&
            whenConditionsCanHoldTogether([entry.whenAst, binding.whenAst], facts),
        ),
      );
      expect(taken.map((binding) => binding.command)).toEqual([]);
    }
  });

  it("does not take a key from a command whose surface cannot have focus at the same time", () => {
    const effort = rule("model.effort.next", "e", { modKey: true }, id("composerFocus"));
    const source = {
      ...sourceWith([...SHIPPED, effort]),
      defaultKeybindings: [...SHIPPED, effort],
    };
    const { recording } = record(source, "model.effort.next", shortcut("d", { modKey: true }));

    expect(recording.status).toBe("ready");
    if (recording.status !== "ready") return;
    // Toggle diff (outside the terminal) can still fire from the composer; Split terminal
    // (inside it) never can.
    expect(recording.conflicts.map((conflict) => conflict.rule.command)).toEqual(["diff.toggle"]);
  });

  it("has nothing to save while the recorded keys are the current ones", () => {
    expect(
      record(sourceWith(), "terminal.toggle", shortcut("j", { modKey: true })).recording,
    ).toEqual({ status: "idle" });
  });

  it("does not flag an unchanged shipped modifierless shortcut as invalid", () => {
    const effort = rule("model.effort.next", "tab", { shiftKey: true }, id("composerFocus"));
    const source = { ...sourceWith([effort]), defaultKeybindings: [effort] };

    expect(record(source, "model.effort.next", effort.shortcut).recording).toEqual({
      status: "idle",
    });
  });

  it("takes a shortcut from the command that holds it in an overlapping context", () => {
    const source = sourceWith();
    const { recording, replacing } = record(
      source,
      "terminal.toggle",
      shortcut("n", { modKey: true }),
    );

    expect(recording.status).toBe("ready");
    if (recording.status !== "ready") return;
    expect(recording.conflicts.map((conflict) => conflict.label)).toEqual(["New thread"]);
    expect(shortcutSaveEdits(recording, replacing)).toEqual([
      {
        type: "remove",
        rule: { command: "chat.new", key: "mod+n", when: "!terminalFocus || isMac" },
      },
      {
        type: "set",
        rule: { command: "terminal.toggle", key: "mod+n" },
        replacing: { command: "terminal.toggle", key: "mod+j" },
      },
    ]);
  });

  it("lets two commands share a key when their conditions never meet", () => {
    const source = sourceWith(SHIPPED.filter((entry) => entry.command !== "diff.toggle"));
    const row = rowFor(source, "diff.toggle");

    // diff.toggle ships as "not while a terminal is focused"; terminal.split owns Mod+D
    // only while one is.
    const recording = evaluateRecordedShortcut({
      source,
      row,
      replacing: null,
      shortcut: shortcut("d", { modKey: true }),
    });

    expect(recording).toMatchObject({ status: "ready", conflicts: [] });
  });

  it("does not count two shipped bindings that share a key on purpose", () => {
    const source = sourceWith(
      SHIPPED.map((entry) =>
        entry.command === "terminal.close"
          ? rule("terminal.close", "w", { modKey: true, altKey: true }, id("terminalFocus"))
          : entry,
      ),
    );

    const { recording } = record(source, "terminal.close", shortcut("w", { modKey: true }));

    expect(recording).toMatchObject({ status: "ready", conflicts: [] });
  });

  it("reports a key the command already has instead of saving a duplicate", () => {
    const source = sourceWith([...SHIPPED, rule("terminal.toggle", "`", { ctrlKey: true })]);

    expect(record(source, "terminal.toggle", shortcut("j", { modKey: true }), 1).recording).toEqual(
      { status: "problem", message: "⌘J is already a shortcut for this command." },
    );
  });

  it("leaves a project script's shortcut to its project", () => {
    const source = sourceWith([
      ...SHIPPED,
      rule("script.lint.run", "l", { modKey: true, altKey: true }),
    ]);

    const { recording } = record(
      source,
      "terminal.toggle",
      shortcut("l", { modKey: true, altKey: true }),
    );

    expect(recording.status).toBe("problem");
  });

  it("gives a new binding the condition its command ships with", () => {
    const source = sourceWith([
      ...SHIPPED.filter((entry) => entry.command !== "chat.new"),
      rule("chat.new", "unassigned", {}),
    ]);

    const { recording, replacing } = record(
      source,
      "chat.new",
      shortcut("k", { modKey: true, shiftKey: true }),
      null,
    );

    expect(recording.status).toBe("ready");
    if (recording.status !== "ready") return;
    expect(shortcutSaveEdits(recording, replacing)).toEqual([
      {
        type: "set",
        rule: { command: "chat.new", key: "mod+shift+k", when: "!terminalFocus || isMac" },
      },
    ]);
  });

  it("rebinds a numbered family as one modifier combination across 1–9", () => {
    const source = sourceWith();

    expect(record(source, "thread.jump", shortcut("k", { ctrlKey: true })).recording).toEqual({
      status: "problem",
      message: "Hold the modifiers and press a number key.",
    });

    const { recording, replacing } = record(
      source,
      "thread.jump",
      shortcut("4", { ctrlKey: true }),
    );
    expect(recording.status).toBe("ready");
    if (recording.status !== "ready") return;
    const edits = shortcutSaveEdits(recording, replacing);
    expect(edits).toHaveLength(9);
    expect(edits[0]).toEqual({
      type: "set",
      rule: { command: "thread.jump.1", key: "ctrl+1", when: "isMac" },
      replacing: { command: "thread.jump.1", key: "mod+1", when: "isMac" },
    });
    expect(edits[8]).toMatchObject({ rule: { command: "thread.jump.9", key: "ctrl+9" } });
  });
});

describe("shortcut edits", () => {
  it("writes a condition that parses back to the same grouping", () => {
    const nested = and(or(id("a"), id("b")), not(and(id("c"), and(id("d"), id("e")))));
    const source = sourceWith([rule("terminal.toggle", "j", { modKey: true }, nested)]);
    const binding = rowFor(source, "terminal.toggle").bindings[0];

    expect(binding && shortcutRemoveEdits(binding)).toEqual([
      {
        type: "remove",
        rule: { command: "terminal.toggle", key: "mod+j", when: "(a || b) && !(c && (d && e))" },
      },
    ]);
  });

  it("removes every member of a numbered family together", () => {
    const binding = rowFor(sourceWith(), "thread.jump").bindings[0];

    expect(binding && shortcutRemoveEdits(binding)).toHaveLength(9);
  });

  it("takes a shipped key back from the command that picked it up when resetting", () => {
    const source = sourceWith([
      ...SHIPPED.filter(
        (entry) => entry.command !== "terminal.toggle" && entry.command !== "diff.toggle",
      ),
      rule("terminal.toggle", "unassigned", {}),
      rule("diff.toggle", "j", { modKey: true }, not(id("terminalFocus"))),
    ]);

    const row = rowFor(source, "terminal.toggle");

    expect(shortcutResetTakeovers(source, row).map((takeover) => takeover.label)).toEqual([
      "Toggle diff",
    ]);
    expect(shortcutResetEdits(source, row)).toEqual([
      { type: "remove", rule: { command: "diff.toggle", key: "mod+j", when: "!terminalFocus" } },
      { type: "reset", command: "terminal.toggle" },
    ]);
  });

  it("takes nothing back when the shipped keys are free", () => {
    const source = sourceWith([
      ...SHIPPED.filter((entry) => entry.command !== "terminal.toggle"),
      rule("terminal.toggle", "k", { modKey: true }),
    ]);

    expect(shortcutResetTakeovers(source, rowFor(source, "terminal.toggle"))).toEqual([]);
  });
});
